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
#include <QDateTime>
#include <QHash>
#include <QList>
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
 *
 * That token is the MASTER key: it opens everything, the disk and the off
 * switch included, and it stays on this machine. Every other device gets a
 * key of its own, paired from the desk and revocable one by one, with a ROLE:
 *
 *  - design: the whole desk, as the master has it, minus the disk, the
 *    shutdown, the access mask and the device list -- the designer's phone
 *    walking the venue;
 *  - operate: the console and the desk under the access mask, never the
 *    editors -- the phone taped to a truss.
 *
 * Before device keys every client carried the one token, and the token
 * bypassed the mask: on a desk open to the network the kiosk cage was kept by
 * the interface alone. Device keys are stored as SHA-256 hashes, so the file
 * that lists them is not a file of keys.
 */
class ApiAuth
{
public:
    /** Who is asking. Open is nobody in particular: no key, or one this desk
     *  does not know -- allowed only where no key is demanded. */
    enum class Role { Open, Master, Design, Operate };

    struct Caller
    {
        Role role = Role::Open;
        quint32 device = 0;  //!< the device's id, for Design and Operate
    };

    struct Device
    {
        quint32 id = 0;
        QString name;
        Role role = Role::Operate;
        QByteArray hash;     //!< SHA-256 of the key, hex; the key itself is never kept
        QDateTime created;
    };

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

    /** Who the request's bearer key belongs to. */
    Caller identify(const QHttpServerRequest &request) const;

    /** The same, for a key presented some other way (a WebSocket's first
     *  message). Also stamps the device's last-seen time. */
    Caller identifyKey(const QByteArray &presented) const;

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

    /* ---- device keys ----------------------------------------------------- */

    QList<Device> devices() const { return m_devices; }

    /** When the device last presented its key in this run; 0 for never. */
    qint64 lastSeen(quint32 id) const { return m_lastSeen.value(id, 0); }

    /** Pair a device. The key comes back in `key` and is NOT kept: shown once,
     *  in the QR, and after that only its hash exists. */
    bool createDevice(const QString &name, Role role, Device &made, QByteArray &key,
                      QString &errorMessage);

    /** Rename or change the role; null leaves that field as it is. */
    bool updateDevice(quint32 id, const QString *name, const Role *role,
                      QString &errorMessage);

    bool revokeDevice(quint32 id, QString &errorMessage);

    static QString roleName(Role role);
    static bool roleFromName(const QString &name, Role &role);

private:
    bool loadDevices(QString &errorMessage);
    bool saveDevices(QString &errorMessage) const;

    QByteArray m_token;
    QString m_path;
    bool m_required = false;
    bool m_generated = false;

    QString m_devicesPath;
    QList<Device> m_devices;
    quint32 m_nextDevice = 1;
    mutable QHash<quint32, qint64> m_lastSeen;
};

#endif // APIAUTH_H
