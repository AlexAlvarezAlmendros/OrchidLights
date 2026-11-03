/*
  OrchidLights
  aigateway.h

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

#ifndef AIGATEWAY_H
#define AIGATEWAY_H

#include <QByteArray>
#include <QDate>
#include <QHash>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>

class QHttpServerRequest;
class QHttpServerResponder;
class QTcpSocket;

/**
 * The assistant's way out: the provider key, kept here and never shown, and
 * the proxy that puts it on a request.
 *
 * The agent loop runs in the browser (F10). What the browser cannot hold is
 * the key -- every paired phone would carry the owner's account in its storage
 * -- so it talks to these routes and this object talks to the provider: it
 * drops whatever authentication the client sent, adds the stored key, pins the
 * configured model and streams the answer back as it arrives.
 *
 * It knows nothing of models or messages beyond that. Two dialects, each with
 * the one route it may reach: Anthropic's Messages API, and the OpenAI-style
 * chat completions that ChatGPT, Gemini, OpenRouter, Ollama and LM Studio all
 * speak. A route list rather than a path passthrough, because a proxy that
 * forwarded any path with the owner's key would hand every device the files,
 * batches and admin endpoints of that account.
 */
class AiGateway : public QObject
{
    Q_OBJECT

public:
    enum class Provider { Anthropic, OpenAi };

    explicit AiGateway(QObject *parent = nullptr);

    /**
     * Read the settings from the user data directory. A missing file is an
     * assistant nobody configured, not an error. A broken one is reported and
     * left alone: the desk starts either way, because a desk that refuses to
     * light a room over its assistant is worse than one without it.
     */
    bool load(QString &errorMessage);

    /** The settings as the API shows them: never a key, only whether there is
     *  one and its last characters. */
    QJsonObject settingsJson() const;

    /**
     * Apply a PUT body: "provider", "dailyRequests", and per provider "model",
     * "baseUrl" and "key". A key that is absent stays as it was, so a client
     * can send back what GET gave it; an empty one removes it.
     */
    bool update(const QJsonObject &body, QString &errorMessage);

    /**
     * Forward one request to the provider and stream the answer back.
     *
     * `client` is the socket the request came in on. It is watched so that a
     * browser going away cancels the provider's turn too: tokens a closed tab
     * will never read are still billed. `who` names the caller for the daily
     * cap; an empty one is the desk itself, which is not capped.
     */
    void forward(Provider provider, const QHttpServerRequest &request,
                 QHttpServerResponder &&responder, QTcpSocket *client, const QString &who);

    /** Ask the provider for its models with the stored key: proves the key
     *  works without spending a token, and fills the model picker. */
    void check(Provider provider, QHttpServerResponder &&responder, QTcpSocket *client);

    Provider activeProvider() const { return m_active; }

    static bool providerFromName(const QString &name, Provider &provider);
    static QString providerName(Provider provider);

private:
    struct Endpoint
    {
        QString model;
        QString baseUrl;
        QByteArray key;
    };

    Endpoint &endpoint(Provider provider);
    const Endpoint &endpoint(Provider provider) const;

    bool save(QString &errorMessage) const;

    /** A new day starts the counters over. */
    void rollDay();

    /** Add one finished request's usage, read from the provider's own
     *  "usage" objects: the whole JSON body, or the stream's data lines. */
    void meter(const QByteArray &usage, bool stream);

    QString m_path;
    Provider m_active = Provider::Anthropic;
    Endpoint m_anthropic;
    Endpoint m_openai;

    /** Requests a paired device may make in a day; 0 is no cap. */
    int m_dailyRequests = 300;

    /* Today's spend, in memory. A restart forgets it, which costs at most one
       day's cap and buys not writing a file on every request. */
    QDate m_day;
    QHash<QString, int> m_byCaller;
    qint64 m_requests = 0;
    qint64 m_inputTokens = 0;
    qint64 m_outputTokens = 0;

    QNetworkAccessManager m_network;
};

#endif // AIGATEWAY_H
