/*
  OrchidLights
  vcpatch.h

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

#ifndef VCPATCH_H
#define VCPATCH_H

#include <QJsonObject>
#include <QStringList>
#include <QString>

struct XmlNode;

/**
 * Edits to the Virtual Console, applied as patches to the preserved XML.
 *
 * Nothing here regenerates the section. It finds the node a widget lives in and
 * changes the specific attributes asked for, leaving every sibling, child and
 * unknown element exactly where it was. That is the whole point: this daemon
 * models a quarter of what a Virtual Console persists, and the other
 * three-quarters -- input bindings, key sequences, button actions, fonts,
 * grand master settings -- survives only because it is never touched.
 *
 * Two rules, and they are not negotiable:
 *
 *  - Never reorder or remove a node we did not author.
 *  - Address by widget id, never by position. A widget's place in the file is
 *    QLC+'s business.
 */
namespace VcPatch
{
    struct Result
    {
        bool ok = false;
        QString error;

        static Result success() { return {true, QString()}; }
        static Result failure(const QString &reason) { return {false, reason}; }
    };

    /** Locate the <VirtualConsole> fragment among the preserved sections.
     *  Returns -1 when the project has none. */
    int sectionIndex(const QStringList &sections);

    /**
     * Change a widget's caption, geometry or page.
     *
     * Only the keys present in `patch` are touched. Geometry arrives as
     * { x, y, width, height } and is written back into the four WindowState
     * attributes, leaving @Visible and v5's @Z alone.
     */
    Result editWidget(QStringList &sections, const QString &widgetId,
                      const QJsonObject &patch);

    /**
     * Add a widget of `type` to the frame named by `parentId`, or to the top
     * frame when that is empty.
     *
     * The new node is built from a template that both QLC+ 4 and 5 load, and
     * appended after the frame's own elements -- where the frame writer puts
     * children -- so QLC+'s next save does not reshuffle the file.
     */
    Result addWidget(QStringList &sections, const QString &type, const QString &parentId,
                     const QJsonObject &properties, QString &newId);

    /**
     * Remove a widget and everything inside it.
     *
     * `removedIds` comes back holding the widget and every descendant that went
     * with it. A frame carries its children away, and the caller has cleanup
     * for each of them -- the layout that lists them, the level sliders that
     * are still driving DMX.
     */
    Result removeWidget(QStringList &sections, const QString &widgetId,
                        QStringList &removedIds);

    /**
     * Drop every reference to a fixture from the console.
     *
     * Called when a fixture is deleted. Without it the console keeps pointing
     * at an id the engine has freed, and since Doc hands out the lowest free
     * id, the next fixture patched inherits it -- along with whatever the old
     * one's sliders and XY pads were still aimed at.
     *
     * Returns how many references went.
     */
    int forgetFixture(QStringList &sections, quint32 fixtureId);

    /**
     * Give an id to every widget that has none.
     *
     * QLC+ 4 wrote no ID attribute at all -- the console shipped with QLC+ to
     * this day has not one -- and assigned ids in memory on load instead. Every
     * edit here addresses a widget by id, so those projects are not partly
     * editable, they are entirely uneditable until this has run.
     *
     * Nothing else about the widgets changes, and ids already present are left
     * exactly as they are.
     */
    Result assignIds(QStringList &sections, int &assigned);

    /** The lowest widget id the console is not already using. */
    QString nextFreeId(const XmlNode &console);

    /**
     * The Grand Master settings the console carries, in QLC+'s own strings.
     *
     * They live in <VirtualConsole><Properties><GrandMaster>, a preserved
     * section this daemon used to carry without reading -- which meant a
     * project saved with Limit/All ran here as Reduce/Intensity, silently.
     * Defaults match QLC+'s when the project says nothing.
     */
    struct GrandMasterSettings
    {
        QString channelMode = QStringLiteral("Intensity"); /**< "Intensity" | "All" */
        QString valueMode = QStringLiteral("Reduce");      /**< "Reduce" | "Limit" */
        bool visible = true;

        /** The external control bound to the Grand Master, read from the
         *  <Input> child. Read for the router and reported; written only by
         *  writeGrandMasterInput, never as a side effect of the modes. */
        bool hasInput = false;
        quint32 inputUniverse = 0;
        quint32 inputChannel = 0;
    };

    GrandMasterSettings readGrandMaster(const QStringList &sections);

    /**
     * Persist the settings back into <Properties><GrandMaster>, creating
     * either node if the project never had one. Attributes QLC+ wrote that
     * this daemon does not model (the external input binding, the slider
     * mode) stay exactly as they are.
     */
    Result writeGrandMaster(QStringList &sections, const GrandMasterSettings &settings);

    /**
     * Bind (or, with bind = false, unbind) the external control that moves
     * the Grand Master: the <Input> child of <Properties><GrandMaster>.
     * Separate from writeGrandMaster on purpose, so changing the modes can
     * never quietly rewrite a binding.
     */
    Result writeGrandMasterInput(QStringList &sections, bool bind, quint32 universe,
                                 quint32 channel);
}

#endif // VCPATCH_H
