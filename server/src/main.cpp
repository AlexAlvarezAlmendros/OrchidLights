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

#include "enginehost.h"
#include "apiserver.h"
#include "qlcconfig.h"
#include "qlcfile.h"
#include "doc.h"
#include "fixture.h"
#include "function.h"
#include "inputoutputmap.h"

namespace
{
    void report(QTextStream &out, const EngineHost &engine)
    {
        out << "Fixture library: " << engine.manufacturerCount() << " manufacturers" << Qt::endl;
        out << "  system: " << engine.fixtureLibraryPath() << Qt::endl;
        for (const QString &path : engine.userFixturePaths())
            out << "  user:   " << path << Qt::endl;

        if (engine.pluginPath().isEmpty())
        {
            out << "Output plugins: none" << Qt::endl;
        }
        else
        {
            out << "Output plugins: " << engine.loadedPlugins().count()
                << " from " << engine.pluginPath() << Qt::endl;
            for (const QString &name : engine.loadedPlugins())
                out << "  " << name << Qt::endl;
        }
    }

    void describeProject(QTextStream &out, Doc *doc, const QString &fileName)
    {
        out << "Project: " << fileName << Qt::endl;
        out << "Universes: " << doc->inputOutputMap()->universesCount() << Qt::endl;

        out << "Fixtures: " << doc->fixtures().count() << Qt::endl;
        for (Fixture *fixture : doc->fixtures())
        {
            out << "  U" << (fixture->universe() + 1)
                << " @ " << (fixture->address() + 1)
                << "-" << (fixture->address() + fixture->channels())
                << "  " << fixture->name() << Qt::endl;
        }

        const QList<Function *> functions = doc->functions();
        out << "Functions: " << functions.count() << Qt::endl;
        for (Function *function : functions)
        {
            out << "  [" << Function::typeToString(function->type()) << "] "
                << function->name() << Qt::endl;
        }
    }
}

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

    QCommandLineOption pluginsOption(
        QStringLiteral("plugins"),
        QStringLiteral("Directory holding the input/output plugins."),
        QStringLiteral("dir"));
    parser.addOption(pluginsOption);

    QCommandLineOption noOutputOption(
        QStringLiteral("no-output"),
        QStringLiteral("Do not load the output plugins. The engine still runs and "
                       "functions still execute, but no DMX reaches the network."));
    parser.addOption(noOutputOption);

    QCommandLineOption checkOption(
        QStringLiteral("check"),
        QStringLiteral("Load the project, report it and exit instead of staying up."));
    parser.addOption(checkOption);

    QCommandLineOption portOption(
        QStringLiteral("port"),
        QStringLiteral("Port for the web API (default 9998)."),
        QStringLiteral("number"),
        QStringLiteral("9998"));
    parser.addOption(portOption);

    QCommandLineOption listenAllOption(
        QStringLiteral("listen-all"),
        QStringLiteral("Serve on every network interface instead of loopback only. "
                       "There is no authentication yet, so anything that can reach "
                       "the port can black out the room."));
    parser.addOption(listenAllOption);

    parser.process(app);

    QTextStream out(stdout);
    QTextStream err(stderr);

    out << APPNAME << " " << APPVERSION << Qt::endl;

    EngineHost::Options options;
    options.fixtureDirectory = parser.value(fixturesOption);
    options.pluginDirectory = parser.value(pluginsOption);
    options.noOutput = parser.isSet(noOutputOption);

    EngineHost engine;
    QString errorMessage;

    if (engine.start(options, errorMessage) == false)
    {
        err << "ERROR: " << errorMessage << Qt::endl;
        return 1;
    }

    report(out, engine);

    if (options.noOutput)
        out << "Output disabled (--no-output): nothing will reach the network." << Qt::endl;
    else if (engine.pluginPath().isEmpty())
        err << "WARNING: no output plugin directory found, so no DMX can be sent. "
               "Install the daemon or set ORCHID_PLUGIN_DIR." << Qt::endl;

    const QStringList args = parser.positionalArguments();
    if (args.isEmpty() == false)
    {
        if (engine.loadProject(args.first(), errorMessage) == false)
        {
            err << "Failed to load project: " << errorMessage << Qt::endl;
            return 1;
        }

        describeProject(out, engine.doc(), args.first());

        /* Doc records every fixture whose definition or mode could not be
           resolved. Those fixtures still appear above, patched at the right
           address, but they are backed by a generic dimmer -- no channel names,
           no capabilities. That is silent data loss unless it is reported. */
        const QString projectErrors = engine.projectErrors();
        if (projectErrors.isEmpty() == false)
        {
            err << Qt::endl << "Project loaded with unresolved definitions:" << Qt::endl;
            err << projectErrors << Qt::endl;
            return 2;
        }
    }

    if (parser.isSet(checkOption))
        return 0;

    bool portOk = false;
    const uint port = parser.value(portOption).toUInt(&portOk);
    if (portOk == false || port == 0 || port > 65535)
    {
        err << "ERROR: --port must be between 1 and 65535" << Qt::endl;
        return 1;
    }

    ApiServer::Options apiOptions;
    apiOptions.port = quint16(port);
    apiOptions.listenAll = parser.isSet(listenAllOption);

    ApiServer api(&engine);
    if (api.start(apiOptions, errorMessage) == false)
    {
        err << "ERROR: " << errorMessage << Qt::endl;
        return 1;
    }

    out << Qt::endl << "API listening on " << api.url() << Qt::endl;
    if (apiOptions.listenAll)
    {
        err << "WARNING: serving on every interface with no authentication. "
               "Anything that can reach this port can black out the room."
            << Qt::endl;
    }

    return app.exec();
}
