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

#include <QString>

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

    Result removeFixture(Doc *doc, quint32 fixtureId);

    /** Move or rename a fixture. A universe or address of -1 leaves it alone. */
    Result updateFixture(Doc *doc, quint32 fixtureId, const QString &name,
                         int universe, int address);

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

    Result addFixtureGroup(Doc *doc, const QString &name, const QList<quint32> &fixtureIds,
                           quint32 &groupId);
    Result removeFixtureGroup(Doc *doc, quint32 groupId);
    Result setFixtureGroupMembers(Doc *doc, quint32 groupId, const QList<quint32> &fixtureIds);
}

#endif // DOCWRITER_H
