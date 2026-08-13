/*
  OrchidLights
  consolelayout.h

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

#ifndef CONSOLELAYOUT_H
#define CONSOLELAYOUT_H

#include <QStringList>
#include <QJsonObject>
#include <QString>
#include <QVector>

/** The element this daemon adds to a .qxw to remember its own layout. */
#define KXMLOrchidLayout QStringLiteral("OrchidLightsLayout")

/**
 * Where OrchidLights remembers how the operator arranged the console.
 *
 * QLC+ stores widget positions as absolute pixels, which is the thing this
 * project exists to get away from. Rewriting <VirtualConsole> to store rows
 * instead would break the file for QLC+ and risk dropping the parts of it we
 * do not model, so the arrangement lives in a section of our own alongside it.
 *
 * Verified against QLC+ 5.2.1: it reports
 *
 *     Unknown Workspace tag: "OrchidLightsLayout"
 *
 * and carries on loading the project normally.
 *
 * The asymmetry is worth knowing about: QLC+ does not preserve sections it does
 * not understand, so saving the project *from QLC+* drops this one and the
 * console falls back to its geometry-derived arrangement. Nothing is lost but
 * the ordering, and it is the same fallback a project that never had a layout
 * gets.
 */
class ConsoleLayout
{
public:
    struct Page
    {
        quint32 id = 0;
        /** Rows of widget ids, in the order the operator put them. */
        QVector<QVector<quint32>> rows;
    };

    /** Read the layout out of the project's preserved sections. Returns false
     *  when the project carries none, which is the normal case. */
    static bool parse(const QStringList &preservedSections, QVector<Page> &pages);

    /** Serialise to the XML fragment that goes into the project file. */
    static QString toXml(const QVector<Page> &pages);

    /** The wire format: { "pages": [ { "id": n, "rows": [[id, ...], ...] } ] }. */
    static QJsonObject toJson(const QVector<Page> &pages);
    static bool fromJson(const QJsonObject &json, QVector<Page> &pages, QString &errorMessage);

    /** True when the section is ours, so a save can replace it rather than
     *  re-emitting the copy that was read in. */
    static bool isLayoutSection(const QString &section);
};

#endif // CONSOLELAYOUT_H
