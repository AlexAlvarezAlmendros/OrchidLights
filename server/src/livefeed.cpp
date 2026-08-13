/*
  OrchidLights
  livefeed.cpp

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

#include <QAbstractHttpServer>
#include <QHttpServerResponder>
#include <QHttpServerRequest>
#include <QHttpServerResponse>
#include <QHttpServer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QWebSocket>

#include "livefeed.h"
#include "enginehost.h"
#include "apiauth.h"
#include "jsonview.h"
#include "levelsource.h"

#include "functionparent.h"
#include "inputoutputmap.h"
#include "mastertimer.h"
#include "function.h"
#include "doc.h"

namespace
{
    void sendJson(QWebSocket *socket, const QJsonObject &object)
    {
        socket->sendTextMessage(QString::fromUtf8(QJsonDocument(object).toJson(QJsonDocument::Compact)));
    }
}

LiveFeed::LiveFeed(EngineHost *engine, const ApiAuth *auth, QObject *parent)
    : QObject(parent)
    , m_engine(engine)
    , m_auth(auth)
{
    Q_ASSERT(engine != nullptr);
    Q_ASSERT(auth != nullptr);

    Doc *doc = m_engine->doc();

    /* Queued on purpose: this signal originates in the universe threads and
       must not run engine-side code on them. */
    connect(doc->inputOutputMap(), &InputOutputMap::universeWritten,
            this, &LiveFeed::onUniverseWritten, Qt::QueuedConnection);

    connect(doc->masterTimer(), &MasterTimer::functionListChanged,
            this, &LiveFeed::onFunctionListChanged, Qt::QueuedConnection);

    connect(&m_flushTimer, &QTimer::timeout, this, &LiveFeed::flush);
    setStreamRate(25);
}

void LiveFeed::setStreamRate(int hz)
{
    if (hz < 1)
        hz = 1;
    if (hz > 100)
        hz = 100;

    m_flushTimer.start(1000 / hz);
}

void LiveFeed::attach(QHttpServer *server)
{
    /* Qt only upgrades a path that has a route, and only if that route writes
       nothing back. Both halves are easy to get wrong:

       qabstracthttpserver.cpp:88 gates the upgrade on

           q->handleRequest(*request, socket) && q->isSignalConnected(signal)

       so with no route at all handleRequest() is false and the connection dies
       with "WebSocket received but no slots connected" -- a message that blames
       the signal, which is connected fine.

       Add an ordinary route and handleRequest() returns true, but it has
       already run the handler and written its response; Qt then hands the same
       socket to the WebSocket server, the client reads the HTTP reply first and
       gives up. The way out is the responder form of route(): with a void
       handler taking QHttpServerResponder&&, responseImpl() never calls
       sendResponse(), so a handler that writes nothing leaves the socket
       untouched for the handshake. */
    server->route("/ws", [](const QHttpServerRequest &request,
                            QHttpServerResponder &&responder) {
        if (request.value(QByteArrayLiteral("upgrade")).toLower()
            == QByteArrayLiteral("websocket"))
        {
            /* Deliberately silent. */
            return;
        }

        QJsonObject body;
        body["error"] = QStringLiteral("This endpoint speaks WebSocket, not HTTP.");
        body["hint"] = QStringLiteral("Connect with ws:// and send "
                                      "{\"type\":\"auth\",\"token\":\"...\"} if asked.");

        responder.write(QJsonDocument(body),
                        QHttpServerResponder::StatusCode::UpgradeRequired);
    });

    connect(server, &QAbstractHttpServer::newWebSocketConnection,
            this, &LiveFeed::onNewConnection);
}

void LiveFeed::onNewConnection()
{
    QAbstractHttpServer *server = qobject_cast<QAbstractHttpServer *>(sender());
    if (server == nullptr)
        return;

    while (server->hasPendingWebSocketConnections())
    {
        /* Ownership moves to us; the socket is deleted on disconnect. */
        QWebSocket *socket = server->nextPendingWebSocketConnection().release();
        if (socket == nullptr)
            continue;

        socket->setParent(this);

        Client client;
        /* With no token demanded, a socket is usable the moment it opens. */
        client.authenticated = (m_auth->isRequired() == false);
        m_clients.insert(socket, client);

        connect(socket, &QWebSocket::textMessageReceived, this, &LiveFeed::onTextMessage);
        connect(socket, &QWebSocket::disconnected, this, &LiveFeed::onDisconnected);

        sendHello(socket);

        if (client.authenticated)
            sendFunctions(socket);
    }
}

void LiveFeed::sendHello(QWebSocket *socket)
{
    QJsonObject hello;
    hello["type"] = "hello";
    hello["apiVersion"] = 1;
    hello["authRequired"] = m_auth->isRequired();
    hello["note"] = m_auth->isRequired()
                        ? QStringLiteral("Send {\"type\":\"auth\",\"token\":\"...\"} first.")
                        : QStringLiteral("Ready.");
    sendJson(socket, hello);
}

void LiveFeed::sendFunctions(QWebSocket *socket)
{
    QJsonObject message;
    message["type"] = "functions";
    message["functions"] = JsonView::functions(m_engine->doc());
    sendJson(socket, message);
}

void LiveFeed::rejectSocket(QWebSocket *socket, const QString &reason)
{
    QJsonObject error;
    error["type"] = "error";
    error["error"] = reason;
    sendJson(socket, error);

    socket->close(QWebSocketProtocol::CloseCodePolicyViolated, reason);
}

void LiveFeed::onTextMessage(const QString &message)
{
    QWebSocket *socket = qobject_cast<QWebSocket *>(sender());
    if (socket == nullptr)
        return;

    auto it = m_clients.find(socket);
    if (it == m_clients.end())
        return;

    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(message.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || document.isObject() == false)
    {
        rejectSocket(socket, QStringLiteral("Expected a JSON object"));
        return;
    }

    handleMessage(socket, it.value(), document.object());
}

void LiveFeed::handleMessage(QWebSocket *socket, Client &client, const QJsonObject &message)
{
    const QString type = message.value("type").toString();

    if (client.authenticated == false)
    {
        /* Nothing but the token is accepted until the token arrives. A socket
           that opens and starts issuing commands is not a client we know. */
        if (type != QStringLiteral("auth"))
        {
            rejectSocket(socket, QStringLiteral("Authenticate first"));
            return;
        }

        if (m_auth->matches(message.value("token").toString().toUtf8()) == false)
        {
            rejectSocket(socket, QStringLiteral("Bad token"));
            return;
        }

        client.authenticated = true;

        QJsonObject ok;
        ok["type"] = "authenticated";
        sendJson(socket, ok);

        sendFunctions(socket);
        return;
    }

    if (type == QStringLiteral("subscribe") || type == QStringLiteral("unsubscribe"))
    {
        const bool add = (type == QStringLiteral("subscribe"));

        for (const QJsonValue &value : message.value("universes").toArray())
        {
            /* 1-based on the wire, as everywhere else in the API. */
            const int wireId = value.toInt();
            if (wireId < 1)
                continue;

            const quint32 id = quint32(wireId - 1);
            if (add)
                client.universes.insert(id);
            else
                client.universes.remove(id);
        }

        QJsonObject ack;
        ack["type"] = "subscribed";
        QJsonArray list;
        for (quint32 id : client.universes)
            list.append(int(id) + 1);
        ack["universes"] = list;
        sendJson(socket, ack);
        return;
    }

    if (type == QStringLiteral("slider"))
    {
        const quint32 id = quint32(message.value("id").toInt(-1));
        const int raw = message.value("value").toInt(-1);

        if (raw < 0 || raw > 255 || m_engine->levels()->knows(id) == false)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such slider, or value out of range");
            sendJson(socket, error);
            return;
        }

        m_engine->levels()->setValue(id, uchar(raw));

        /* Echoed to the other clients only: the one that moved it is already
           showing the new position, and bouncing it back makes a dragged
           fader stutter. */
        QJsonObject update;
        update["type"] = "slider";
        update["id"] = qint64(id);
        update["value"] = raw;
        const QString payload =
            QString::fromUtf8(QJsonDocument(update).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated && it.key() != socket)
                it.key()->sendTextMessage(payload);
        }
        return;
    }

    if (type == QStringLiteral("speeddial"))
    {
        const quint32 id = quint32(message.value("id").toInt(-1));
        const int ms = message.value("value").toInt(-1);

        if (ms < 0 || m_engine->setSpeedDial(id, ms) == false)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such speed dial, or value out of range");
            sendJson(socket, error);
            return;
        }

        QJsonObject update;
        update["type"] = "speeddial";
        update["id"] = qint64(id);
        update["value"] = ms;
        const QString payload =
            QString::fromUtf8(QJsonDocument(update).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated && it.key() != socket)
                it.key()->sendTextMessage(payload);
        }
        return;
    }

    if (type == QStringLiteral("function"))
    {
        Doc *doc = m_engine->doc();
        Function *function = doc->function(quint32(message.value("id").toInt(-1)));
        if (function == nullptr)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such function");
            sendJson(socket, error);
            return;
        }

        const QString action = message.value("action").toString();
        if (action == QStringLiteral("start") && function->isRunning() == false)
            function->start(doc->masterTimer(), FunctionParent::master());
        else if (action == QStringLiteral("stop") && function->isRunning())
            function->stop(FunctionParent::master());

        /* No reply: the state change arrives as a functions broadcast once the
           engine has actually made it, on its next tick. */
        return;
    }

    QJsonObject error;
    error["type"] = "error";
    error["error"] = QStringLiteral("Unknown message type: ") + type;
    sendJson(socket, error);
}

void LiveFeed::onDisconnected()
{
    QWebSocket *socket = qobject_cast<QWebSocket *>(sender());
    if (socket == nullptr)
        return;

    m_clients.remove(socket);
    socket->deleteLater();
}

void LiveFeed::onUniverseWritten(quint32 index, const QByteArray &data)
{
    /* Overwriting is the coalescing: nobody needs the frame before last. */
    m_pending.insert(index, data);
}

void LiveFeed::onFunctionListChanged()
{
    m_functionsDirty = true;
}

void LiveFeed::flush()
{
    if (m_clients.isEmpty())
    {
        m_pending.clear();
        m_functionsDirty = false;
        return;
    }

    if (m_functionsDirty)
    {
        m_functionsDirty = false;

        QJsonObject message;
        message["type"] = "functions";
        message["functions"] = JsonView::functions(m_engine->doc());
        const QString payload =
            QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
    }

    if (m_pending.isEmpty())
        return;

    for (auto frame = m_pending.constBegin(); frame != m_pending.constEnd(); ++frame)
    {
        /* Two bytes of 1-based universe id, little endian, then the channel
           values. Binary because 512 bytes per universe as a JSON array of
           numbers is roughly ten times the payload for the same information. */
        QByteArray packet;
        packet.reserve(2 + frame.value().size());

        const quint16 wireId = quint16(frame.key() + 1);
        packet.append(char(wireId & 0xFF));
        packet.append(char((wireId >> 8) & 0xFF));
        packet.append(frame.value());

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated && it.value().universes.contains(frame.key()))
                it.key()->sendBinaryMessage(packet);
        }
    }

    m_pending.clear();
}
