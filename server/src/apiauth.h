/*
  OrchidLights
  apiauth.h

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

#ifndef APIAUTH_H
#define APIAUTH_H

#include <QByteArray>
#include <QString>

class QHttpServerRequest;

/**
 * Bearer token authentication for the API.
 *
 * A lighting desk reachable over a venue network is a desk anyone on that
 * network can black out mid-show, so opening the daemon beyond loopback
 * requires a token.
 *
 * The token lives in the user data directory with owner-only permissions and is
 * generated on first use. It is deliberately not a password: there is no user
 * to remember it, the browser stores it, and rotating it is deleting a file.
 */
class ApiAuth
{
public:
    /**
     * Load the token, generating and persisting one if there is none.
     * Returns false and fills errorMessage if it cannot be stored, because
     * silently running with a token that will not survive a restart is worse
     * than refusing to start.
     */
    bool load(QString &errorMessage);

    /** Whether requests must carry the token. */
    void setRequired(bool required) { m_required = required; }
    bool isRequired() const { return m_required; }

    /** True when the request may proceed. */
    bool authorize(const QHttpServerRequest &request) const;

    /**
     * True only when the request carries the token, whatever setRequired says.
     *
     * For the routes that reach the disk or kill the process: on loopback the
     * rest of the API deliberately works without a token, but "anything on
     * this machine can use the desk" must never grow into "anything that can
     * reach this socket can read my files or shut me down".
     */
    bool authorizeStrict(const QHttpServerRequest &request) const;

    /**
     * True when presented is the token, compared in constant time.
     *
     * Exposed because a browser cannot set an Authorization header on a
     * WebSocket, so that path presents the token in its first message instead
     * and needs the same comparison.
     */
    bool matches(const QByteArray &presented) const;

    QByteArray token() const { return m_token; }

    /** Where the token is stored, for telling the operator where to find it. */
    QString tokenPath() const { return m_path; }

    /** True when the token was created by this run rather than read back. */
    bool wasGenerated() const { return m_generated; }

private:
    QByteArray m_token;
    QString m_path;
    bool m_required = false;
    bool m_generated = false;
};

#endif // APIAUTH_H
