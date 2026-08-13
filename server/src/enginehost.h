/*
  OrchidLights
  enginehost.h

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

#ifndef ENGINEHOST_H
#define ENGINEHOST_H

#include <QStringList>
#include <QObject>

class Doc;

/**
 * Owns the QLC+ engine and everything it needs to actually run: the caches, the
 * output plugins, the universes and the MasterTimer.
 *
 * This is the piece the desktop applications keep inside their App class. It is
 * pulled out here so the API layer talks to one object with a small surface,
 * and so the startup order stays in a single readable place -- the engine is
 * fussy about it.
 */
class EngineHost : public QObject
{
    Q_OBJECT

public:
    struct Options
    {
        /** Explicit system fixture library, or empty to resolve it. */
        QString fixtureDirectory;
        /** Explicit output plugin directory, or empty to resolve it. */
        QString pluginDirectory;
        /**
         * Skip loading the output plugins entirely.
         *
         * The engine still runs and functions still execute; nothing reaches a
         * wire. Worth having, because the moment the plugins come up the daemon
         * starts putting DMX on whatever network it is attached to, and that is
         * not something to discover by accident during a show.
         */
        bool noOutput = false;
    };

    explicit EngineHost(QObject *parent = nullptr);
    ~EngineHost() override;

    /**
     * Bring the engine up: caches, plugins, universes, MasterTimer.
     * Returns false and fills errorMessage when the fixture library is missing,
     * which is fatal -- see the warning in FixtureLibrary for why.
     */
    bool start(const Options &options, QString &errorMessage);

    /** Load a project into the running engine. */
    bool loadProject(const QString &fileName, QString &errorMessage);

    Doc *doc() const { return m_doc; }

    /** Fixture manufacturers in the library. */
    int manufacturerCount() const { return m_manufacturers; }
    QString fixtureLibraryPath() const { return m_fixturePath; }
    QStringList userFixturePaths() const { return m_userFixturePaths; }

    /** Names of the output plugins that came up, empty when none did. */
    QStringList loadedPlugins() const { return m_loadedPlugins; }
    QString pluginPath() const { return m_pluginPath; }

    /** Anything the engine could not resolve while loading the project. */
    QString projectErrors() const;

private:
    Doc *m_doc = nullptr;
    bool m_running = false;

    int m_manufacturers = 0;
    QString m_fixturePath;
    QStringList m_userFixturePaths;

    QString m_pluginPath;
    QStringList m_loadedPlugins;
};

#endif // ENGINEHOST_H
