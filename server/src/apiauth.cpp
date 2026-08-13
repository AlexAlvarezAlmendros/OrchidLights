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

#include <QHttpServerRequest>
#include <QRandomGenerator>
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
}

bool ApiAuth::load(QString &errorMessage)
{
    const QString dir = QDir::homePath() + QChar('/') + QStringLiteral(USERQLCPLUSDIR);
    m_path = dir + QStringLiteral("/api-token");

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
            return true;

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
    return true;
}

bool ApiAuth::matches(const QByteArray &presented) const
{
    if (m_token.isEmpty() || presented.isEmpty())
        return false;

    return secureEquals(presented, m_token);
}

bool ApiAuth::authorize(const QHttpServerRequest &request) const
{
    if (m_required == false)
        return true;

    QByteArray presented;
    for (const auto &header : request.headers())
    {
        if (header.first.toLower() != QByteArrayLiteral("authorization"))
            continue;

        const QByteArray value = header.second.trimmed();
        if (value.startsWith("Bearer ") == false)
            continue;

        presented = value.mid(7).trimmed();
        break;
    }

    return matches(presented);
}
