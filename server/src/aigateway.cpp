/*
  OrchidLights
  aigateway.cpp

  Copyright (c) 2026 Alex Alvarez

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0.txt

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHttpServerRequest>
#include <QHttpServerResponder>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPointer>
#include <QTcpSocket>
#include <QUrl>
#include <cmath>
#include <memory>

#include "aigateway.h"
#include "qlcconfig.h"

using StatusCode = QHttpServerResponder::StatusCode;

namespace
{
    const QString ANTHROPIC_URL = QStringLiteral("https://api.anthropic.com");
    const QString OPENAI_URL = QStringLiteral("https://api.openai.com/v1");

    /* The most capable current Opus. Settings changes it; the desk pins it. */
    const QString ANTHROPIC_MODEL = QStringLiteral("claude-opus-5-5");

    /* Only for the requests the desk makes itself (the model list). The proxy
       passes on whatever version the client's SDK asks for. */
    const QByteArray ANTHROPIC_VERSION = QByteArrayLiteral("2023-06-01");

    /* Silence, not duration: a long turn streams for minutes, and only a
       provider that stops talking for this long is given up on. */
    constexpr int SILENCE_MS = 120000;
    constexpr int CHECK_MS = 15000;

    /* A whole JSON answer is kept to read its usage at the end. Past this it
       is long enough that the count is not worth the memory. */
    constexpr qsizetype KEEP_JSON = 8 * 1024 * 1024;

    /** The client's headers worth passing on. Everything else stays behind --
     *  above all its Authorization, which is this desk's key, and its
     *  x-api-key, which is a placeholder. */
    const QList<QByteArray> PASSED_ON = {
        QByteArrayLiteral("accept"),
        QByteArrayLiteral("anthropic-version"),
        QByteArrayLiteral("anthropic-beta"),
    };

    /** And the provider's: what a client needs to read the answer and to back
     *  off when asked to. */
    const QList<QByteArray> PASSED_BACK = {
        QByteArrayLiteral("content-type"),
        QByteArrayLiteral("retry-after"),
        QByteArrayLiteral("request-id"),
        QByteArrayLiteral("x-request-id"),
    };

    bool alive(const QPointer<QTcpSocket> &socket)
    {
        return socket && socket->state() == QAbstractSocket::ConnectedState;
    }

    /** An error in the provider's own shape, so its SDK raises a typed error
     *  with a readable message instead of failing to parse ours. */
    QByteArray providerError(AiGateway::Provider provider, const QString &type,
                             const QString &message)
    {
        QJsonObject error;
        error["type"] = type;
        error["message"] = message;

        QJsonObject body;
        if (provider == AiGateway::Provider::Anthropic)
            body["type"] = QStringLiteral("error");
        body["error"] = error;
        return QJsonDocument(body).toJson(QJsonDocument::Compact);
    }

    QString defaultUrl(AiGateway::Provider provider)
    {
        return provider == AiGateway::Provider::Anthropic ? ANTHROPIC_URL : OPENAI_URL;
    }

    /** Enough of a key to tell two apart, never enough to use one. A short key
     *  shows nothing: four characters of eight is half of it. */
    QString keyHint(const QByteArray &key)
    {
        if (key.size() < 16)
            return QString();
        return QStringLiteral("…") + QString::fromUtf8(key.right(4));
    }

    void authenticate(QNetworkRequest &request, AiGateway::Provider provider,
                      const QByteArray &key)
    {
        if (provider == AiGateway::Provider::Anthropic)
            request.setRawHeader(QByteArrayLiteral("x-api-key"), key);
        else if (key.isEmpty() == false)  // a local model wants none
            request.setRawHeader(QByteArrayLiteral("Authorization"), "Bearer " + key);
    }
}

AiGateway::AiGateway(QObject *parent)
    : QObject(parent)
{
    m_path = QDir::homePath() + QChar('/') + QStringLiteral(USERQLCPLUSDIR)
             + QStringLiteral("/ai.json");

    m_anthropic.baseUrl = ANTHROPIC_URL;
    m_anthropic.model = ANTHROPIC_MODEL;
    m_openai.baseUrl = OPENAI_URL;
}

bool AiGateway::load(QString &errorMessage)
{
    QFile file(m_path);
    if (file.exists() == false)
        return true;

    if (file.open(QIODevice::ReadOnly) == false)
    {
        errorMessage = QStringLiteral("Cannot read %1; the assistant starts unconfigured")
                           .arg(m_path);
        return false;
    }

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || document.isObject() == false)
    {
        errorMessage = QStringLiteral("%1 is not a JSON object; the assistant starts "
                                      "unconfigured").arg(m_path);
        return false;
    }

    const QJsonObject root = document.object();

    Provider active = m_active;
    if (providerFromName(root.value("provider").toString(), active))
        m_active = active;

    if (root.value("dailyRequests").isDouble())
        m_dailyRequests = qMax(0, root.value("dailyRequests").toInt());

    const QJsonObject providers = root.value("providers").toObject();
    for (Provider which : { Provider::Anthropic, Provider::OpenAi })
    {
        const QJsonObject fields = providers.value(providerName(which)).toObject();
        Endpoint &target = endpoint(which);

        if (fields.contains("model"))
            target.model = fields.value("model").toString();
        if (fields.value("baseUrl").toString().isEmpty() == false)
            target.baseUrl = fields.value("baseUrl").toString();
        target.key = fields.value("key").toString().toUtf8();
    }

    return true;
}

QJsonObject AiGateway::settingsJson() const
{
    QJsonObject providers;
    for (Provider which : { Provider::Anthropic, Provider::OpenAi })
    {
        const Endpoint &target = endpoint(which);

        QJsonObject fields;
        fields["model"] = target.model;
        fields["baseUrl"] = target.baseUrl;
        fields["configured"] = target.key.isEmpty() == false;
        fields["keyHint"] = keyHint(target.key);
        providers[providerName(which)] = fields;
    }

    /* Yesterday's numbers are not today's: read as zero until the first
       request of the day rolls them over. */
    const bool today = m_day == QDate::currentDate();

    QJsonObject usage;
    usage["day"] = QDate::currentDate().toString(Qt::ISODate);
    usage["requests"] = today ? m_requests : 0;
    usage["inputTokens"] = today ? m_inputTokens : 0;
    usage["outputTokens"] = today ? m_outputTokens : 0;

    QJsonObject body;
    body["provider"] = providerName(m_active);
    body["dailyRequests"] = m_dailyRequests;
    body["providers"] = providers;
    body["usage"] = usage;
    return body;
}

bool AiGateway::update(const QJsonObject &body, QString &errorMessage)
{
    /* Everything is checked before anything changes: a half-applied PUT would
       leave a key saved against the wrong provider. */
    Provider active = m_active;
    if (body.contains("provider")
        && providerFromName(body.value("provider").toString(), active) == false)
    {
        errorMessage = QStringLiteral("\"provider\" is anthropic or openai");
        return false;
    }

    int daily = m_dailyRequests;
    if (body.contains("dailyRequests"))
    {
        const QJsonValue value = body.value("dailyRequests");
        const double number = value.toDouble(-1);
        if (value.isDouble() == false || number < 0 || number != std::floor(number))
        {
            errorMessage = QStringLiteral("\"dailyRequests\" is a whole number, 0 for no cap");
            return false;
        }
        daily = int(number);
    }

    if (body.contains("providers") && body.value("providers").isObject() == false)
    {
        errorMessage = QStringLiteral("\"providers\" is an object keyed by provider");
        return false;
    }

    Endpoint anthropic = m_anthropic;
    Endpoint openai = m_openai;

    const QJsonObject providers = body.value("providers").toObject();
    for (auto it = providers.begin(); it != providers.end(); ++it)
    {
        Provider which;
        if (providerFromName(it.key(), which) == false)
        {
            errorMessage = QStringLiteral("Unknown provider \"%1\"").arg(it.key());
            return false;
        }
        if (it.value().isObject() == false)
        {
            errorMessage = QStringLiteral("\"%1\" is an object").arg(it.key());
            return false;
        }

        const QJsonObject fields = it.value().toObject();
        Endpoint &target = which == Provider::Anthropic ? anthropic : openai;

        if (fields.contains("model"))
            target.model = fields.value("model").toString().trimmed();

        if (fields.contains("baseUrl"))
        {
            QString url = fields.value("baseUrl").toString().trimmed();
            while (url.endsWith(QChar('/')))
                url.chop(1);
            if (url.isEmpty())
                url = defaultUrl(which);

            const QUrl parsed(url);
            if (parsed.isValid() == false || parsed.host().isEmpty()
                || (parsed.scheme() != QStringLiteral("https")
                    && parsed.scheme() != QStringLiteral("http")))
            {
                errorMessage = QStringLiteral("\"baseUrl\" of %1 is an http or https URL")
                                   .arg(it.key());
                return false;
            }
            target.baseUrl = url;
        }

        /* Absent keeps it -- what GET gave back has no key in it. Empty
           removes it. */
        if (fields.contains("key"))
            target.key = fields.value("key").toString().trimmed().toUtf8();
    }

    const Provider oldActive = m_active;
    const int oldDaily = m_dailyRequests;
    const Endpoint oldAnthropic = m_anthropic;
    const Endpoint oldOpenai = m_openai;

    m_active = active;
    m_dailyRequests = daily;
    m_anthropic = anthropic;
    m_openai = openai;

    if (save(errorMessage) == false)
    {
        /* Not kept in memory either: settings that answer GET but are gone
           after a restart are settings that lie. */
        m_active = oldActive;
        m_dailyRequests = oldDaily;
        m_anthropic = oldAnthropic;
        m_openai = oldOpenai;
        return false;
    }

    return true;
}

void AiGateway::forward(Provider provider, const QHttpServerRequest &request,
                        QHttpServerResponder &&responder, QTcpSocket *client,
                        const QString &who)
{
    const QPointer<QTcpSocket> socket(client);
    const Endpoint &target = endpoint(provider);

    rollDay();

    const auto refuse = [&](StatusCode code, const QString &type, const QString &message) {
        responder.write(providerError(provider, type, message),
                        QByteArrayLiteral("application/json"), code);
    };

    if (who.isEmpty() == false && m_dailyRequests > 0
        && m_byCaller.value(who) >= m_dailyRequests)
    {
        /* 403 and not 429: an SDK retries a 429 by itself, and this one does
           not lift until tomorrow. */
        refuse(StatusCode::Forbidden, QStringLiteral("permission_error"),
               QStringLiteral("This device has used today's %1 assistant requests. The desk "
                              "itself is not capped; the limit is in Settings.")
                   .arg(m_dailyRequests));
        return;
    }

    if (provider == Provider::Anthropic && target.key.isEmpty())
    {
        refuse(StatusCode::Unauthorized, QStringLiteral("authentication_error"),
               QStringLiteral("This desk has no Anthropic key; set one in Settings."));
        return;
    }

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(request.body(), &parseError);
    if (parseError.error != QJsonParseError::NoError || document.isObject() == false)
    {
        refuse(StatusCode::BadRequest, QStringLiteral("invalid_request_error"),
               QStringLiteral("The body is not a JSON object."));
        return;
    }

    /* The model is the desk's choice, not the device's: an operator's phone
       does not get to pick the expensive one on the owner's account. */
    QJsonObject body = document.object();
    if (target.model.isEmpty() == false)
        body["model"] = target.model;

    const QString path = provider == Provider::Anthropic ? QStringLiteral("/v1/messages")
                                                         : QStringLiteral("/chat/completions");
    QNetworkRequest out{QUrl(target.baseUrl + path)};
    out.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
    out.setTransferTimeout(SILENCE_MS);
    for (const QByteArray &name : PASSED_ON)
    {
        const QByteArray value = request.value(name);
        if (value.isEmpty() == false)
            out.setRawHeader(name, value);
    }
    if (provider == Provider::Anthropic && out.hasRawHeader("anthropic-version") == false)
        out.setRawHeader(QByteArrayLiteral("anthropic-version"), ANTHROPIC_VERSION);
    authenticate(out, provider, target.key);

    m_requests++;
    if (who.isEmpty() == false)
        m_byCaller[who]++;

    QNetworkReply *reply = m_network.post(out, QJsonDocument(body).toJson(QJsonDocument::Compact));

    /* The responder outlives this call: it moves into the reply's handlers and
       writes as the provider talks. Shared, because Qt copies the functors it
       connects. */
    const auto held = std::make_shared<QHttpServerResponder>(std::move(responder));

    struct Turn
    {
        bool started = false;
        bool stream = false;
        QByteArray carry;  //!< a stream line not finished yet
        QByteArray kept;   //!< what the usage is read from at the end
    };
    const auto turn = std::make_shared<Turn>();

    /* Status and headers as soon as the provider sends them, and the blank
       line after them at once: a client waiting on headers is a client that
       cannot show the turn has started. Chunked, because the length of a
       stream is not known until it ends. */
    const auto begin = [reply, held, turn, socket]() {
        if (turn->started)
            return;
        turn->started = true;
        turn->stream = reply->header(QNetworkRequest::ContentTypeHeader)
                           .toString()
                           .startsWith(QStringLiteral("text/event-stream"));
        if (alive(socket) == false)
            return;

        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        held->writeStatusLine(StatusCode(status));
        for (const QByteArray &name : PASSED_BACK)
        {
            if (reply->hasRawHeader(name))
                held->writeHeader(name, reply->rawHeader(name));
        }
        held->writeHeader(QByteArrayLiteral("Cache-Control"), QByteArrayLiteral("no-cache"));
        held->writeHeader(QByteArrayLiteral("Transfer-Encoding"), QByteArrayLiteral("chunked"));
        held->writeBody(QByteArray());
    };

    const auto pass = [held, turn, socket](const QByteArray &data) {
        if (data.isEmpty())
            return;

        /* Only the lines that carry usage are kept from a stream: the rest is
           the answer itself, which is the client's and already on its way. */
        if (turn->stream)
        {
            turn->carry += data;
            qsizetype end;
            while ((end = turn->carry.indexOf('\n')) >= 0)
            {
                const QByteArray line = turn->carry.left(end);
                turn->carry.remove(0, end + 1);
                if (line.contains("\"usage\""))
                    turn->kept += line + '\n';
            }
        }
        else if (turn->kept.size() < KEEP_JSON)
        {
            turn->kept += data;
        }

        if (alive(socket))
            held->writeBody(QByteArray::number(data.size(), 16) + "\r\n" + data + "\r\n");
    };

    connect(reply, &QNetworkReply::metaDataChanged, reply, begin);
    connect(reply, &QNetworkReply::readyRead, reply, [reply, begin, pass]() {
        begin();
        pass(reply->readAll());
    });
    connect(reply, &QNetworkReply::finished, this,
            [this, provider, reply, held, turn, socket, begin, pass]() {
        reply->deleteLater();

        const bool canceled = reply->error() == QNetworkReply::OperationCanceledError;
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();

        if (status == 0)
        {
            /* Nothing came back at all: no route, no TLS, no answer. Said in
               the provider's words, as a 502 its SDK may retry. */
            if (canceled == false && alive(socket))
            {
                held->write(providerError(provider, QStringLiteral("api_error"),
                                          QStringLiteral("The desk could not reach the "
                                                         "provider: %1")
                                              .arg(reply->errorString())),
                            QByteArrayLiteral("application/json"), StatusCode::BadGateway);
            }
            return;
        }

        begin();
        if (canceled == false)
            pass(reply->readAll());
        if (turn->stream && turn->carry.contains("\"usage\""))
            turn->kept += turn->carry;

        meter(turn->kept, turn->stream);

        if (alive(socket))
            held->writeBody(QByteArrayLiteral("0\r\n\r\n"));
    });

    /* The browser went away: stop the provider too, rather than pay for the
       rest of an answer nobody will read. */
    if (socket)
    {
        connect(socket, &QTcpSocket::disconnected, reply, [reply]() {
            if (reply->isRunning())
                reply->abort();
        });
    }
}

void AiGateway::check(Provider provider, QHttpServerResponder &&responder, QTcpSocket *client)
{
    const QPointer<QTcpSocket> socket(client);
    const Endpoint &target = endpoint(provider);

    QJsonObject result;
    result["provider"] = providerName(provider);

    if (provider == Provider::Anthropic && target.key.isEmpty())
    {
        result["ok"] = false;
        result["status"] = 0;
        result["error"] = QStringLiteral("No key is configured.");
        responder.write(QJsonDocument(result).toJson(QJsonDocument::Compact),
                        QByteArrayLiteral("application/json"));
        return;
    }

    const QString path = provider == Provider::Anthropic ? QStringLiteral("/v1/models?limit=1000")
                                                         : QStringLiteral("/models");
    QNetworkRequest out{QUrl(target.baseUrl + path)};
    out.setTransferTimeout(CHECK_MS);
    if (provider == Provider::Anthropic)
        out.setRawHeader(QByteArrayLiteral("anthropic-version"), ANTHROPIC_VERSION);
    authenticate(out, provider, target.key);

    QNetworkReply *reply = m_network.get(out);
    const auto held = std::make_shared<QHttpServerResponder>(std::move(responder));

    connect(reply, &QNetworkReply::finished, this, [reply, held, socket, result]() mutable {
        reply->deleteLater();

        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const QJsonObject body = QJsonDocument::fromJson(reply->readAll()).object();
        result["status"] = status;

        if (status >= 200 && status < 300)
        {
            QJsonArray models;
            for (const QJsonValue &entry : body.value("data").toArray())
            {
                const QString id = entry.toObject().value("id").toString();
                if (id.isEmpty() == false)
                    models.append(id);
            }
            result["ok"] = true;
            result["models"] = models;
        }
        else
        {
            /* The provider's own words when it has some -- "invalid x-api-key"
               says more than any status code. */
            QString message = body.value("error").toObject().value("message").toString();
            if (message.isEmpty())
                message = reply->errorString();
            result["ok"] = false;
            result["error"] = message;
        }

        /* Compact, like every other answer of the API: the responder's
           QJsonDocument overload indents. */
        if (alive(socket))
            held->write(QJsonDocument(result).toJson(QJsonDocument::Compact),
                        QByteArrayLiteral("application/json"));
    });
}

bool AiGateway::providerFromName(const QString &name, Provider &provider)
{
    if (name == QStringLiteral("anthropic"))
        provider = Provider::Anthropic;
    else if (name == QStringLiteral("openai"))
        provider = Provider::OpenAi;
    else
        return false;
    return true;
}

QString AiGateway::providerName(Provider provider)
{
    return provider == Provider::Anthropic ? QStringLiteral("anthropic")
                                           : QStringLiteral("openai");
}

AiGateway::Endpoint &AiGateway::endpoint(Provider provider)
{
    return provider == Provider::Anthropic ? m_anthropic : m_openai;
}

const AiGateway::Endpoint &AiGateway::endpoint(Provider provider) const
{
    return provider == Provider::Anthropic ? m_anthropic : m_openai;
}

bool AiGateway::save(QString &errorMessage) const
{
    QJsonObject providers;
    for (Provider which : { Provider::Anthropic, Provider::OpenAi })
    {
        const Endpoint &target = endpoint(which);
        QJsonObject fields;
        fields["model"] = target.model;
        fields["baseUrl"] = target.baseUrl;
        fields["key"] = QString::fromUtf8(target.key);
        providers[providerName(which)] = fields;
    }

    QJsonObject root;
    root["provider"] = providerName(m_active);
    root["dailyRequests"] = m_dailyRequests;
    root["providers"] = providers;

    if (QDir().mkpath(QFileInfo(m_path).absolutePath()) == false)
    {
        errorMessage = QStringLiteral("Cannot create %1").arg(QFileInfo(m_path).absolutePath());
        return false;
    }

    QFile file(m_path);
    if (file.open(QIODevice::WriteOnly | QIODevice::Truncate) == false)
    {
        errorMessage = QStringLiteral("Cannot write %1").arg(m_path);
        return false;
    }

    /* Owner only, and before a byte of the key is in it. */
    if (file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner) == false)
    {
        errorMessage = QStringLiteral("Cannot restrict permissions on %1").arg(m_path);
        return false;
    }

    file.write(QJsonDocument(root).toJson());
    return true;
}

void AiGateway::rollDay()
{
    const QDate today = QDate::currentDate();
    if (m_day == today)
        return;

    m_day = today;
    m_byCaller.clear();
    m_requests = 0;
    m_inputTokens = 0;
    m_outputTokens = 0;
}

void AiGateway::meter(const QByteArray &usage, bool stream)
{
    qint64 input = 0;
    qint64 output = 0;

    /* Both dialects, and both shapes of each. A stream reports as it goes --
       Anthropic's input on message_start, its output growing on every
       message_delta -- so the largest figure seen is the turn's. Cached input
       is input too: it is cheaper, not free. */
    const auto read = [&](const QJsonObject &object) {
        const QJsonObject numbers = object.value("usage").isObject()
                                        ? object.value("usage").toObject()
                                        : object.value("message").toObject().value("usage").toObject();
        if (numbers.isEmpty())
            return;

        input = qMax(input, numbers.value("input_tokens").toInteger()
                                + numbers.value("cache_read_input_tokens").toInteger()
                                + numbers.value("cache_creation_input_tokens").toInteger()
                                + numbers.value("prompt_tokens").toInteger());
        output = qMax(output, numbers.value("output_tokens").toInteger()
                                  + numbers.value("completion_tokens").toInteger());
    };

    if (stream)
    {
        for (QByteArray line : usage.split('\n'))
        {
            line = line.trimmed();
            if (line.startsWith("data:"))
                line = line.mid(5).trimmed();
            read(QJsonDocument::fromJson(line).object());
        }
    }
    else
    {
        read(QJsonDocument::fromJson(usage).object());
    }

    m_inputTokens += input;
    m_outputTokens += output;
}
