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
#include "audiotriggers.h"
#include "levelsource.h"
#include "vcpatch.h"

class Doc;
class InputRouter;

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

    /**
     * The Grand Master, read and driven.
     *
     * The engine always had one -- every frame the daemon ever sent was
     * post-GM -- but nothing exposed it, so it sat at full and QLC+ projects
     * that relied on Limit or AllChannels ran differently here, silently.
     * Settings persist in the console's <Properties>; the VALUE does not
     * survive a restart, matching QLC+ (a desk that comes up half-dimmed
     * because of last night is a desk somebody debugs in the dark).
     */
    struct GrandMasterState
    {
        int value = 255;
        QString channelMode; /**< "Intensity" | "All" */
        QString valueMode;   /**< "Reduce" | "Limit" */
        bool visible = true;

        /** The external control bound to the big fader, if any. */
        bool hasInput = false;
        quint32 inputUniverse = 0;
        quint32 inputChannel = 0;
    };
    GrandMasterState grandMaster() const;
    /** Apply and persist. Empty strings leave a mode as it is; value < 0
     *  leaves the level alone. Returns false on an unknown mode string. */
    bool setGrandMaster(int value, const QString &channelMode, const QString &valueMode,
                        int visible, QString &errorMessage);

    /** Bind (or, with bind = false, unbind) the external control that moves
     *  the Grand Master. Persists into the console's <Properties>. */
    bool setGrandMasterInput(bool bind, quint32 universe, quint32 channel,
                             QString &errorMessage);

    /** Stop every running function; with fadeMs > 0, fade them out first. */
    void stopEverything(int fadeMs);

    /** The Simple Desk: raw universe channels, held by hand. */
    class SimpleDeskSource *desk() const { return m_desk; }

    /**
     * What the dump would capture right now: everything the desk and the
     * live desk are holding THAT A SCENE CAN SAY. A scene speaks in
     * (fixture, channel); bare-wire values the Simple Desk holds on
     * unpatched addresses have no words in that language and are counted
     * separately, so the interface can say "2 quedan fuera" instead of
     * quietly shrinking the dump.
     */
    struct DumpValue
    {
        quint32 fixture;
        quint32 channel;
        uchar value;
        int group; /**< QLCChannel::Group of the channel. */
    };
    QList<DumpValue> dumpableValues() const;
    /** Held on addresses no fixture owns; a scene cannot carry these. */
    int bareHeldCount() const;

    /**
     * Write the current grip into a scene: a fresh one when sceneId is
     * Function::invalidId(), merged into an existing one otherwise --
     * merging is what "record over this look" means.
     * `groups` filters by channel kind (empty keeps all); nonZeroOnly drops
     * zeros. Fails when nothing would be written: an empty dump that
     * "succeeds" makes an empty scene somebody trusts.
     */
    bool dumpToScene(const QString &name, quint32 sceneId, bool nonZeroOnly,
                     const QList<int> &groups, quint32 &outSceneId, int &written,
                     QString &errorMessage);

    /**
     * Wind the engine down on purpose.
     *
     * Without this, the only exit is the process dying mid-tick, which leaves
     * the rig holding whatever frame happened to be last -- ArtNet nodes and
     * DMX interfaces latch, so "the daemon stopped" looks like "the lights
     * froze on". Stops every function; with zeroOutput it also engages
     * blackout and waits for the zeroed frame to actually reach the plugins
     * before returning, so a venue going dark is a fact, not a race.
     *
     * Safe to call more than once; after it the engine no longer runs.
     */
    void shutDown(bool zeroOutput);

    /** Load a project into the running engine. */
    bool loadProject(const QString &fileName, QString &errorMessage);

    /**
     * Start over: an empty document, no path.
     *
     * Deliberately forgets where the old project lived, so the next save has
     * to say where -- "new" that silently keeps the old path is how a blank
     * workspace ends up written over last night's show.
     */
    void newProject();

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

    /**
     * The autosave: <project>.autosave.qxw next to the project, thirty
     * seconds after each modification (collapsed while edits keep coming),
     * deleted by a real save. The interval bends only for the tests
     * (ORCHID_AUTOSAVE_MS), because a smoke test that waits half a minute
     * per assertion is a smoke test nobody runs.
     */
    QString autosavePath() const;
    /** An autosave newer than the project it shadows, or empty. */
    QString pendingAutosave() const;

    /**
     * Load the pending autosave's CONTENT while keeping the project's own
     * path: the recovered show is "your project, modified" -- saving it goes
     * to the real file, and the shadow disappears with that save. Loading the
     * autosave as if it were the project would aim every later save at
     * <show>.qxw.autosave.qxw, a file no other tool will ever look for.
     */
    bool recoverAutosave(QString &errorMessage);

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

    /** Drives the console from what the microphone hears. */
    AudioTriggers *audio() const { return m_triggers; }

    /** The external-input routing table, for whoever needs to ask it. */
    InputRouter *inputRouter() const { return m_router; }

    /** Fixture manufacturers in the library. */
    int manufacturerCount() const { return m_manufacturers; }
    QString fixtureLibraryPath() const { return m_fixturePath; }
    QStringList userFixturePaths() const { return m_userFixturePaths; }

    /** Audio formats the decoder plugins can read. */
    QStringList audioFormats() const { return m_audioFormats; }

    /** Audio outputs this machine reports. Empty means an Audio function can
     *  read its file and still make no sound, which is worth being able to
     *  say rather than leaving somebody to work out. */
    QStringList audioOutputs() const;

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

    /**
     * Undo and redo, for edits to the Virtual Console.
     *
     * Scoped to the console on purpose, and the name says so. The console is
     * preserved XML: undoing an edit is swapping one string back, which costs
     * nothing and disturbs nothing. Undoing a change to Doc would mean
     * rebuilding the document -- stopping the timer, dropping every running
     * function and every held level -- and a control that can black out a rig
     * is not an undo button, whatever it is labelled.
     *
     * So a deleted widget comes back, and a deleted fixture is re-patched by
     * hand. That asymmetry is deliberate and worth knowing about.
     */
    bool undoConsole();
    bool redoConsole();

    int undoDepth() const { return m_undo.count(); }
    int redoDepth() const { return m_redo.count(); }

    /** Drop a deleted fixture's references out of the console, so a later
     *  fixture cannot inherit its id and its sliders with it. */
    int forgetFixture(quint32 fixtureId);

    /**
     * The live desk: absolute values pinned on individual channels.
     *
     * Validated here rather than in LevelSource, which holds no opinion about
     * what a channel is: a channel past a fixture's last one lands on the
     * address of whatever is patched next to it, exactly as it does for a
     * channels group.
     */
    bool setLiveValues(const QList<QPair<LevelSource::Channel, uchar>> &values,
                       QString &errorMessage);

    /** Let go of everything the live desk holds, and put those channels down.
     *  A channel a control stops holding stays latched at whatever it was, and
     *  the control that could lower it is the one being let go of. */
    void releaseLive();

    /**
     * Channels groups: the document's own faders, edited from here rather than
     * straight from the routes.
     *
     * Because a group is live. Editing one is three things in one order --
     * take its fader back, change the document, put the new fader on the wire
     * -- and a channel dropped from a group stays latched at whatever it was
     * holding, with the one control that could lower it now gone. Zeroing what
     * a group lets go of is the whole reason these do not just call DocWriter.
     */
    bool addChannelGroup(const QString &name, const QList<LevelSource::Channel> &channels,
                         quint32 &groupId, QString &errorMessage);
    bool updateChannelGroup(quint32 groupId, const QString *name,
                            const QList<LevelSource::Channel> *channels, QString &errorMessage);
    bool removeChannelGroup(quint32 groupId, QString &errorMessage);

    /**
     * Apply one of a Matrix widget's presets to the matrix it drives.
     *
     * The preset lives in the console and the matrix lives in Doc, so this is
     * the one place that knows both. Returns false with a readable reason.
     */
    bool applyMatrixPreset(quint32 widgetId, int presetId, QString &errorMessage);

    /** Anything the engine could not resolve while loading the project. */
    QString projectErrors() const;

    /**
     * The last external input this daemon saw, for binding a widget to it.
     *
     * Learning a control by pressing it is the only way anybody binds MIDI:
     * nobody knows that their fader is channel 47 of input universe 1, and a
     * form asking for two numbers is a form nobody can fill in.
     */
    struct SeenInput
    {
        bool valid = false;
        quint32 universe = 0;
        quint32 channel = 0;
        uchar value = 0;
    };

    SeenInput lastInput() const { return m_lastInput; }

signals:
    /** The Grand Master moved or changed mode -- by any client. */
    void grandMasterChanged();

    /** The Simple Desk changed what it holds on a universe (0-based). */
    void deskChanged(quint32 universe);

    /** The live desk (the plan's per-fixture grips) changed what it holds. */
    void liveChanged();

    /** An external control moved. Carried live because learning a binding means
     *  watching for the next thing the operator touches. */
    void inputSeen(quint32 universe, quint32 channel, uchar value);

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

    /** Arm (or re-arm) the autosave countdown after a modification. */
    void armAutosave();

    Doc *m_doc = nullptr;
    LevelSource *m_levels = nullptr;
    class SimpleDeskSource *m_desk = nullptr;
    class QTimer *m_autosave = nullptr;
    SeenInput m_lastInput;
    AudioTriggers *m_triggers = nullptr;
    InputRouter *m_router = nullptr;
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

    /**
     * Snapshots of the preserved sections, before and after the current state.
     *
     * Whole copies rather than a description of each change: the sections are a
     * few kilobytes of XML, and a snapshot cannot be wrong about what it
     * restores the way a hand-written inverse of every operation can.
     */
    QList<WorkspaceLoader::Preserved> m_undo;
    QList<WorkspaceLoader::Preserved> m_redo;

    /** Remember the console as it stands, before changing it. */
    void rememberConsole();
};

#endif // ENGINEHOST_H
