/*
  OrchidLights
  apiserver.h

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

#ifndef APISERVER_H
#define APISERVER_H

#include <QObject>
#include <QString>

#include "apiauth.h"

class QHttpServer;
class EngineHost;
class LiveFeed;

/**
 * The HTTP side of the daemon.
 *
 * Runs in the engine's own process and thread, so a handler touches Doc
 * directly rather than across an IPC boundary. Every handler must stay short:
 * the MasterTimer is writing DMX from another thread every 20 ms and blocking
 * here is blocking the show.
 */
class ApiServer : public QObject
{
    Q_OBJECT

public:
    struct Options
    {
        /**
         * One below the QLC+ web remote's 9999, so both can run side by side
         * while a rig is being migrated.
         */
        quint16 port = 9998;

        /**
         * Listen on every interface instead of loopback only.
         *
         * Doing so turns the bearer token on: a desk reachable across a venue
         * network is a desk anyone on it can black out mid-show.
         */
        bool listenAll = false;

        /**
         * Demand the token even on loopback.
         *
         * Loopback is left open by default because the operating system is
         * already the boundary there. On a machine with untrusted local users
         * that is not good enough, hence this.
         */
        bool requireAuth = false;

        /** How often DMX frames go out over the WebSocket, in Hz. The engine
         *  itself runs at 50. */
        int streamRate = 25;
    };

    explicit ApiServer(EngineHost *engine, QObject *parent = nullptr);
    ~ApiServer() override;

    bool start(const Options &options, QString &errorMessage);

    /** The port actually bound, 0 when not listening. */
    quint16 port() const { return m_port; }

    /** Base URL a browser or curl can use. */
    QString url() const;

    const ApiAuth &auth() const { return m_auth; }

private:
    void registerRoutes();

    EngineHost *m_engine = nullptr;
    QHttpServer *m_server = nullptr;
    LiveFeed *m_feed = nullptr;
    ApiAuth m_auth;
    quint16 m_port = 0;
    bool m_listenAll = false;
};

#endif // APISERVER_H
