/*
  OrchidLights
  fixturelibrary.cpp

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

#include <QCoreApplication>
#include <QFileInfo>
#include <QDir>

#include "fixturelibrary.h"
#include "qlcfixturedefcache.h"
#include "avolitesd4parser.h"
#include "qlcfile.h"
#include "doc.h"

/* Mirrors the constant of the same name in qlcfixturedefcache.cpp, which is
   private to that translation unit. */
#define ORCHID_FIXTURES_MAP_NAME QStringLiteral("FixturesMap.xml")

namespace
{
    bool isReadableDir(const QString &path)
    {
        if (path.isEmpty())
            return false;

        const QFileInfo info(path);
        return info.exists() && info.isDir() && info.isReadable();
    }

    /** Where QLC+ keeps user fixture definitions on this platform. */
    QString legacyUserFixturePath()
    {
#if defined(Q_OS_WIN)
        const QString home = qEnvironmentVariable("UserProfile");
        return home.isEmpty() ? QString() : home + QStringLiteral("/QLC+/Fixtures");
#elif defined(Q_OS_MACOS)
        return QDir::homePath() + QStringLiteral("/Library/Application Support/QLC+/Fixtures");
#else
        return QDir::homePath() + QStringLiteral("/.qlcplus/fixtures");
#endif
    }

    /** A QDir filtered the way QLCFixtureDefCache::load() expects, since it
        iterates entryList() and warns about anything it cannot recognise. */
    QDir definitionDir(const QString &path)
    {
        QDir dir(path);
        dir.setFilter(QDir::Files);
        dir.setNameFilters(QStringList()
                           << QString("*%1").arg(KExtFixture)
                           << QString("*%1").arg(KExtAvolitesFixture));
        return dir;
    }

    bool holdsSystemLibrary(const QString &path)
    {
        return isReadableDir(path)
               && QFileInfo::exists(QDir(path).absoluteFilePath(ORCHID_FIXTURES_MAP_NAME));
    }
}

QString FixtureLibrary::systemDirectory(const QString &override)
{
    QStringList candidates;

    if (override.isEmpty() == false)
        candidates << override;

    if (qEnvironmentVariableIsSet("ORCHID_FIXTURE_DIR"))
        candidates << qEnvironmentVariable("ORCHID_FIXTURE_DIR");

    candidates << QLCFixtureDefCache::systemDefinitionDirectory().absolutePath();

    /* Relocatable installs. QLCFile::systemDirectory() resolves its Linux path
       against the process working directory rather than the binary, so a
       bundle started from anywhere but its own bin/ would miss the library
       entirely. Anchor it to the executable instead.

       Two layouts to cover: a normal prefix install puts the binary in
       <prefix>/bin and the data in <prefix>/share, while the AppImage keeps
       the binary in <AppDir>/usr/bin but the data in <AppDir>/share. */
    candidates << QDir(QCoreApplication::applicationDirPath()
                       + QStringLiteral("/../share/orchidlights/fixtures")).absolutePath();
    candidates << QDir(QCoreApplication::applicationDirPath()
                       + QStringLiteral("/../../share/orchidlights/fixtures")).absolutePath();

    /* Development convenience, deliberately last so it can never shadow a real
       installation: the daemon sits in build/server/src/ and the library is
       still sitting in the source tree. */
    candidates << QDir(QCoreApplication::applicationDirPath()
                       + QStringLiteral("/../../../resources/fixtures")).absolutePath();

    for (const QString &candidate : candidates)
    {
        if (holdsSystemLibrary(candidate))
            return QDir(candidate).absolutePath();
    }

    return QString();
}

QStringList FixtureLibrary::userDirectories()
{
    QStringList paths;

    /* Note this call creates the directory when it is missing. */
    const QString own = QLCFixtureDefCache::userDefinitionDirectory().absolutePath();
    if (isReadableDir(own))
        paths << own;

    const QString legacy = QDir(legacyUserFixturePath()).absolutePath();
    if (isReadableDir(legacy) && paths.contains(legacy) == false)
        paths << legacy;

    return paths;
}

FixtureLibrary::Result FixtureLibrary::load(Doc *doc, const QString &systemOverride)
{
    Result result;

    QLCFixtureDefCache *cache = doc->fixtureDefCache();

    /* User definitions first: QLCFixtureDefCache::addFixtureDef() keeps the
       first definition it sees and drops later duplicates, so reading these
       ahead of the system library is what lets a user profile override a
       shipped one. */
    const QStringList userPaths = userDirectories();
    for (const QString &path : userPaths)
    {
        if (cache->load(definitionDir(path)))
            result.userPaths << path;
    }

    const QString systemPath = systemDirectory(systemOverride);
    if (systemPath.isEmpty() == false && cache->loadMap(QDir(systemPath)))
        result.systemPath = systemPath;

    result.manufacturers = cache->manufacturers().count();

    return result;
}
