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

#include <QString>

class Doc;

/** The root element of a .qxw project file. Kept identical to QLC+ on purpose:
 *  project files must stay interchangeable between both applications. */
#define KXMLQLCWorkspace QStringLiteral("Workspace")

/**
 * Loads QLC+ project files (.qxw) into a Doc without any UI involvement.
 *
 * Only the engine-owned part of the document is read here. Virtual Console and
 * Simple Desk sections live outside Doc in QLC+ and are handled separately.
 */
class WorkspaceLoader
{
public:
    /** Populate the fixture definition cache from the system and user
     *  directories. Returns the number of definitions loaded. */
    static int loadFixtureDefinitions(Doc *doc);

    /** Load a .qxw file into doc. Returns true on success and leaves a
     *  human-readable reason in errorMessage on failure. */
    static bool load(Doc *doc, const QString &fileName, QString &errorMessage);
};

#endif // WORKSPACELOADER_H
