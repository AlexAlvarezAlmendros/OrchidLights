/*
  OrchidLights
  main.cpp

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

#include <QCommandLineParser>
#include <QGuiApplication>
#include <QTextStream>

#include "workspaceloader.h"
#include "fixturelibrary.h"
#include "qlcconfig.h"
#include "qlcfile.h"
#include "doc.h"
#include "fixture.h"
#include "function.h"
#include "inputoutputmap.h"

/*
 * F0 scaffolding.
 *
 * At this stage the daemon only proves the point that matters before any API
 * work begins: the QLC+ engine can be driven with no user interface at all.
 * It loads a project, reports what is inside it and exits.
 *
 * The HTTP and WebSocket servers land in F1.
 */

int main(int argc, char **argv)
{
    /* QGuiApplication, not QCoreApplication: the engine pulls in QColor, QImage
       and QPainter. No window is ever created. */
    QGuiApplication app(argc, argv);

    QGuiApplication::setOrganizationName(QStringLiteral("orchidlights"));
    QGuiApplication::setApplicationName(QStringLiteral(APPNAME));
    QGuiApplication::setApplicationVersion(QStringLiteral(APPVERSION));

    /* Tells the engine there is no window manager around, so it never tries to
       raise dialogs at us. */
    QLCFile::setHasWindowManager(false);

    QCommandLineParser parser;
    parser.setApplicationDescription(
        QStringLiteral("OrchidLights lighting daemon - headless QLC+ engine with a web API"));
    parser.addHelpOption();
    parser.addVersionOption();
    parser.addPositionalArgument(QStringLiteral("project"),
                                 QStringLiteral("Project file to open (.qxw)"));

    QCommandLineOption fixturesOption(
        QStringLiteral("fixtures"),
        QStringLiteral("Directory holding the system fixture library "
                       "(the one containing FixturesMap.xml)."),
        QStringLiteral("dir"));
    parser.addOption(fixturesOption);

    parser.process(app);

    QTextStream out(stdout);
    QTextStream err(stderr);

    out << APPNAME << " " << APPVERSION << Qt::endl;

    Doc doc(nullptr);

    const FixtureLibrary::Result library =
        FixtureLibrary::load(&doc, parser.value(fixturesOption));

    out << "Fixture library: " << library.manufacturers << " manufacturers" << Qt::endl;
    if (library.systemPath.isEmpty())
    {
        err << "WARNING: no system fixture library found. Every patched fixture will "
               "fall back to a generic dimmer, losing its channel definitions. "
               "Pass --fixtures <dir> or set ORCHID_FIXTURE_DIR." << Qt::endl;
    }
    else
    {
        out << "  system: " << library.systemPath << Qt::endl;
    }
    for (const QString &path : library.userPaths)
        out << "  user:   " << path << Qt::endl;

    const QStringList args = parser.positionalArguments();
    if (args.isEmpty())
    {
        out << "No project given. Nothing to do yet -- the API server arrives in F1." << Qt::endl;
        return 0;
    }

    QString errorMessage;
    if (WorkspaceLoader::load(&doc, args.first(), errorMessage) == false)
    {
        err << "Failed to load project: " << errorMessage << Qt::endl;
        return 1;
    }

    out << "Project: " << args.first() << Qt::endl;
    out << "Universes: " << doc.inputOutputMap()->universesCount() << Qt::endl;

    out << "Fixtures: " << doc.fixtures().count() << Qt::endl;
    for (Fixture *fixture : doc.fixtures())
    {
        out << "  U" << (fixture->universe() + 1)
            << " @ " << (fixture->address() + 1)
            << "-" << (fixture->address() + fixture->channels())
            << "  " << fixture->name() << Qt::endl;
    }

    const QList<Function *> functions = doc.functions();
    out << "Functions: " << functions.count() << Qt::endl;
    for (Function *function : functions)
    {
        out << "  [" << Function::typeToString(function->type()) << "] "
            << function->name() << Qt::endl;
    }

    /* Doc records every fixture whose definition or mode could not be resolved.
       Those fixtures still appear above, patched at the right address, but they
       are backed by a generic dimmer -- no channel names, no capabilities. That
       is silent data loss unless it is reported. */
    const QString errorLog = doc.errorLog();
    if (errorLog.isEmpty() == false)
    {
        err << Qt::endl << "Project loaded with unresolved definitions:" << Qt::endl;
        err << errorLog << Qt::endl;
        return 2;
    }

    return 0;
}
