/*
  OrchidLights
  workspaceloader.h

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

#ifndef WORKSPACELOADER_H
#define WORKSPACELOADER_H

#include <QStringList>
#include <QString>
#include <QList>
#include <QPair>

class Doc;

/** The root element of a .qxw project file. Kept identical to QLC+ on purpose:
 *  project files must stay interchangeable between both applications. */
#define KXMLQLCWorkspace QStringLiteral("Workspace")

/**
 * Loads and saves QLC+ project files (.qxw) without any UI involvement.
 *
 * A project holds more than the engine owns. Virtual Console and Simple Desk
 * live outside Doc in QLC+, and this daemon has no model for either yet.
 * Writing a file back from what we understand would therefore delete a user's
 * entire Virtual Console -- the layout they built the show on -- and the file
 * would still open cleanly, so nothing would look wrong until the night it
 * mattered.
 *
 * Every section we do not own is kept verbatim across a load/save cycle.
 */
class WorkspaceLoader
{
public:
    /** The parts of a project this daemon does not model, carried unchanged. */
    struct Preserved
    {
        /** Attributes of the <Workspace> element, e.g. CurrentWindow. */
        QList<QPair<QString, QString>> workspaceAttributes;

        /** Raw XML of each child of <Workspace> we do not parse. */
        QStringList sections;
    };

    /** Load a .qxw into doc, capturing what we do not model. Returns true on
     *  success and leaves a human-readable reason in errorMessage otherwise. */
    static bool load(Doc *doc, const QString &fileName,
                     Preserved &preserved, QString &errorMessage);

    /** Write doc back out, re-emitting the preserved sections unchanged. */
    static bool save(const Doc *doc, const QString &fileName,
                     const Preserved &preserved, QString &errorMessage);
};

#endif // WORKSPACELOADER_H
