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
#include "chaseraction.h"
#include "chaser.h"
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

    /* Edits. Doc::modified fires on every mutation without exception, so it is
       the guarantee that nothing is missed; the rest only narrow it down, so a
       browser showing the console does not re-read the fixture library because
       someone renamed a universe. */
    connect(doc, &Doc::modified, this, &LiveFeed::onProjectModified);

    connect(doc, &Doc::fixtureAdded, this, &LiveFeed::onFixturesChanged);
    connect(doc, &Doc::fixtureRemoved, this, &LiveFeed::onFixturesChanged);
    connect(doc, &Doc::fixtureChanged, this, &LiveFeed::onFixturesChanged);

    connect(doc, &Doc::functionAdded, this, &LiveFeed::onFunctionsChanged);
    connect(doc, &Doc::functionRemoved, this, &LiveFeed::onFunctionsChanged);
    connect(doc, &Doc::functionChanged, this, &LiveFeed::onFunctionsChanged);
    connect(doc, &Doc::functionNameChanged, this, &LiveFeed::onFunctionsChanged);

    connect(doc, &Doc::fixtureGroupAdded, this, &LiveFeed::onGroupsChanged);
    connect(doc, &Doc::fixtureGroupRemoved, this, &LiveFeed::onGroupsChanged);
    connect(doc, &Doc::fixtureGroupChanged, this, &LiveFeed::onGroupsChanged);

    connect(m_engine, &EngineHost::consoleChanged, this, &LiveFeed::onConsoleChanged);
    connect(m_engine, &EngineHost::projectReplaced, this, &LiveFeed::onProjectReplaced);

    /* Blackout, pushed rather than polled. The button that engages it lives on
       every screen, so every screen has to see it flip -- an operator watching
       a phone that still says "en vivo" while the desk is dark reads that as
       the phone being broken, not as a stale cache. */
    connect(doc->inputOutputMap(), &InputOutputMap::blackoutChanged, this,
            [this](bool on) {
        QJsonObject message;
        message["type"] = "blackout";
        message["on"] = on;
        const QString payload =
            QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
    });

    /* External controls, passed straight through rather than coalesced into the
       flush.
     *
     * Binding a widget to a fader means watching for the next thing the
       operator touches, and a control that has already moved on by the time the
       message arrives is the wrong one. These are a handful of bytes and only
       arrive when somebody is turning something. */
    connect(m_engine, &EngineHost::inputSeen, this,
            [this](quint32 universe, quint32 channel, uchar value) {
        QJsonObject message;
        message["type"] = "input";
        message["universe"] = qint64(universe);
        message["channel"] = qint64(channel);
        message["value"] = int(value);

        const QString payload =
            QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
    });

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

        /* And what the universe is holding right now.
         *
         * Frames are only sent when a universe is written, so a client that
         * joins during a static look -- which is most of a show -- would sit
         * looking at nothing until somebody moved something. */
        if (add)
        {
            const QList<Universe *> universes = m_engine->doc()->inputOutputMap()->universes();

            for (quint32 id : client.universes)
            {
                if (int(id) >= universes.count())
                    continue;

                const QByteArray *values = universes.at(int(id))->postGMValues();
                if (values != nullptr)
                    socket->sendBinaryMessage(framePayload(id, *values));
            }
        }
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

    /* A channels group moves like a fader, but its id is the document's, not
       the console's. Kept as a message of its own so a client never has to know
       which id space a number belongs to -- and so that a group id and a widget
       id that happen to both be 3 cannot be confused for one another. */
    if (type == QStringLiteral("channelgroup"))
    {
        const int rawId = message.value("id").toInt(-1);
        const int raw = message.value("value").toInt(-1);
        const quint32 sliderId = LevelSource::channelGroupSlider(quint32(rawId));

        if (rawId < 0 || raw < 0 || raw > 255
            || m_engine->levels()->knows(sliderId) == false)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such channels group, or value out of range");
            sendJson(socket, error);
            return;
        }

        m_engine->levels()->setValue(sliderId, uchar(raw));

        QJsonObject update;
        update["type"] = "channelgroup";
        update["id"] = rawId;
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

    if (type == QStringLiteral("xypad"))
    {
        const quint32 id = quint32(message.value("id").toInt(-1));
        const double x = message.value("x").toDouble(-1);
        const double y = message.value("y").toDouble(-1);

        if (x < 0 || x > 1 || y < 0 || y > 1 || m_engine->levels()->knowsPad(id) == false)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such XY pad, or a position outside 0..1");
            sendJson(socket, error);
            return;
        }

        m_engine->levels()->setPosition(id, x, y);

        /* Echoed to the other clients only, for the same reason a fader is:
           the one that moved it is already showing the new position, and
           bouncing it back makes a drag stutter. */
        QJsonObject update;
        update["type"] = "xypad";
        update["id"] = qint64(id);
        update["x"] = x;
        update["y"] = y;
        const QString payload =
            QString::fromUtf8(QJsonDocument(update).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated && it.key() != socket)
                it.key()->sendTextMessage(payload);
        }
        return;
    }

    if (type == QStringLiteral("audiotriggers"))
    {
        const quint32 widgetId = quint32(message.value("id").toInt(-1));
        const bool enabled = message.value("enabled").toBool();

        if (m_engine->audio()->setEnabled(widgetId, enabled) == false)
        {
            QJsonObject reply;
            reply["type"] = "error";
            reply["error"] = QStringLiteral("No audio triggers widget with id %1").arg(widgetId);
            sendJson(socket, reply);
            return;
        }

        /* Whether it came up is worth saying: on a machine with no input the
           switch would otherwise look on while nothing listens. */
        QJsonObject update;
        update["type"] = "audiotriggers";
        update["id"] = qint64(widgetId);
        update["enabled"] = m_engine->audio()->isEnabled(widgetId);
        update["capturing"] = m_engine->audio()->isCapturing();
        if (m_engine->audio()->unavailableReason().isEmpty() == false)
            update["unavailable"] = m_engine->audio()->unavailableReason();

        const QString payload =
            QString::fromUtf8(QJsonDocument(update).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
        return;
    }

    if (type == QStringLiteral("matrix"))
    {
        /* Addressed by widget, not by function: the preset belongs to the
           widget, and which matrix it drives is the widget's business. */
        const quint32 widgetId = quint32(message.value("id").toInt(-1));
        const int presetId = message.value("preset").toInt(-1);

        QString error;
        if (m_engine->applyMatrixPreset(widgetId, presetId, error) == false)
        {
            QJsonObject reply;
            reply["type"] = "error";
            reply["error"] = error;
            sendJson(socket, reply);
            return;
        }

        /* Echoed to everyone including the sender: unlike a fader, a preset is
           a discrete change and there is no drag to stutter. */
        QJsonObject update;
        update["type"] = "matrix";
        update["id"] = qint64(widgetId);
        update["preset"] = presetId;
        const QString payload =
            QString::fromUtf8(QJsonDocument(update).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
        return;
    }

    if (type == QStringLiteral("cuelist"))
    {
        /* A cue list is a chaser plus transport. The action goes to the chaser
           the widget names, so the interface never has to know that. */
        Doc *doc = m_engine->doc();
        Function *function = doc->function(quint32(message.value("chaser").toInt(-1)));

        if (function == nullptr || function->type() != Function::ChaserType)
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("No such chaser");
            sendJson(socket, error);
            return;
        }

        Chaser *chaser = qobject_cast<Chaser *>(function);
        const QString action = message.value("action").toString();

        if (action == QStringLiteral("play"))
        {
            if (chaser->isRunning() == false)
                chaser->start(doc->masterTimer(), FunctionParent::master());
        }
        else if (action == QStringLiteral("stop"))
        {
            if (chaser->isRunning())
                chaser->stop(FunctionParent::master());
        }
        else if (action == QStringLiteral("next") || action == QStringLiteral("previous")
                 || action == QStringLiteral("step"))
        {
            /* Transport on a stopped cue list starts it first, which is what
               pressing Next on a desk does. Otherwise the first press appears
               to do nothing and the operator presses it again. */
            if (chaser->isRunning() == false)
                chaser->start(doc->masterTimer(), FunctionParent::master());

            ChaserAction command;
            command.m_masterIntensity = 1.0;
            command.m_stepIntensity = 1.0;
            command.m_fadeMode = Chaser::FromFunction;
            command.m_stepIndex = message.value("index").toInt(-1);

            if (action == QStringLiteral("next"))
                command.m_action = ChaserNextStep;
            else if (action == QStringLiteral("previous"))
                command.m_action = ChaserPreviousStep;
            else
                command.m_action = ChaserSetStepIndex;

            chaser->setAction(command);
        }
        else
        {
            QJsonObject error;
            error["type"] = "error";
            error["error"] = QStringLiteral("Action must be play, stop, next, previous or step");
            sendJson(socket, error);
            return;
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
        {
            /* A solo frame's contents are mutually exclusive -- the colour bank
               where picking red should drop blue. Enforced here rather than in
               the interface because two clients have to agree about it: if one
               browser did it and another did not, the frame would only be solo
               for whoever pressed last. */
            for (quint32 sibling : m_engine->soloSiblings(function->id()))
            {
                Function *other = doc->function(sibling);
                if (other != nullptr && other->isRunning())
                    other->stop(FunctionParent::master());
            }

            function->start(doc->masterTimer(), FunctionParent::master());
        }
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

QByteArray LiveFeed::framePayload(quint32 universeId, const QByteArray &values)
{
    /* Two bytes of 1-based universe id, little endian, then the channel
       values. Binary because 512 bytes per universe as a JSON array of numbers
       is roughly ten times the payload for the same information. */
    QByteArray packet;
    packet.reserve(2 + values.size());

    const quint16 wireId = quint16(universeId + 1);
    packet.append(char(wireId & 0xFF));
    packet.append(char((wireId >> 8) & 0xFF));
    packet.append(values);

    return packet;
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

void LiveFeed::onProjectModified(bool modified)
{
    /* Only the rising edge. resetModified() fires on save and on load, and
       neither is news: a save changed nothing a client is showing, and a load
       announces itself separately. */
    if (modified)
        m_projectDirty = true;
}

void LiveFeed::onFixturesChanged()
{
    m_changed.insert(QStringLiteral("fixtures"));
    m_projectDirty = true;
}

void LiveFeed::onFunctionsChanged()
{
    m_changed.insert(QStringLiteral("functions"));
    m_projectDirty = true;

    /* The function list carries names and timings, so an edit has to reach the
       clients as state, not only as an invitation to ask again. */
    m_functionsDirty = true;
}

void LiveFeed::onGroupsChanged()
{
    m_changed.insert(QStringLiteral("groups"));
    m_projectDirty = true;
}

void LiveFeed::onConsoleChanged()
{
    m_changed.insert(QStringLiteral("vc"));
    m_projectDirty = true;
}

void LiveFeed::onProjectReplaced()
{
    /* Everything is stale, including the parts nothing else reports. Cleared
       rather than added to, so the message says exactly that. */
    m_changed.clear();
    m_projectDirty = true;
}

void LiveFeed::flush()
{
    if (m_clients.isEmpty())
    {
        m_pending.clear();
        m_functionsDirty = false;
        m_chaserSteps.clear();
        m_runningShows.clear();
        m_changed.clear();
        m_projectDirty = false;
        return;
    }

    /* A chaser that has moved on is news, and nothing else reports it. */
    for (Function *function : m_engine->doc()->functions())
    {
        if (function->type() != Function::ChaserType)
            continue;

        const Chaser *chaser = qobject_cast<const Chaser *>(function);
        const int step = chaser->isRunning() ? chaser->currentStepIndex() : -1;

        if (m_chaserSteps.value(function->id(), -2) != step)
        {
            m_chaserSteps.insert(function->id(), step);
            m_functionsDirty = true;
        }
    }

    /* Where a running show has got to.
     *
     * Its own message rather than a field on the function list: elapsed changes
     * every tick, and marking the list dirty for it would push every function
     * in the project down every socket at the flush rate. This is three numbers.
     *
     * Without it a timeline is a drawing. With it the playhead is the show's
     * own clock, which is the difference between watching a pase and looking at
     * a picture of one. */
    for (Function *function : m_engine->doc()->functions())
    {
        if (function->type() != Function::ShowType)
            continue;

        const bool running = function->isRunning();
        if (running == false && m_runningShows.contains(function->id()) == false)
            continue;

        QJsonObject message;
        message["type"] = "show";
        message["id"] = qint64(function->id());
        message["running"] = running;
        message["elapsed"] = qint64(running ? function->elapsed() : 0);

        const QString payload =
            QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }

        if (running)
            m_runningShows.insert(function->id());
        else
            m_runningShows.remove(function->id());
    }

    /* The spectrum, at the flush rate rather than the capture's. The capture
       produces frames faster than anyone can watch, and the bars are drawn for
       a person. */
    if (m_engine->audio()->isCapturing() && m_clients.isEmpty() == false)
    {
        const QVector<uchar> spectrum = m_engine->audio()->spectrum();
        if (spectrum.isEmpty() == false)
        {
            QJsonArray bands;
            for (uchar band : spectrum)
                bands.append(int(band));

            QJsonObject message;
            message["type"] = "spectrum";
            message["bands"] = bands;
            message["volume"] = int(m_engine->audio()->volume());

            const QString payload =
                QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

            for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
            {
                if (it.value().authenticated)
                    it.key()->sendTextMessage(payload);
            }
        }
    }

    if (m_projectDirty)
    {
        m_projectDirty = false;

        /* Nothing specific fired, so the change is one nothing reports in
           detail -- a universe renamed, an output patched. Naming the whole
           project is the honest answer, and the client reads everything back. */
        QJsonArray what;
        if (m_changed.isEmpty())
        {
            what.append(QStringLiteral("project"));
        }
        else
        {
            for (const QString &item : m_changed)
                what.append(item);
        }
        m_changed.clear();

        QJsonObject message;
        message["type"] = "changed";
        message["what"] = what;

        const QString payload =
            QString::fromUtf8(QJsonDocument(message).toJson(QJsonDocument::Compact));

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated)
                it.key()->sendTextMessage(payload);
        }
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
        const QByteArray packet = framePayload(frame.key(), frame.value());

        for (auto it = m_clients.begin(); it != m_clients.end(); ++it)
        {
            if (it.value().authenticated && it.value().universes.contains(frame.key()))
                it.key()->sendBinaryMessage(packet);
        }
    }

    m_pending.clear();
}
