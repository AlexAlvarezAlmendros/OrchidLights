/*
  OrchidLights
  apiauth.cpp

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

#include <QCryptographicHash>
#include <QHttpServerRequest>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QStandardPaths>
#include <QFileInfo>
#include <QFile>
#include <QDir>

#include "apiauth.h"
#include "qlcconfig.h"

namespace
{
    QByteArray generateToken()
    {
        /* 32 bytes from the system CSPRNG. QRandomGenerator::system() is the
           one backed by the OS entropy source; the default engine is seeded
           deterministically and would be a poor choice here. */
        quint32 words[8];
        QRandomGenerator::system()->fillRange(words);

        return QByteArray(reinterpret_cast<const char *>(words), sizeof(words)).toHex();
    }

    /** Constant-time comparison, so a caller cannot learn the token one byte at
        a time by measuring how quickly it is rejected. */
    bool secureEquals(const QByteArray &a, const QByteArray &b)
    {
        if (a.size() != b.size())
            return false;

        quint8 diff = 0;
        for (int i = 0; i < a.size(); i++)
            diff |= quint8(a.at(i)) ^ quint8(b.at(i));

        return diff == 0;
    }

    QByteArray hashOf(const QByteArray &key)
    {
        return QCryptographicHash::hash(key, QCryptographicHash::Sha256).toHex();
    }

    constexpr int NAME_MAX_LENGTH = 64;
}

bool ApiAuth::load(QString &errorMessage)
{
    const QString dir = QDir::homePath() + QChar('/') + QStringLiteral(USERQLCPLUSDIR);
    m_path = dir + QStringLiteral("/api-token");
    m_devicesPath = dir + QStringLiteral("/devices.json");

    QFile file(m_path);
    if (file.exists())
    {
        if (file.open(QIODevice::ReadOnly) == false)
        {
            errorMessage = QStringLiteral("Cannot read the API token at %1").arg(m_path);
            return false;
        }

        m_token = file.readAll().trimmed();
        file.close();

        if (m_token.isEmpty() == false)
            return loadDevices(errorMessage);

        /* An empty file is not a token. Fall through and write a real one. */
    }

    if (QDir().mkpath(dir) == false)
    {
        errorMessage = QStringLiteral("Cannot create %1").arg(dir);
        return false;
    }

    m_token = generateToken();

    if (file.open(QIODevice::WriteOnly | QIODevice::Truncate) == false)
    {
        errorMessage = QStringLiteral("Cannot write the API token to %1").arg(m_path);
        return false;
    }

    file.write(m_token);
    file.write("\n");
    file.close();

    /* Owner only. A token the whole machine can read is not a token. */
    if (file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner) == false)
    {
        errorMessage = QStringLiteral("Cannot restrict permissions on %1").arg(m_path);
        return false;
    }

    m_generated = true;
    return loadDevices(errorMessage);
}

bool ApiAuth::matches(const QByteArray &presented) const
{
    if (m_token.isEmpty() || presented.isEmpty())
        return false;

    return secureEquals(presented, m_token);
}

namespace
{
    QByteArray bearerOf(const QHttpServerRequest &request)
    {
        for (const auto &header : request.headers())
        {
            if (header.first.toLower() != QByteArrayLiteral("authorization"))
                continue;

            const QByteArray value = header.second.trimmed();
            if (value.startsWith("Bearer ") == false)
                continue;

            return value.mid(7).trimmed();
        }

        return QByteArray();
    }
}

bool ApiAuth::authorize(const QHttpServerRequest &request) const
{
    if (m_required == false)
        return true;

    return identify(request).role != Role::Open;
}

bool ApiAuth::authorizeStrict(const QHttpServerRequest &request) const
{
    return matches(bearerOf(request));
}

ApiAuth::Caller ApiAuth::identify(const QHttpServerRequest &request) const
{
    return identifyKey(bearerOf(request));
}

ApiAuth::Caller ApiAuth::identifyKey(const QByteArray &presented) const
{
    Caller caller;
    if (presented.isEmpty())
        return caller;

    if (matches(presented))
    {
        caller.role = Role::Master;
        return caller;
    }

    const QByteArray hash = hashOf(presented);
    for (const Device &device : m_devices)
    {
        if (secureEquals(hash, device.hash) == false)
            continue;

        caller.role = device.role;
        caller.device = device.id;
        m_lastSeen.insert(device.id, QDateTime::currentMSecsSinceEpoch());
        return caller;
    }

    return caller;
}

QString ApiAuth::roleName(Role role)
{
    switch (role)
    {
        case Role::Master:  return QStringLiteral("master");
        case Role::Design:  return QStringLiteral("design");
        case Role::Operate: return QStringLiteral("operate");
        case Role::Open:    break;
    }
    return QStringLiteral("open");
}

bool ApiAuth::roleFromName(const QString &name, Role &role)
{
    /* Only the two a device can hold. Master is this machine's file, never
       something handed out. */
    if (name == QStringLiteral("design"))
        role = Role::Design;
    else if (name == QStringLiteral("operate"))
        role = Role::Operate;
    else
        return false;
    return true;
}

bool ApiAuth::loadDevices(QString &errorMessage)
{
    m_devices.clear();
    m_nextDevice = 1;

    QFile file(m_devicesPath);
    if (file.exists() == false)
        return true;

    if (file.open(QIODevice::ReadOnly) == false)
    {
        errorMessage = QStringLiteral("Cannot read the device keys at %1").arg(m_devicesPath);
        return false;
    }

    /* Refused rather than skipped: starting with the list silently empty locks
       every paired phone out mid-show, with nothing saying why. */
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || document.isObject() == false)
    {
        errorMessage = QStringLiteral("The device keys at %1 are not valid JSON; "
                                      "fix the file or delete it to unpair every device")
                           .arg(m_devicesPath);
        return false;
    }

    const QJsonObject root = document.object();
    for (const QJsonValue &value : root.value("devices").toArray())
    {
        const QJsonObject entry = value.toObject();
        Device device;
        device.id = quint32(entry.value("id").toInteger());
        device.name = entry.value("name").toString();
        device.hash = entry.value("hash").toString().toLatin1();
        device.created = QDateTime::fromString(entry.value("created").toString(), Qt::ISODate);
        if (device.id == 0 || device.hash.size() != 64
            || roleFromName(entry.value("role").toString(), device.role) == false)
        {
            errorMessage = QStringLiteral("A device key in %1 is malformed").arg(m_devicesPath);
            return false;
        }
        m_devices.append(device);
        m_nextDevice = qMax(m_nextDevice, device.id + 1);
    }

    /* Ids are never reused, so a revoked phone's row cannot come back as
       somebody else's. */
    m_nextDevice = qMax(m_nextDevice, quint32(root.value("next").toInteger()));
    return true;
}

bool ApiAuth::saveDevices(QString &errorMessage) const
{
    QJsonArray list;
    for (const Device &device : m_devices)
    {
        QJsonObject entry;
        entry["id"] = qint64(device.id);
        entry["name"] = device.name;
        entry["role"] = roleName(device.role);
        entry["hash"] = QString::fromLatin1(device.hash);
        entry["created"] = device.created.toString(Qt::ISODate);
        list.append(entry);
    }

    QJsonObject root;
    root["next"] = qint64(m_nextDevice);
    root["devices"] = list;

    QSaveFile file(m_devicesPath);
    if (file.open(QIODevice::WriteOnly) == false)
    {
        errorMessage = QStringLiteral("Cannot write the device keys to %1").arg(m_devicesPath);
        return false;
    }
    file.write(QJsonDocument(root).toJson());
    if (file.commit() == false)
    {
        errorMessage = QStringLiteral("Cannot write the device keys to %1").arg(m_devicesPath);
        return false;
    }

    /* Hashes, not keys -- but the list of who may touch the desk is still
       nobody else's business. */
    QFile::setPermissions(m_devicesPath, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    return true;
}

bool ApiAuth::createDevice(const QString &name, Role role, Device &made, QByteArray &key,
                           QString &errorMessage)
{
    const QString trimmed = name.trimmed();
    if (trimmed.isEmpty() || trimmed.size() > NAME_MAX_LENGTH)
    {
        errorMessage = QStringLiteral("A device needs a name of 1 to %1 characters")
                           .arg(NAME_MAX_LENGTH);
        return false;
    }
    if (role != Role::Design && role != Role::Operate)
    {
        errorMessage = QStringLiteral("A device's role is design or operate");
        return false;
    }

    Device device;
    device.id = m_nextDevice;
    device.name = trimmed;
    device.role = role;
    device.created = QDateTime::currentDateTimeUtc();

    const QByteArray fresh = generateToken();
    device.hash = hashOf(fresh);

    m_devices.append(device);
    m_nextDevice++;
    if (saveDevices(errorMessage) == false)
    {
        /* Not paired unless it survives a restart: a phone that works today
           and is locked out tomorrow is the worst way to find out. */
        m_devices.removeLast();
        m_nextDevice--;
        return false;
    }

    made = device;
    key = fresh;
    return true;
}

bool ApiAuth::updateDevice(quint32 id, const QString *name, const Role *role,
                           QString &errorMessage)
{
    for (int i = 0; i < m_devices.size(); i++)
    {
        if (m_devices.at(i).id != id)
            continue;

        const Device previous = m_devices.at(i);
        Device &device = m_devices[i];
        if (name != nullptr)
        {
            const QString trimmed = name->trimmed();
            if (trimmed.isEmpty() || trimmed.size() > NAME_MAX_LENGTH)
            {
                errorMessage = QStringLiteral("A device needs a name of 1 to %1 characters")
                                   .arg(NAME_MAX_LENGTH);
                return false;
            }
            device.name = trimmed;
        }
        if (role != nullptr)
        {
            if (*role != Role::Design && *role != Role::Operate)
            {
                errorMessage = QStringLiteral("A device's role is design or operate");
                return false;
            }
            device.role = *role;
        }

        if (saveDevices(errorMessage) == false)
        {
            m_devices[i] = previous;
            return false;
        }
        return true;
    }

    errorMessage = QStringLiteral("No such device");
    return false;
}

bool ApiAuth::revokeDevice(quint32 id, QString &errorMessage)
{
    for (int i = 0; i < m_devices.size(); i++)
    {
        if (m_devices.at(i).id != id)
            continue;

        const Device removed = m_devices.takeAt(i);
        if (saveDevices(errorMessage) == false)
        {
            m_devices.insert(i, removed);
            return false;
        }
        m_lastSeen.remove(id);
        return true;
    }

    errorMessage = QStringLiteral("No such device");
    return false;
}
