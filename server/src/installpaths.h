/*
  OrchidLights
  installpaths.h

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

#ifndef INSTALLPATHS_H
#define INSTALLPATHS_H

#include <QStringList>
#include <QString>

/**
 * Locates the data the daemon needs at runtime.
 *
 * QLC+ derives these from compile-time constants, which breaks in three ways
 * once the binary is not sitting exactly where it was configured to be:
 *
 *  - On Linux QLCFile::systemDirectory() returns its argument unchanged, so a
 *    relative path resolves against the process working directory rather than
 *    the executable. Our AppRun deliberately preserves the caller's working
 *    directory, so those paths would point wherever the user happened to be.
 *  - An AppImage bakes in the absolute paths of the machine that built it.
 *  - During development nothing is installed at all.
 *
 * Every lookup here therefore ends with candidates anchored to the running
 * executable, and every candidate is confirmed by a marker before being
 * accepted, so a path that merely exists is never mistaken for the real thing.
 */
class InstallPaths
{
public:
    /**
     * Directory holding the system fixture library: FixturesMap.xml plus one
     * subdirectory per manufacturer. Empty when none was found.
     *
     * Order: the override, $ORCHID_FIXTURE_DIR, the compiled-in location,
     * the executable-relative install layouts, then the source tree.
     */
    static QString fixtureLibrary(const QString &override = QString());

    /**
     * Directory holding the input/output plugins. Empty when none was found.
     *
     * Order: the override, $ORCHID_PLUGIN_DIR, the compiled-in location, then
     * the executable-relative install layouts.
     */
    static QString ioPlugins(const QString &override = QString());

    /** Shipped RGB matrix scripts. Empty when none was found. */
    static QString rgbScripts();

    /** Shipped channel modifier templates. Empty when none was found. */
    static QString modifierTemplates();

    /** Shipped input profiles. Empty when none was found. */
    static QString inputProfiles();

    /** The built web interface, i.e. the directory holding index.html.
     *  Empty when it has not been built or installed. */
    static QString webRoot();

    /**
     * The matching directory inside the legacy QLC+ user tree, or empty when
     * absent. `subdir` is the leaf as QLC+ names it on this platform, e.g.
     * "fixtures" or "inputprofiles".
     *
     * Renaming our user directory to ~/.orchidlights would otherwise orphan
     * everything a QLC+ user already has.
     */
    static QString legacyUserDirectory(const QString &subdir);

private:
    /** Candidates for <relative> under the layouts we install into:
     *  <prefix>/bin/exe -> <prefix>/<relative>, and the AppImage's
     *  <AppDir>/usr/bin/exe -> <AppDir>/<relative>. */
    static QStringList anchoredToBinary(const QString &relative);

    /** First candidate that exists and contains a file named marker. */
    static QString firstWithFile(const QStringList &candidates, const QString &marker);

    /** First candidate that exists and holds at least one matching file. */
    static QString firstNonEmpty(const QStringList &candidates, const QString &nameFilter);

    /** The standard chain for a directory shipped under share/orchidlights. */
    static QString shippedData(const QString &compiledPath,
                               const QString &subdir,
                               const QString &nameFilter);
};

#endif // INSTALLPATHS_H
