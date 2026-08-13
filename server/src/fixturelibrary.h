/*
  OrchidLights
  fixturelibrary.h

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

#ifndef FIXTURELIBRARY_H
#define FIXTURELIBRARY_H

#include <QStringList>
#include <QString>

class Doc;

/**
 * Resolves and loads the fixture definition library.
 *
 * QLC+ derives these paths from compile-time constants alone, which fails us in
 * two ways:
 *
 *  - The daemon is normally run straight from the build tree during
 *    development, where nothing has been installed and the system library only
 *    exists under resources/.
 *  - Renaming the user directory to ~/.orchidlights would orphan the custom
 *    .qxf profiles that users already keep in ~/.qlcplus. Those profiles are
 *    frequently the only definition of the hardware actually in the rig, so
 *    losing them silently turns every patched fixture into a generic dimmer.
 */
class FixtureLibrary
{
public:
    struct Result
    {
        int manufacturers = 0;
        /** Where the system library was found. Empty when there is none, which
         *  is a serious condition: fixtures will load without any channel
         *  definitions behind them. */
        QString systemPath;
        /** Every user definition directory that was read, in load order. */
        QStringList userPaths;
    };

    /**
     * Populate doc's fixture definition cache.
     *
     * User definitions are read first so that they win over the system library
     * on conflicts, matching QLC+ behaviour.
     *
     * @param systemOverride explicit system library directory, or empty to
     *                       resolve it automatically.
     */
    static Result load(Doc *doc, const QString &systemOverride = QString());

    /**
     * Directory holding the system library, meaning FixturesMap.xml plus one
     * subdirectory per manufacturer. Empty when none was found.
     *
     * Resolution order: the explicit override, then $ORCHID_FIXTURE_DIR, then
     * the installed location, and finally the source tree relative to the
     * running binary.
     */
    static QString systemDirectory(const QString &override = QString());

    /**
     * Every user definition directory that exists: ours first, the legacy QLC+
     * one after it.
     *
     * Both are read rather than one falling back to the other, because
     * QLCFile::userDirectory() creates our directory on first use -- so a
     * "only if missing" fallback would never fire after the very first run.
     */
    static QStringList userDirectories();
};

#endif // FIXTURELIBRARY_H
