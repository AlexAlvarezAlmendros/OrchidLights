/*
  OrchidLights
  docwriter.h

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

#ifndef DOCWRITER_H
#define DOCWRITER_H

#include <QJsonObject>
#include <QList>
#include <QString>

#include "scenevalue.h"

class Doc;

/**
 * Changes to the document.
 *
 * Everything before this read `Doc` and ran functions; nothing modified it.
 * That was the whole gap between a remote control and an application, and it is
 * shared by every surface that still needs filling -- fixtures, functions,
 * universes, console widgets -- so it lives in one place rather than being
 * reinvented per endpoint.
 *
 * Three rules hold for every mutation here:
 *
 *  - It runs on the thread that owns Doc. The API handlers already do, which is
 *    the same arrangement QLC+ itself uses: its editors run on the GUI thread
 *    while the MasterTimer runs on its own.
 *  - It marks the document modified and never touches the disk. Persisting is
 *    an explicit act -- POST /project/save -- because an edit that silently
 *    rewrote a show file would be discovered at the worst moment.
 *  - It fails with a reason. "Invalid" tells an operator nothing; "universe 5
 *    does not exist, there are 4" tells them what to do.
 */
namespace DocWriter
{
    struct Result
    {
        bool ok = false;
        QString error;

        static Result success() { return {true, QString()}; }
        static Result failure(const QString &reason) { return {false, reason}; }
    };

    /* ---- Universes ---------------------------------------------------- */

    Result addUniverse(Doc *doc);
    Result removeUniverse(Doc *doc, int index);
    Result renameUniverse(Doc *doc, int index, const QString &name);
    Result setPassthrough(Doc *doc, int index, bool enabled);

    /**
     * Patch a universe's output to a plugin line, or clear it when pluginName
     * is empty. This is the setting that decides whether anything reaches a
     * lamp at all, and until now it could only be read.
     */
    Result setOutputPatch(Doc *doc, int index, const QString &pluginName,
                          const QString &outputName);

    /** The feedback line of a universe: where the router's LED echoes go.
     *  An empty plugin name clears it. */
    Result setFeedbackPatch(Doc *doc, int index, const QString &pluginName,
                            const QString &outputName);

    Result setInputPatch(Doc *doc, int index, const QString &pluginName,
                         const QString &inputName, const QString &profileName);

    /* ---- Fixtures ------------------------------------------------------ */

    struct FixturePlacement
    {
        QString manufacturer;
        QString model;
        QString mode;
        QString name;        //!< empty to use the model name
        int universe = 1;    //!< 1-based, as everywhere on the wire
        int address = 1;     //!< 1-based
        int quantity = 1;
        int gap = 0;         //!< channels left between consecutive fixtures
    };

    /**
     * Patch one or more fixtures.
     *
     * Refuses the whole batch if any of it would overlap something already
     * patched, or run past channel 512. Partially applying a patch is worse
     * than refusing it: the operator ends up with some fixtures placed and no
     * clear idea which.
     *
     * On success, ids holds the new fixture ids in order.
     */
    Result addFixtures(Doc *doc, const FixturePlacement &placement, QList<quint32> &ids);

    /**
     * Clone a patched fixture: same definition, same mode, first hole in its
     * universe that fits the whole batch.
     *
     * Copy/paste for the patch. The address is chosen here rather than asked
     * for because the point of duplicating is not having to work one out: the
     * search starts right after the original, wraps to the top of the universe,
     * and refuses if no run of channels holds every copy. Channel modifiers
     * travel with the copy -- they belong to the patch, and a duplicate whose
     * dimmer bends differently from the original is not a duplicate.
     */
    Result cloneFixtures(Doc *doc, quint32 sourceId, int quantity, int gap,
                         QList<quint32> &ids);

    Result removeFixture(Doc *doc, quint32 fixtureId);

    /** Move or rename a fixture. A universe or address of -1 leaves it alone. */
    Result updateFixture(Doc *doc, quint32 fixtureId, const QString &name,
                         int universe, int address);

    /**
     * Attach channel modifiers to a fixture's channels, by template name.
     *
     * A modifier is a 256-entry remap applied on the way out: "Invert" turns a
     * fader upside down, "Exponential Deep" bends a dimmer curve to match a
     * lamp that does not fade linearly. It belongs to the patch, not to a cue,
     * which is why it lives here and not in a function.
     *
     * The map replaces whatever the fixture had: a channel not named loses its
     * modifier. Sending an empty map clears them all.
     */
    Result setChannelModifiers(Doc *doc, quint32 fixtureId,
                               const QMap<quint32, QString> &byChannel);

    /**
     * Where a fixture stands on the plan, and the gel in front of it.
     *
     * Position is in millimetres against the monitor's grid, which is what QLC+
     * stores and what its own 2D view draws. Anything else would mean a plan
     * built here does not open there.
     *
     * X and Y only. The engine writes a third coordinate to the file solely in
     * QMLUI builds (monitorproperties.cpp:959), so on this build a height would
     * be accepted, held in memory, and gone after a save -- and a lamp that
     * moves when the project is reopened is worse than one that could never be
     * raised. A plan is a top view; height belongs to a 3D view that does not
     * exist here yet.
     */
    struct PlanItemPatch
    {
        const double *x = nullptr;
        const double *y = nullptr;
        const double *rotation = nullptr;
        const QString *gel = nullptr;
        const int *zoom = nullptr;       //!< fixed beam width in degrees; 0 clears it
        const bool *hidden = nullptr;
        const bool *locked = nullptr;
        const bool *invertPan = nullptr;
        const bool *invertTilt = nullptr;
    };

    /**
     * The same, per head, plus what QLC+ hangs off a plan item beyond its
     * position: a fixed zoom, and the hidden / locked / inverted-pan /
     * inverted-tilt flags. Head 0 is the fixture itself; a multi-head bar
     * stores an item per head, and the file says which with a Head attribute.
     */
    Result setPlanItem(Doc *doc, quint32 fixtureId, int head, const PlanItemPatch &patch);

    /** Take a fixture off the plan without unpatching it. */
    Result clearPlanPosition(Doc *doc, quint32 fixtureId);

    /* ---- Fixture groups ------------------------------------------------ */

    /* ---- Functions ----------------------------------------------------- */

    /**
     * Create a function of any of the ten QLC+ types.
     *
     * Registration happens before naming, which is the order the desktop v4 UI
     * uses (ui/src/functionmanager.cpp:320). Naming first emits nameChanged
     * carrying an id that is still invalid, to a Doc that has not connected to
     * the object yet, and does not mark the document modified.
     *
     * Doc::addFunction is the only thing that makes a function real: it wires
     * three signals, assigns the id and emits functionAdded. When it fails the
     * caller still owns the object, so this takes care of deleting it.
     */
    Result createFunction(Doc *doc, const QString &type, const QString &name, quint32 &id);

    Result renameFunction(Doc *doc, quint32 id, const QString &name);

    /** Fade in, fade out and duration, in milliseconds. -1 leaves one alone. */
    Result setFunctionSpeeds(Doc *doc, quint32 id, int fadeIn, int fadeOut, int duration);

    /** Run order (loop|singleshot|pingpong|random) and direction (forward|backward). */
    Result setFunctionRun(Doc *doc, quint32 id, const QString &runOrder, const QString &direction);

    /**
     * Delete a function.
     *
     * Refuses while anything else references it -- a chaser step, a collection,
     * a sequence's bound scene -- naming the culprits, because Doc::deleteFunction
     * would happily leave those pointing at nothing. Stops it first: deleting a
     * running function frees an object the MasterTimer is still stepping.
     */
    Result deleteFunction(Doc *doc, quint32 id, bool force);

    /** The folder a function lives in ("Bolo/Sábado"). Empty moves it to the
     *  root. Pure organization: nothing about the function itself changes. */
    Result setFunctionPath(Doc *doc, quint32 id, const QString &path);

    /** "time" or "beats" -- whether the speeds mean milliseconds or beats of
     *  the master tempo. */
    Result setFunctionTempo(Doc *doc, quint32 id, const QString &tempoType);

    /** A chaser's three speed modes ("common" | "perstep" | "default", the
     *  last one only for duration). Empty strings leave a mode as it is. */
    Result setChaserSpeedModes(Doc *doc, quint32 chaserId, const QString &fadeIn,
                               const QString &fadeOut, const QString &duration);

    /**
     * Edit one step of a chaser: null pointers leave a field alone. Editing
     * hold or fadeIn recomputes the stored duration the way the reference
     * editor does (duration = fadeIn + hold); setting duration recomputes
     * hold. The note is the step's own name in cue lists.
     */
    Result setChaserStep(Doc *doc, quint32 chaserId, int index, const int *fadeIn,
                         const int *hold, const int *fadeOut, const int *duration,
                         const QString *note, const quint32 *functionId);

    /** Reorder a chaser's steps to exactly this permutation of 0..n-1. */
    Result setChaserStepsOrder(Doc *doc, quint32 chaserId, const QList<int> &order);

    /** Clone a function, name suffixed like QLC+ does ("(Copy)"). */
    Result cloneFunction(Doc *doc, quint32 id, quint32 &newId);

    /** The DMX values one step of a sequence holds. */
    Result setSequenceStepValues(Doc *doc, quint32 sequenceId, int index,
                                 const QList<SceneValue> &values);

    /** The function started with the show; id -1 clears it. */
    Result setStartupFunction(Doc *doc, qint64 id);

    /* ---- Function bodies ------------------------------------------------ */

    /** Scene: set or clear one channel of one fixture. */
    Result setSceneValue(Doc *doc, quint32 sceneId, quint32 fixtureId, quint32 channel,
                         int value);

    /** Chaser: append, remove or reorder steps. */
    Result addChaserStep(Doc *doc, quint32 chaserId, quint32 functionId, int index,
                         int fadeIn, int hold, int fadeOut);
    Result removeChaserStep(Doc *doc, quint32 chaserId, int index);

    /** Collection: the set of functions it fires together. */
    Result setCollectionMembers(Doc *doc, quint32 collectionId, const QList<quint32> &functionIds);

    /**
     * RGBMatrix: the fixture group it runs across, the algorithm, and colours.
     *
     * An empty algorithm name leaves it alone; group id invalidId() likewise.
     * A matrix without a group is legal to build but produces nothing, so the
     * group is reported back rather than assumed.
     */
    Result setRgbMatrix(Doc *doc, quint32 matrixId, int fixtureGroupId,
                        const QString &algorithm, const QList<QString> &colours);

    /**
     * Apply one of a Matrix widget's presets to the RGB matrix it drives.
     *
     * A colour preset drops a colour into one of the algorithm's five slots; an
     * animation preset swaps the algorithm, carrying the script properties the
     * preset was stored with -- an animation applied without them is a
     * different animation.
     *
     * `instant` recomputes the colour ramp straight away rather than at the
     * next cycle, which is what the widget's InstantApply flag asks for.
     */
    /**
     * The rest of a matrix's body: blend mode, control channel, the Text and
     * Image algorithms' own settings, an RGB script's dynamic properties.
     * Only what the object names is touched.
     */
    Result setRgbMatrixExtras(Doc *doc, quint32 matrixId, const QJsonObject &body);

    /**
     * Bake a matrix into a Scene + Sequence pair, the way QLC+ 5's
     * "save to sequence" does (qmlui/rgbmatrixeditor.cpp): one sequence step
     * per algorithm step, values mapped through the group's heads and the
     * matrix's control mode.
     */
    Result bakeMatrixToSequence(Doc *doc, quint32 matrixId, quint32 &sceneId,
                                quint32 &sequenceId);

    /**
     * Palettes: one value (or pair, or triple) with a name, referenced from
     * scenes so retinting the palette retints every look that carries it.
     * The JSON shapes mirror the XML: Color "#rrggbb", PanTilt [pan, tilt],
     * Position3D [x, y, z], Shutter [index, value], the rest one number.
     */
    Result addPalette(Doc *doc, const QString &type, const QString &name,
                      const QJsonObject &body, quint32 &newId);
    Result updatePalette(Doc *doc, quint32 id, const QJsonObject &body);
    Result removePalette(Doc *doc, quint32 id);

    /** The palettes a scene carries, plus the fixtures they resolve against.
     *  Both lists are replaced whole. */
    Result setScenePalettes(Doc *doc, quint32 sceneId, const QList<quint32> &paletteIds,
                            const QList<quint32> *fixtureIds);

    Result applyMatrixPreset(Doc *doc, quint32 matrixId, const QString &type,
                             const QString &color, const QString &resource,
                             const QList<QPair<QString, QString>> &properties,
                             bool instant);

    /** Script: the program text. */
    Result setScriptData(Doc *doc, quint32 scriptId, const QString &data);

    /** Audio: source file and volume. Volume < 0 leaves it alone. */
    /**
     * Audio: the file, the volume, and which output it plays through.
     *
     * `device` is a device description as the machine reports it, or empty for
     * "whatever the system default is". A show that sends its click track to
     * the monitor wedge and its playback to the PA needs to name them, and the
     * name is the only handle the engine offers.
     */
    Result setAudioSource(Doc *doc, quint32 audioId, const QString &fileName, double volume,
                          const QString *device = nullptr);

    /** Video: source file or URL. */
    Result setVideoSource(Doc *doc, quint32 videoId, const QString &source);

    /**
     * EFX: pattern, geometry and the fixtures that follow it.
     *
     * Structural changes to the fixture list stop the function first, and not
     * as a courtesy: EFX::m_fixtures is a bare QList with no mutex that
     * EFX::write() walks on the MasterTimer thread every 20 ms, so editing it
     * live is a use-after-free. Both desktop editors stop before touching it.
     *
     * An empty algorithm leaves it alone; a null fixtures list leaves the
     * fixture set alone.
     */
    Result setEfx(Doc *doc, quint32 efxId, const QString &algorithm,
                  const QJsonObject &geometry, const QList<quint32> *fixtureIds);

    /** Sequence: the scene it drives. Its steps use the chaser step calls. */
    Result setSequenceScene(Doc *doc, quint32 sequenceId, quint32 sceneId);

    /* ---- Shows: the multi-track timeline ------------------------------- */

    /**
     * Tracks. A track holds a scene and carries functions placed in time; the
     * sequences on it are that scene's values over the length of the show.
     */
    Result addShowTrack(Doc *doc, quint32 showId, const QString &name, quint32 sceneId,
                        quint32 &trackId);
    Result removeShowTrack(Doc *doc, quint32 showId, quint32 trackId);
    Result setShowTrack(Doc *doc, quint32 showId, quint32 trackId, const QString *name,
                        const bool *mute, const quint32 *sceneId);

    /**
     * One function placed on a track at a time.
     *
     * `duration` of 0 means "as long as the function itself lasts", which is
     * what the engine stores and what the timeline honours.
     */
    Result addShowItem(Doc *doc, quint32 showId, quint32 trackId, quint32 functionId,
                       quint32 start, quint32 duration, quint32 &itemId);
    Result setShowItem(Doc *doc, quint32 showId, quint32 itemId, const quint32 *start,
                       const quint32 *duration, const QString *color, const bool *locked);
    Result removeShowItem(Doc *doc, quint32 showId, quint32 itemId);

    Result addFixtureGroup(Doc *doc, const QString &name, const QList<quint32> &fixtureIds,
                           quint32 &groupId);
    Result removeFixtureGroup(Doc *doc, quint32 groupId);
    Result setFixtureGroupMembers(Doc *doc, quint32 groupId, const QList<quint32> &fixtureIds);

    Result renameFixtureGroup(Doc *doc, quint32 groupId, const QString &name);

    struct GroupCell
    {
        int x = 0;
        int y = 0;
        quint32 fixture = 0;
        int head = 0;
    };

    /**
     * Lay a group out as a 2D grid: its size and every occupied cell at once.
     *
     * The grid is what decides which way an RGB matrix runs across the rig, so
     * it is replaced whole rather than patched cell by cell -- a half-applied
     * layout is a matrix that snakes wrong with no way to see why. Cells may
     * name a specific head, which is how one pixel bar becomes a column.
     */
    Result setFixtureGroupGrid(Doc *doc, quint32 groupId, int width, int height,
                               const QList<GroupCell> &cells);

    /**
     * Turn or mirror the grid in place: rotate90, rotate180, rotate270,
     * flipH, flipV -- the transformations QLC+ 5 offers on a group.
     */
    Result transformFixtureGroup(Doc *doc, quint32 groupId, const QString &op);

    /**
     * Channels groups: a named handful of individual channels, moved together.
     *
     * Not a fixture group. A fixture group gathers whole fixtures so an effect
     * can run across them; a channels group gathers the dimmer of one lamp, the
     * strobe of another and the fog machine's fan, so one fader moves all
     * three. Different concept, different list in the file, different id space.
     */
    Result addChannelsGroup(Doc *doc, const QString &name,
                            const QList<QPair<quint32, quint32>> &channels, quint32 &groupId);
    Result removeChannelsGroup(Doc *doc, quint32 groupId);
    Result setChannelsGroup(Doc *doc, quint32 groupId, const QString *name,
                            const QList<QPair<quint32, quint32>> *channels);
}

#endif // DOCWRITER_H
