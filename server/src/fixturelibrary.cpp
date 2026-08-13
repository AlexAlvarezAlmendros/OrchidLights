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
#include "installpaths.h"
#include "qlcfixturedefcache.h"
#include "avolitesd4parser.h"
#include "qlcfile.h"
#include "doc.h"

namespace
{
    bool isReadableDir(const QString &path)
    {
        if (path.isEmpty())
            return false;

        const QFileInfo info(path);
        return info.exists() && info.isDir() && info.isReadable();
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
}

QString FixtureLibrary::systemDirectory(const QString &override)
{
    return InstallPaths::fixtureLibrary(override);
}

QStringList FixtureLibrary::userDirectories()
{
    QStringList paths;

    /* Note this call creates the directory when it is missing. */
    const QString own = QLCFixtureDefCache::userDefinitionDirectory().absolutePath();
    if (isReadableDir(own))
        paths << own;

    const QString legacy = InstallPaths::legacyUserDirectory(QStringLiteral("fixtures"));
    if (legacy.isEmpty() == false && paths.contains(legacy) == false)
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
