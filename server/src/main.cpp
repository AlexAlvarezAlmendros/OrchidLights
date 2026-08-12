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
    parser.process(app);

    QTextStream out(stdout);
    QTextStream err(stderr);

    out << APPNAME << " " << APPVERSION << Qt::endl;

    Doc doc(nullptr);

    const int manufacturers = WorkspaceLoader::loadFixtureDefinitions(&doc);
    out << "Fixture library: " << manufacturers << " manufacturers" << Qt::endl;

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

    return 0;
}
