/*
  OrchidLights
  livefeed.h

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

#ifndef LIVEFEED_H
#define LIVEFEED_H

#include <QByteArray>
#include <QObject>
#include <QTimer>
#include <QHash>
#include <QSet>

class QHttpServer;
class QWebSocket;
class EngineHost;
class ApiAuth;

/**
 * The WebSocket side of the daemon: live state out, live commands in.
 *
 * Runs on the same port as the REST API -- QAbstractHttpServer hands us the
 * upgraded sockets -- so a browser needs one origin and one open port.
 *
 * Two things shape the design:
 *
 *  - Universe::universeWritten() is emitted from the universe threads, up to
 *    50 times a second per universe. Frames are coalesced per universe and
 *    flushed on a timer, so the network rate is decoupled from the engine rate
 *    and a slow client cannot drag the show.
 *  - Browsers cannot set an Authorization header on a WebSocket. The token is
 *    therefore presented in the first message rather than in the URL, where it
 *    would end up in proxy logs and browser history.
 */
class LiveFeed : public QObject
{
    Q_OBJECT

public:
    LiveFeed(EngineHost *engine, const ApiAuth *auth, QObject *parent = nullptr);

    /** Take over WebSocket connections arriving on this server, and register
     *  the route the upgrade needs. See the implementation: Qt will not upgrade
     *  a path that has no route. */
    void attach(QHttpServer *server);

    /** How often DMX frames go out, in Hz. The engine runs at 50. */
    void setStreamRate(int hz);

    int clientCount() const { return m_clients.count(); }

private slots:
    void onBeat();
    void onNewConnection();
    void onTextMessage(const QString &message);
    void onDisconnected();
    void onUniverseWritten(quint32 index, const QByteArray &data);
    void onFunctionListChanged();

    /**
     * Something about the project itself changed.
     *
     * Doc::modified fires on every mutation without exception, so it is the
     * guarantee: whatever else is missed, a client is told to look again. The
     * specific slots below only narrow that down, so a browser showing the
     * console does not re-read the fixture library because someone renamed a
     * universe.
     */
    void onProjectModified(bool modified);
    void onFixturesChanged();
    void onFunctionsChanged();
    void onGroupsChanged();
    void onConsoleChanged();
    void onProjectReplaced();

    void flush();

private:
    struct Client
    {
        bool authenticated = false;
        QSet<quint32> universes;  //!< 0-based engine ids
    };

    void handleMessage(QWebSocket *socket, Client &client, const QJsonObject &message);
    void sendHello(QWebSocket *socket);
    void sendFunctions(QWebSocket *socket);
    void rejectSocket(QWebSocket *socket, const QString &reason);

    /** One universe's values, framed for the wire. */
    static QByteArray framePayload(quint32 universeId, const QByteArray &values);

    EngineHost *m_engine = nullptr;
    const ApiAuth *m_auth = nullptr;

    QHash<QWebSocket *, Client> m_clients;

    /** Latest frame per universe, overwritten as it arrives. Overwriting is
        the coalescing: a client never needs the frame before last. */
    QHash<quint32, QByteArray> m_pending;
    bool m_functionsDirty = false;

    /** What changed since the last flush, and whether anything did at all.
     *  Coalesced for the same reason DMX frames are: an edit that touches ten
     *  things is one thing to tell a client about. */
    QSet<QString> m_changed;
    bool m_projectDirty = false;

    /** Where each running chaser had got to at the last flush.
     *
     *  Stepping does not change the list of running functions, so
     *  functionListChanged never fires for it and a cue list would sit showing
     *  cue 1 all night. Polled here rather than connected per chaser, because
     *  chasers come and go and a stale connection is worse than a comparison. */
    QHash<quint32, int> m_chaserSteps;

    /** Shows that were running at the last flush, so a stop is reported once
     *  rather than never. */
    QSet<quint32> m_runningShows;

    QTimer m_flushTimer;
};

#endif // LIVEFEED_H
