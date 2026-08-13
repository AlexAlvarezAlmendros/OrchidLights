/*
  OrchidLights
  apiserver.cpp

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

#include <QHttpServerResponse>
#include <QHttpServer>
#include <QHostAddress>
#include <QJsonObject>
#include <QJsonArray>
#include <QFileInfo>
#include <QDir>

#include "apiserver.h"
#include "enginehost.h"
#include "jsonview.h"
#include "livefeed.h"
#include "virtualconsole.h"
#include "installpaths.h"
#include "qlcconfig.h"

#include "functionparent.h"
#include "inputoutputmap.h"
#include "mastertimer.h"
#include "function.h"
#include "doc.h"

using StatusCode = QHttpServerResponder::StatusCode;

namespace
{
    QHttpServerResponse jsonError(StatusCode code, const QString &message)
    {
        QJsonObject body;
        body["error"] = message;
        return QHttpServerResponse(body, code);
    }

    QHttpServerResponse unauthorized()
    {
        return jsonError(StatusCode::Unauthorized,
                         QStringLiteral("Send Authorization: Bearer <token>. "
                                        "The token is in the api-token file of the "
                                        "user data directory."));
    }

    /** A command was queued on the engine. Deliberately carries no state: see
        the note on the function routes. */
    QJsonObject acknowledge(const Function *function, const QString &requested)
    {
        QJsonObject body;
        body["id"] = qint64(function->id());
        body["name"] = function->name();
        body["requested"] = requested;
        body["note"] = QStringLiteral(
            "Queued on the engine; observe the result with GET /api/v1/functions.");
        return body;
    }
}

ApiServer::ApiServer(EngineHost *engine, QObject *parent)
    : QObject(parent)
    , m_engine(engine)
{
    Q_ASSERT(engine != nullptr);
}

ApiServer::~ApiServer() = default;

bool ApiServer::start(const Options &options, QString &errorMessage)
{
    Q_ASSERT(m_server == nullptr);

    if (m_auth.load(errorMessage) == false)
        return false;

    /* Reaching beyond loopback always demands the token; on loopback it is
       opt-in, because there the operating system is already the boundary. */
    m_auth.setRequired(options.listenAll || options.requireAuth);

    m_server = new QHttpServer(this);
    m_listenAll = options.listenAll;

    registerRoutes();

    /* The live feed shares the port: QAbstractHttpServer hands over sockets
       that ask to upgrade, so a browser needs one origin and one open port. */
    m_feed = new LiveFeed(m_engine, &m_auth, this);
    m_feed->setStreamRate(options.streamRate);
    m_feed->attach(m_server);

    const QHostAddress address = options.listenAll ? QHostAddress::Any
                                                   : QHostAddress::LocalHost;

    m_port = m_server->listen(address, options.port);
    if (m_port == 0)
    {
        errorMessage = QStringLiteral("Could not listen on %1:%2")
                           .arg(address.toString())
                           .arg(options.port);
        return false;
    }

    return true;
}

QString ApiServer::url() const
{
    if (m_port == 0)
        return QString();

    return QStringLiteral("http://%1:%2")
        .arg(m_listenAll ? QStringLiteral("0.0.0.0") : QStringLiteral("127.0.0.1"))
        .arg(m_port);
}

void ApiServer::registerRoutes()
{
    Doc *doc = m_engine->doc();

    /* Repeated at the top of every /api handler rather than hidden in a
       wrapper: Qt 6.4's QHttpServer has no middleware, and a route that
       silently forgets its check is the kind of bug that only shows up when
       someone else is on the network. One grep finds them all. */
    const auto denied = [this](const QHttpServerRequest &request) {
        return m_auth.authorize(request) == false;
    };

    /* The web interface, served from the same origin as the API so a browser
       needs no CORS and the operator needs one URL.
     *
     * Deliberately not a catch-all route: /<arg> would also swallow /api and
     * /ws. The built app is a single page with hashless routing, so index.html
     * plus the asset directory is the whole surface. */
    const QString webRoot = InstallPaths::webRoot();

    if (webRoot.isEmpty())
    {
        m_server->route("/", [this]() {
            QJsonObject body;
            body["name"] = QStringLiteral(APPNAME);
            body["version"] = QStringLiteral(APPVERSION);
            body["api"] = QStringLiteral("/api/v1");
            body["ui"] = QStringLiteral("not built; run pnpm build in web/");
            return QHttpServerResponse(body);
        });
    }
    else
    {
        m_server->route("/", [webRoot]() {
            return QHttpServerResponse::fromFile(QDir(webRoot).absoluteFilePath(
                QStringLiteral("index.html")));
        });

        m_server->route("/assets/<arg>", [webRoot](const QString &name) {
            /* Vite writes hashed names into assets/ and nothing else, but the
               name still arrives from the network: refuse anything that could
               climb out of the directory rather than trusting the generator. */
            if (name.contains(QChar('/')) || name.contains(QStringLiteral("..")))
                return jsonError(StatusCode::BadRequest, QStringLiteral("Bad asset name"));

            const QString path = QDir(webRoot).absoluteFilePath(
                QStringLiteral("assets/") + name);

            if (QFileInfo::exists(path) == false)
                return jsonError(StatusCode::NotFound, QStringLiteral("No such asset"));

            return QHttpServerResponse::fromFile(path);
        });
    }

    m_server->route("/api/v1/status", [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonObject body;
        body["name"] = QStringLiteral(APPNAME);
        body["version"] = QStringLiteral(APPVERSION);
        body["apiVersion"] = 1;
        body["fixtureLibrary"] = m_engine->fixtureLibraryPath();
        body["manufacturers"] = m_engine->manufacturerCount();

        QJsonArray plugins;
        for (const QString &name : m_engine->loadedPlugins())
            plugins.append(name);
        body["outputPlugins"] = plugins;

        QJsonArray audio;
        for (const QString &format : m_engine->audioFormats())
            audio.append(format);
        body["audioFormats"] = audio;

        body["fixtures"] = doc->fixtures().count();
        body["functions"] = doc->functions().count();
        body["universes"] = int(doc->inputOutputMap()->universesCount());
        body["runningFunctions"] = doc->masterTimer()->runningFunctions();

        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/fixtures", [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::fixtures(doc));
    });

    m_server->route("/api/v1/functions", [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::functions(doc));
    });

    m_server->route("/api/v1/universes", [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::universes(doc));
    });

    /* Both of these answer 202, not 200, and report the request rather than the
       state.
     *
     * Function::start() appends to the MasterTimer's start queue and the
     * transition happens on the next tick, 20 ms later. Serialising the
     * function here would hand the caller the state from *before* the command
     * -- a POST /start replying "running": false, which reads as a failure.
     * The engine is asynchronous, so the API says "accepted" and the caller
     * observes the result through GET /functions. */
    m_server->route("/api/v1/functions/<arg>/start",
                    QHttpServerRequest::Method::Post,
                    [doc, denied](quint32 id, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        Function *function = doc->function(id);
        if (function == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        if (function->isRunning() == false)
            function->start(doc->masterTimer(), FunctionParent::master());

        return QHttpServerResponse(acknowledge(function, QStringLiteral("start")),
                                   StatusCode::Accepted);
    });

    m_server->route("/api/v1/functions/<arg>/stop",
                    QHttpServerRequest::Method::Post,
                    [doc, denied](quint32 id, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        Function *function = doc->function(id);
        if (function == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        if (function->isRunning())
            function->stop(FunctionParent::master());

        return QHttpServerResponse(acknowledge(function, QStringLiteral("stop")),
                                   StatusCode::Accepted);
    });

    /* Read only, and parsed out of the very XML we preserve, so serving it
       cannot disturb what goes back into the file. */
    m_server->route("/api/v1/vc", [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        VcWidget root;
        if (VirtualConsole::parse(m_engine->preservedSections(), root) == false)
        {
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("This project has no Virtual Console"));
        }

        return QHttpServerResponse(JsonView::vcWidget(root));
    });

    m_server->route("/api/v1/project", [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        body["name"] = QFileInfo(m_engine->projectPath()).fileName();
        body["directory"] = m_engine->projectsDirectory();
        body["modified"] = doc->isModified();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/projects", [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray names;
        for (const QString &name : m_engine->availableProjects())
            names.append(name);

        QJsonObject body;
        body["directory"] = m_engine->projectsDirectory();
        body["projects"] = names;
        return QHttpServerResponse(body);
    });

    /* Load and save take a file name inside the projects directory, never a
       path. Accepting a path would hand whoever holds the token an
       arbitrary-file-write primitive, which is not a trade a lighting desk
       should make for the convenience of it. */
    m_server->route("/api/v1/project/load/<arg>",
                    QHttpServerRequest::Method::Post,
                    [this, denied](const QString &name, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QString path = m_engine->resolveProjectName(name);
        if (path.isEmpty())
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Give a .qxw file name inside the projects "
                                            "directory, not a path"));
        }

        QString errorMessage;
        if (m_engine->loadProject(path, errorMessage) == false)
            return jsonError(StatusCode::NotFound, errorMessage);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        body["unresolved"] = m_engine->projectErrors();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project/save",
                    QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QString errorMessage;
        if (m_engine->saveProject(QString(), errorMessage) == false)
            return jsonError(StatusCode::Conflict, errorMessage);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project/save/<arg>",
                    QHttpServerRequest::Method::Post,
                    [this, denied](const QString &name, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QString path = m_engine->resolveProjectName(name);
        if (path.isEmpty())
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Give a .qxw file name inside the projects "
                                            "directory, not a path"));
        }

        QString errorMessage;
        if (m_engine->saveProject(path, errorMessage) == false)
            return jsonError(StatusCode::Conflict, errorMessage);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        return QHttpServerResponse(body);
    });

    /* The one control every lighting desk has a physical button for. */
    m_server->route("/api/v1/blackout", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        doc->masterTimer()->stopAllFunctions();
        doc->inputOutputMap()->setBlackout(true);

        QJsonObject body;
        body["blackout"] = true;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/blackout", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        doc->inputOutputMap()->setBlackout(false);

        QJsonObject body;
        body["blackout"] = false;
        return QHttpServerResponse(body);
    });
}
