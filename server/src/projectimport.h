/*
  OrchidLights
  projectimport.h

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

#ifndef PROJECTIMPORT_H
#define PROJECTIMPORT_H

#include <QJsonObject>
#include <QList>
#include <QString>

#include "docwriter.h"

class Doc;

/**
 * Selective import from another project file, ported from
 * qmlui/importmanager.cpp.
 *
 * The foreign .qxw is loaded into a scratch Doc that shares the live one's
 * definition cache, then the chosen fixtures and functions are copied across
 * with every id remapped: fixtures land on their old address when it is free
 * and on the first hole big enough when it is not, a fixture or group or
 * palette with a matching NAME is reused rather than duplicated, and
 * functions are imported dependencies-first so a chaser's steps point at the
 * remapped scenes.
 *
 * Two of the reference's slips are ported fixed: EFX heads are remapped
 * through the FIXTURE map (the original reads the function map), and a
 * sequence's per-step values follow the fixtures like a scene's do (the
 * original leaves them pointing at the foreign ids).
 */
class ProjectImport final
{
public:
    struct Selection
    {
        bool allFixtures = false;
        QList<quint32> fixtures;
        bool allFunctions = false;
        QList<quint32> functions;
    };

    /** What the file offers, so somebody can choose. */
    static DocWriter::Result preview(Doc *doc, const QString &path, QJsonObject &out);

    /** Copy the chosen pieces across. The report says what landed where. */
    static DocWriter::Result apply(Doc *doc, const QString &path, const Selection &selection,
                                   QJsonObject &report);

private:
    ProjectImport() = delete;
};

#endif
