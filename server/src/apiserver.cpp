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
#include <QJsonDocument>
#include <QHttpServerRequest>
#include <QUrlQuery>
#include <QFileInfo>
#include <QDir>

#include "apiserver.h"
#include "enginehost.h"
#include "jsonview.h"
#include "livefeed.h"
#include "virtualconsole.h"
#include "consolelayout.h"
#include "docwriter.h"
#include "qlcfixturedefcache.h"
#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "fixturegroup.h"
#include "fixture.h"
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

    /* Read-only routes are pinned to GET. A route registered without a method
       answers every verb, which is not merely untidy: it is how the layout's
       GET handler quietly swallowed its own PUT, returning the old value and
       persisting nothing.

       The web interface, served from the same origin as the API so a browser
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

    m_server->route("/api/v1/status", QHttpServerRequest::Method::Get, [this, doc, denied](const QHttpServerRequest &request) {
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

    m_server->route("/api/v1/fixtures", QHttpServerRequest::Method::Get, [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::fixtures(doc));
    });

    m_server->route("/api/v1/functions", QHttpServerRequest::Method::Get, [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::functions(doc));
    });

    m_server->route("/api/v1/universes", QHttpServerRequest::Method::Get, [doc, denied](const QHttpServerRequest &request) {
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
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

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
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

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
    m_server->route("/api/v1/vc", QHttpServerRequest::Method::Get, [this, denied](const QHttpServerRequest &request) {
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

    /* What a universe can be patched to. Without this the operator would be
       guessing at plugin and line names, which the writer then refuses. */
    /* The fixture library. 1735 definitions is far too many to hand over in one
       response, so this answers manufacturers, then models, then modes -- the
       same three steps an operator takes when patching. */
    m_server->route("/api/v1/library", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QString search = QUrlQuery(request.url().query())
                                   .queryItemValue(QStringLiteral("q")).trimmed();

        QJsonArray manufacturers;
        for (const QString &name : doc->fixtureDefCache()->manufacturers())
        {
            if (search.isEmpty() == false
                && name.contains(search, Qt::CaseInsensitive) == false)
                continue;
            manufacturers.append(name);
        }

        QJsonObject body;
        body["manufacturers"] = manufacturers;
        body["total"] = doc->fixtureDefCache()->manufacturers().count();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/library/<arg>", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &manufacturer, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QStringList models = doc->fixtureDefCache()->models(manufacturer);
        if (models.isEmpty())
            return jsonError(StatusCode::NotFound, QStringLiteral("No such manufacturer"));

        QJsonArray array;
        for (const QString &model : models)
            array.append(model);

        QJsonObject body;
        body["manufacturer"] = manufacturer;
        body["models"] = array;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/library/<arg>/<arg>", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &manufacturer, const QString &model,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QLCFixtureDef *definition = doc->fixtureDefCache()->fixtureDef(manufacturer, model);
        if (definition == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such fixture definition"));

        QJsonArray modes;
        for (QLCFixtureMode *mode : definition->modes())
        {
            QJsonObject entry;
            entry["name"] = mode->name();
            entry["channels"] = mode->channels().count();
            modes.append(entry);
        }

        QJsonObject body;
        body["manufacturer"] = definition->manufacturer();
        body["model"] = definition->model();
        body["type"] = definition->type();
        body["modes"] = modes;
        return QHttpServerResponse(body);
    });

    /* The 512 channels of a universe and who holds them. This is the view that
       makes a clash obvious before it becomes a light that will not respond. */
    m_server->route("/api/v1/universes/<arg>/map", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &rawIndex, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int index = rawIndex.toInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a number"));

        const int count = int(doc->inputOutputMap()->universesCount());
        if (index < 1 || index > count)
        {
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("Universe %1 does not exist; this project has %2")
                                 .arg(index).arg(count));
        }

        QJsonArray occupants;
        int used = 0;

        for (const Fixture *fixture : doc->fixtures())
        {
            if (int(fixture->universe()) != index - 1)
                continue;

            QJsonObject entry;
            entry["id"] = qint64(fixture->id());
            entry["name"] = fixture->name();
            entry["address"] = qint64(fixture->address()) + 1;
            entry["channels"] = qint64(fixture->channels());
            occupants.append(entry);
            used += int(fixture->channels());
        }

        QJsonObject body;
        body["universe"] = index;
        body["used"] = used;
        body["free"] = 512 - used;
        body["fixtures"] = occupants;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/fixtures", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        DocWriter::FixturePlacement placement;
        placement.manufacturer = body.value("manufacturer").toString();
        placement.model = body.value("model").toString();
        placement.mode = body.value("mode").toString();
        placement.name = body.value("name").toString();
        placement.universe = body.value("universe").toInt(1);
        placement.address = body.value("address").toInt(1);
        placement.quantity = body.value("quantity").toInt(1);
        placement.gap = body.value("gap").toInt(0);

        QList<quint32> ids;
        const DocWriter::Result result =
            m_engine->withFixturesLocked([&] { return DocWriter::addFixtures(doc, placement, ids); });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonArray created;
        for (quint32 id : ids)
            created.append(qint64(id));

        QJsonObject response;
        response["created"] = created;
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/fixtures/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const DocWriter::Result result =
            m_engine->withFixturesLocked([&] { return DocWriter::removeFixture(doc, id); });
        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject body;
        body["removed"] = qint64(id);
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/fixtures/<arg>", QHttpServerRequest::Method::Patch,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject patch = QJsonDocument::fromJson(request.body()).object();

        const DocWriter::Result result = m_engine->withFixturesLocked([&] {
            return DocWriter::updateFixture(doc, id, patch.value("name").toString(),
                                            patch.value("universe").toInt(-1),
                                            patch.value("address").toInt(-1));
        });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        const Fixture *fixture = doc->fixture(id);
        return QHttpServerResponse(fixture ? JsonView::fixture(fixture) : QJsonObject());
    });

    m_server->route("/api/v1/fixture-groups", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray groups;
        for (const FixtureGroup *group : doc->fixtureGroups())
        {
            QJsonArray members;
            for (quint32 id : group->fixtureList())
                members.append(qint64(id));

            QJsonObject entry;
            entry["id"] = qint64(group->id());
            entry["name"] = group->name();
            entry["fixtures"] = members;
            groups.append(entry);
        }

        return QHttpServerResponse(groups);
    });

    m_server->route("/api/v1/fixture-groups", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        QList<quint32> members;
        for (const QJsonValue &value : body.value("fixtures").toArray())
        {
            if (value.isDouble() == false || value.toInt(-1) < 0)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Fixture ids must be non-negative numbers"));
            }
            members.append(quint32(value.toInt()));
        }

        quint32 groupId = 0;
        const DocWriter::Result result =
            DocWriter::addFixtureGroup(doc, body.value("name").toString(), members, groupId);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(groupId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/fixture-groups/<arg>", QHttpServerRequest::Method::Patch,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Group id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        /* Absent is not empty. A PATCH that forgot the key, or a malformed
           body, would otherwise read as "remove every fixture from this
           group". */
        if (body.value("fixtures").isArray() == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send a \"fixtures\" array. To empty the group, "
                                            "send an empty one."));
        }

        QList<quint32> members;
        for (const QJsonValue &value : body.value("fixtures").toArray())
        {
            if (value.isDouble() == false || value.toInt(-1) < 0)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Fixture ids must be non-negative numbers"));
            }
            members.append(quint32(value.toInt()));
        }

        const DocWriter::Result result = DocWriter::setFixtureGroupMembers(doc, id, members);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        response["fixtures"] = body.value("fixtures");
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/fixture-groups/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Group id must be a number"));

        const DocWriter::Result result = DocWriter::removeFixtureGroup(doc, id);
        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject response;
        response["removed"] = qint64(id);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/io", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        InputOutputMap *map = doc->inputOutputMap();

        const auto describe = [&](const QStringList &plugins, bool outputs) {
            QJsonArray array;
            for (const QString &name : plugins)
            {
                QJsonArray lines;
                for (const QString &line : (outputs ? map->pluginOutputs(name)
                                                    : map->pluginInputs(name)))
                    lines.append(line);

                QJsonObject plugin;
                plugin["name"] = name;
                plugin["lines"] = lines;
                array.append(plugin);
            }
            return array;
        };

        QJsonArray profiles;
        for (const QString &name : map->profileNames())
            profiles.append(name);

        QJsonObject body;
        body["outputPlugins"] = describe(map->outputPluginNames(), true);
        body["inputPlugins"] = describe(map->inputPluginNames(), false);
        body["inputProfiles"] = profiles;
        return QHttpServerResponse(body);
    });

    const auto writeResult = [](const DocWriter::Result &result, const QJsonObject &body) {
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);
        return QHttpServerResponse(body);
    };

    m_server->route("/api/v1/universes", QHttpServerRequest::Method::Post,
                    [this, doc, denied, writeResult](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonObject body;
        body["universes"] = int(doc->inputOutputMap()->universesCount()) + 1;
        return writeResult(DocWriter::addUniverse(doc), body);
    });

    m_server->route("/api/v1/universes/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied, writeResult](const QString &rawIndex, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int index = rawIndex.toInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a number"));

        QJsonObject body;
        body["removed"] = index;
        return writeResult(DocWriter::removeUniverse(doc, index), body);
    });

    m_server->route("/api/v1/universes/<arg>", QHttpServerRequest::Method::Patch,
                    [doc, denied, writeResult](const QString &rawIndex, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int index = rawIndex.toInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a number"));

        const QJsonObject patch = QJsonDocument::fromJson(request.body()).object();

        if (patch.contains("name"))
        {
            const DocWriter::Result result =
                DocWriter::renameUniverse(doc, index, patch.value("name").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("passthrough"))
        {
            const DocWriter::Result result =
                DocWriter::setPassthrough(doc, index, patch.value("passthrough").toBool());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("output"))
        {
            const QJsonObject output = patch.value("output").toObject();
            const DocWriter::Result result =
                DocWriter::setOutputPatch(doc, index, output.value("plugin").toString(),
                                          output.value("line").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("input"))
        {
            const QJsonObject input = patch.value("input").toObject();
            const DocWriter::Result result =
                DocWriter::setInputPatch(doc, index, input.value("plugin").toString(),
                                         input.value("line").toString(),
                                         input.value("profile").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        return QHttpServerResponse(JsonView::universes(doc));
    });

    m_server->route("/api/v1/layout", QHttpServerRequest::Method::Get, [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        return QHttpServerResponse(ConsoleLayout::toJson(m_engine->layout()));
    });

    m_server->route("/api/v1/layout", QHttpServerRequest::Method::Put,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(request.body(), &parseError);
        if (parseError.error != QJsonParseError::NoError || document.isObject() == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Expected a JSON object"));
        }

        QVector<ConsoleLayout::Page> pages;
        QString errorMessage;
        if (ConsoleLayout::fromJson(document.object(), pages, errorMessage) == false)
            return jsonError(StatusCode::BadRequest, errorMessage);

        m_engine->setLayout(pages);

        /* Held in memory until the project is saved, like every other edit. An
           arrangement that wrote itself to disk on every drag would be a
           surprise the first time someone rearranged a show they did not mean
           to change. */
        QJsonObject body = ConsoleLayout::toJson(pages);
        body["saved"] = false;
        body["note"] = QStringLiteral("Kept in memory; POST /api/v1/project/save to write it.");
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project", QHttpServerRequest::Method::Get, [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        body["name"] = QFileInfo(m_engine->projectPath()).fileName();
        body["directory"] = m_engine->projectsDirectory();
        body["modified"] = doc->isModified();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/projects", QHttpServerRequest::Method::Get, [this, denied](const QHttpServerRequest &request) {
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
