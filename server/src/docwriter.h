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
}

#endif // DOCWRITER_H
