/*
  OrchidLights
  installpaths.cpp

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

#include "installpaths.h"
#include "qlcfixturedefcache.h"
#include "rgbscriptscache.h"
#include "qlcmodifierscache.h"
#include "inputoutputmap.h"
#include "ioplugincache.h"
#include "qlcconfig.h"
#include "qlcfile.h"

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

    bool holdsAny(const QString &path, const QString &nameFilter)
    {
        QDir dir(path);
        dir.setFilter(QDir::Files);
        if (nameFilter.isEmpty() == false)
            dir.setNameFilters(QStringList() << nameFilter);
        return dir.entryList().isEmpty() == false;
    }
}

QStringList InstallPaths::anchoredToBinary(const QString &relative)
{
    const QString bin = QCoreApplication::applicationDirPath();

    return QStringList()
           /* <prefix>/bin/orchidlightsd -> <prefix>/<relative> */
           << QDir(bin + QStringLiteral("/../") + relative).absolutePath()
           /* <AppDir>/usr/bin/orchidlightsd -> <AppDir>/<relative> */
           << QDir(bin + QStringLiteral("/../../") + relative).absolutePath();
}

QString InstallPaths::firstWithFile(const QStringList &candidates, const QString &marker)
{
    for (const QString &candidate : candidates)
    {
        if (isReadableDir(candidate)
            && QFileInfo::exists(QDir(candidate).absoluteFilePath(marker)))
        {
            return QDir(candidate).absolutePath();
        }
    }

    return QString();
}

QString InstallPaths::firstNonEmpty(const QStringList &candidates, const QString &nameFilter)
{
    for (const QString &candidate : candidates)
    {
        if (isReadableDir(candidate) && holdsAny(candidate, nameFilter))
            return QDir(candidate).absolutePath();
    }

    return QString();
}

QString InstallPaths::shippedData(const QString &compiledPath,
                                  const QString &subdir,
                                  const QString &nameFilter)
{
    QStringList candidates;
    candidates << compiledPath;
    candidates << anchoredToBinary(QStringLiteral("share/orchidlights/") + subdir);
    /* Uninstalled, straight out of the build tree. */
    candidates << QDir(QCoreApplication::applicationDirPath()
                       + QStringLiteral("/../../../resources/") + subdir).absolutePath();

    return firstNonEmpty(candidates, nameFilter);
}

QString InstallPaths::fixtureLibrary(const QString &override)
{
    QStringList candidates;

    if (override.isEmpty() == false)
        candidates << override;

    if (qEnvironmentVariableIsSet("ORCHID_FIXTURE_DIR"))
        candidates << qEnvironmentVariable("ORCHID_FIXTURE_DIR");

    candidates << QLCFixtureDefCache::systemDefinitionDirectory().absolutePath();
    candidates << anchoredToBinary(QStringLiteral("share/orchidlights/fixtures"));

    /* Development convenience, deliberately last so it can never shadow a real
       installation: the daemon sits in build/server/src/ and the library is
       still sitting in the source tree. */
    candidates << QDir(QCoreApplication::applicationDirPath()
                       + QStringLiteral("/../../../resources/fixtures")).absolutePath();

    return firstWithFile(candidates, ORCHID_FIXTURES_MAP_NAME);
}

QString InstallPaths::ioPlugins(const QString &override)
{
    QStringList candidates;

    if (override.isEmpty() == false)
        candidates << override;

    if (qEnvironmentVariableIsSet("ORCHID_PLUGIN_DIR"))
        candidates << qEnvironmentVariable("ORCHID_PLUGIN_DIR");

    /* Correct for a normal install, where the compiled-in path is absolute and
       carries the architecture triplet we cannot reconstruct here. */
    candidates << IOPluginCache::systemPluginDirectory().absolutePath();

    candidates << anchoredToBinary(QStringLiteral("lib/qt6/plugins/orchidlights"));

    /* Note there is no source-tree fallback: the build scatters each plugin
       into its own build/plugins/<name>/ directory, and IOPluginCache::load()
       reads a single flat directory. Running uninstalled therefore needs
       $ORCHID_PLUGIN_DIR, and the daemon says so when it finds nothing. */

    return firstNonEmpty(candidates, QString("*%1").arg(KExtPlugin));
}

QString InstallPaths::rgbScripts()
{
    return shippedData(RGBScriptsCache::systemScriptsDirectory().absolutePath(),
                       QStringLiteral("rgbscripts"),
                       QStringLiteral("*.js"));
}

QString InstallPaths::modifierTemplates()
{
    return shippedData(QLCModifiersCache::systemTemplateDirectory().absolutePath(),
                       QStringLiteral("modifierstemplates"),
                       QString("*%1").arg(KExtModifierTemplate));
}

QString InstallPaths::inputProfiles()
{
    return shippedData(InputOutputMap::systemProfileDirectory().absolutePath(),
                       QStringLiteral("inputprofiles"),
                       QString("*%1").arg(KExtInputProfile));
}

QString InstallPaths::legacyUserDirectory(const QString &subdir)
{
#if defined(Q_OS_WIN)
    const QString home = qEnvironmentVariable("UserProfile");
    if (home.isEmpty())
        return QString();
    const QString root = home + QStringLiteral("/QLC+");
#elif defined(Q_OS_MACOS)
    const QString root = QDir::homePath() + QStringLiteral("/Library/Application Support/QLC+");
#else
    const QString root = QDir::homePath() + QStringLiteral("/.qlcplus");
#endif

    /* QLC+ spells these leaves lowercase on Linux but capitalised on Windows
       and macOS ("fixtures" vs "Fixtures", "inputprofiles" vs
       "InputProfiles"). Probing both is cheaper than carrying the table, and
       it stays right if upstream ever changes its mind. */
    QStringList leaves;
    leaves << subdir;

    QString capitalised;
    for (const QString &word : subdir.split(QChar('-'), Qt::SkipEmptyParts))
        capitalised += word.left(1).toUpper() + word.mid(1);
    if (subdir == QStringLiteral("inputprofiles"))
        capitalised = QStringLiteral("InputProfiles");
    if (capitalised != subdir)
        leaves << capitalised;

    for (const QString &leaf : leaves)
    {
        const QString path = root + QChar('/') + leaf;
        if (isReadableDir(path))
            return QDir(path).absolutePath();
    }

    return QString();
}
