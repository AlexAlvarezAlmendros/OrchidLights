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

#include "workspaceloader.h"
#include "consolelayout.h"
#include "levelsource.h"
#include "vcpatch.h"

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

    /** Write the current project back out. An empty fileName saves over the
     *  file it was loaded from. */
    bool saveProject(const QString &fileName, QString &errorMessage);

    /** Absolute path of the loaded project, empty when none. */
    QString projectPath() const { return m_projectPath; }

    /**
     * The one directory the API may read and write projects in.
     *
     * The API takes file names, never paths. Letting a request name an
     * arbitrary path would be an arbitrary-file-write primitive handed to
     * whoever holds the token, which is not a trade a lighting desk should
     * make.
     */
    QString projectsDirectory() const { return m_projectsDirectory; }
    void setProjectsDirectory(const QString &path) { m_projectsDirectory = path; }

    /** Project files in the projects directory, by file name. */
    QStringList availableProjects() const;

    /** Resolve a bare file name inside the projects directory. Empty when the
     *  name tries to escape it. */
    QString resolveProjectName(const QString &name) const;

    Doc *doc() const { return m_doc; }

    /**
     * Run a mutation that may free or move fixtures.
     *
     * LevelSource dereferences Doc-owned Fixture pointers on the timer thread.
     * Clearing it first takes the mutex that writeDMX() holds, so once this
     * returns no tick can be inside that dereference; the sliders are then
     * rebuilt from the project afterwards.
     */
    template <typename Mutation>
    auto withFixturesLocked(Mutation mutation) -> decltype(mutation())
    {
        if (m_levels != nullptr)
            m_levels->forgetSliders();

        auto result = mutation();

        teachSliders();
        return result;
    }

    /** Apply a speed dial's value, in milliseconds, to the functions it drives.
     *  Returns false when the project has no such dial. */
    bool setSpeedDial(quint32 widgetId, int milliseconds);

    /**
     * The functions a solo frame says must stop when this one starts.
     *
     * A solo frame is a frame whose contents are mutually exclusive -- the
     * colour bank where picking red should drop blue. The rule lives here
     * rather than in the interface because two clients must agree about it:
     * if one browser enforced it and another did not, the frame would only be
     * solo for whoever pressed last.
     *
     * Empty when the function is not inside a solo frame, which is the usual
     * case.
     */
    QList<quint32> soloSiblings(quint32 functionId) const;

    /** How the operator arranged the console, empty when never arranged. */
    QVector<ConsoleLayout::Page> layout() const;

    /** Replace the arrangement. Takes effect in the file on the next save. */
    void setLayout(const QVector<ConsoleLayout::Page> &pages);

    /** Writes the Virtual Console's level sliders onto the universes. */
    LevelSource *levels() const { return m_levels; }

    /** Fixture manufacturers in the library. */
    int manufacturerCount() const { return m_manufacturers; }
    QString fixtureLibraryPath() const { return m_fixturePath; }
    QStringList userFixturePaths() const { return m_userFixturePaths; }

    /** Audio formats the decoder plugins can read. */
    QStringList audioFormats() const { return m_audioFormats; }

    /** Names of the output plugins that came up, empty when none did. */
    QStringList loadedPlugins() const { return m_loadedPlugins; }
    QString pluginPath() const { return m_pluginPath; }

    /** Raw XML of the project sections this daemon does not model. The
     *  Virtual Console is parsed out of here for display. */
    QStringList preservedSections() const { return m_preserved.sections; }

    /**
     * Editing the Virtual Console.
     *
     * These patch the preserved XML rather than regenerating it -- see VcPatch
     * for why that is the only safe direction -- and then put the engine back
     * in step with what changed: a slider that appeared starts driving DMX, one
     * that went stops, and the console layout forgets the ids that are gone.
     *
     * Nothing here touches disk. The change lives in memory until the project
     * is saved, exactly like every other edit the API makes.
     */
    VcPatch::Result editWidget(const QString &widgetId, const QJsonObject &patch);
    VcPatch::Result addWidget(const QString &type, const QString &parentId,
                              const QJsonObject &properties, QString &newId);
    VcPatch::Result removeWidget(const QString &widgetId);

    /** Give an id to every widget that has none, so a project written by QLC+ 4
     *  can be edited at all. See VcPatch::assignIds. */
    VcPatch::Result assignWidgetIds(int &assigned);

    /** Drop a deleted fixture's references out of the console, so a later
     *  fixture cannot inherit its id and its sliders with it. */
    int forgetFixture(quint32 fixtureId);

    /** Anything the engine could not resolve while loading the project. */
    QString projectErrors() const;

signals:
    /**
     * The Virtual Console changed.
     *
     * It lives outside Doc, in the preserved XML, so none of Doc's signals fire
     * for it -- without this a widget edited on one phone would not appear on
     * another until it was reloaded.
     */
    void consoleChanged();

    /** A different project is loaded. Everything a client is showing is stale,
     *  including the parts nothing else reports. */
    void projectReplaced();

private:
    /** Read the project's level sliders and hand them to the level source. */
    void teachSliders();

    /** Zero the DMX channels a set of level sliders was holding, and take their
     *  ids out of the saved layout. Both are cleanup after a widget goes. */
    void releaseLevels(const QList<LevelSource::Channel> &channels);
    void forgetLayoutIds(const QStringList &widgetIds);

    /** Check that the functions and fixtures a widget patch names actually
     *  exist. The console itself is only text and will hold anything. */
    VcPatch::Result checkReferences(const QString &widgetId, const QJsonObject &patch) const;

    Doc *m_doc = nullptr;
    LevelSource *m_levels = nullptr;
    bool m_running = false;

    int m_manufacturers = 0;
    QString m_fixturePath;
    QStringList m_userFixturePaths;

    QString m_pluginPath;
    QStringList m_loadedPlugins;
    QStringList m_audioFormats;

    QString m_projectPath;
    QString m_projectsDirectory;
    WorkspaceLoader::Preserved m_preserved;
};

#endif // ENGINEHOST_H
