/*
  OrchidLights
  enginehost.cpp

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

#include <QDir>

#include "enginehost.h"
#include "installpaths.h"
#include "fixturelibrary.h"
#include "workspaceloader.h"

#include "qlcmodifierscache.h"
#include "rgbscriptscache.h"
#include "ioplugincache.h"
#include "qlcioplugin.h"
#include "inputoutputmap.h"
#include "mastertimer.h"
#include "doc.h"

EngineHost::EngineHost(QObject *parent)
    : QObject(parent)
{
}

EngineHost::~EngineHost()
{
    if (m_doc != nullptr && m_running)
        m_doc->masterTimer()->stop();
}

bool EngineHost::start(const Options &options, QString &errorMessage)
{
    Q_ASSERT(m_doc == nullptr);

    m_doc = new Doc(this);

    /* Fixture definitions. User profiles are read before the system library so
       they win on conflicts, matching QLC+. */
    const FixtureLibrary::Result library =
        FixtureLibrary::load(m_doc, options.fixtureDirectory);

    m_manufacturers = library.manufacturers;
    m_fixturePath = library.systemPath;
    m_userFixturePaths = library.userPaths;

    if (m_fixturePath.isEmpty())
    {
        errorMessage = QStringLiteral(
            "No system fixture library found. Every patched fixture would fall back "
            "to a generic dimmer, losing its channel definitions. "
            "Pass --fixtures <dir> or set ORCHID_FIXTURE_DIR.");
        return false;
    }

    /* Channel modifier templates. */
    const QString modifiers = InstallPaths::modifierTemplates();
    if (modifiers.isEmpty() == false)
        m_doc->modifiersCache()->load(QDir(modifiers), true);
    m_doc->modifiersCache()->load(QLCModifiersCache::userTemplateDirectory());

    /* RGB matrix scripts. */
    const QString scripts = InstallPaths::rgbScripts();
    if (scripts.isEmpty() == false)
        m_doc->rgbScriptsCache()->load(QDir(scripts));
    m_doc->rgbScriptsCache()->load(RGBScriptsCache::userScriptsDirectory());

    /* Output plugins. Skipping them keeps the engine fully functional but
       silent on the wire. */
    if (options.noOutput == false)
    {
        m_pluginPath = InstallPaths::ioPlugins(options.pluginDirectory);
        if (m_pluginPath.isEmpty() == false)
        {
            m_doc->ioPluginCache()->load(QDir(m_pluginPath));

            const QList<QLCIOPlugin *> plugins = m_doc->ioPluginCache()->plugins();
            for (QLCIOPlugin *plugin : plugins)
                m_loadedPlugins << plugin->name();
        }
    }

    Q_ASSERT(m_doc->inputOutputMap() != nullptr);

    /* Input profiles, ours and the legacy QLC+ ones, for the same reason the
       fixture definitions read both. */
    const QString profiles = InstallPaths::inputProfiles();
    if (profiles.isEmpty() == false)
        m_doc->inputOutputMap()->loadProfiles(QDir(profiles));

    m_doc->inputOutputMap()->loadProfiles(InputOutputMap::userProfileDirectory());

    const QString legacyProfiles = InstallPaths::legacyUserDirectory(QStringLiteral("inputprofiles"));
    if (legacyProfiles.isEmpty() == false)
        m_doc->inputOutputMap()->loadProfiles(QDir(legacyProfiles));

    m_doc->inputOutputMap()->loadDefaults();
    m_doc->inputOutputMap()->setBeatGeneratorType(InputOutputMap::Internal);
    m_doc->inputOutputMap()->startUniverses();

    m_doc->masterTimer()->start();
    m_running = true;

    return true;
}

bool EngineHost::loadProject(const QString &fileName, QString &errorMessage)
{
    Q_ASSERT(m_doc != nullptr);

    /* Stop the clock across the swap. Loading rebuilds fixtures and functions
       underneath a timer that is writing DMX from another thread. */
    m_doc->masterTimer()->stop();
    m_doc->clearContents();
    m_doc->clearErrorLog();

    const bool ok = WorkspaceLoader::load(m_doc, fileName, errorMessage);

    m_doc->inputOutputMap()->startUniverses();
    m_doc->masterTimer()->start();

    return ok;
}

QString EngineHost::projectErrors() const
{
    return m_doc == nullptr ? QString() : m_doc->errorLog();
}
