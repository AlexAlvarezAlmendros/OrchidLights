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
#include <QDateTime>
#include <QSettings>
#include <QHttpServerRequest>
#include <QUrlQuery>
#include <QFileInfo>
#include <QDir>

#include "apiserver.h"
#include "enginehost.h"
#include "levelsource.h"
#include "jsonview.h"
#include "livefeed.h"
#include "virtualconsole.h"
#include "consolelayout.h"
#include "audiotriggers.h"
#include "audioplugincache.h"
#include "audiorenderer.h"
#include "docwriter.h"
#include "projectimport.h"
#include "grouphead.h"
#include "qlcpoint.h"
#include "chaser.h"
#include "chaserstep.h"
#include "collection.h"
#include "show.h"
#include "track.h"
#include "showfunction.h"
#include "script.h"
#include "qlcpalette.h"
#include "scene.h"
#include "audio.h"
#include "audiodecoder.h"
#include <QXmlStreamReader>
#include "rgbalgorithm.h"
#include "qlcfixturedefcache.h"
#include "qlcfixturemode.h"
#include "qlcchannel.h"
#include "qlcfixturedef.h"
#include "fixturegroup.h"
#include "channelmodifier.h"
#include "monitorproperties.h"
#include "qlcmodifierscache.h"
#include "fixture.h"
#include "installpaths.h"
#include "qlcconfig.h"

#include "functionparent.h"
#include "inputoutputmap.h"
#include "mastertimer.h"
#include "qlcinputprofile.h"
#include "qlcinputchannel.h"
#include "keypadparser.h"
#include "simpledesksource.h"
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

    /** The widget carrying this id, anywhere in the console. */
    const VcWidget *findWidget(const VcWidget &node, quint32 id)
    {
        if (node.hasId && node.id == id)
            return &node;

        for (const VcWidget &child : node.children)
        {
            if (const VcWidget *found = findWidget(child, id))
                return found;
        }

        return nullptr;
    }

    /**
     * Read a channels group's channel list out of a request body.
     *
     * Objects rather than a flat list of numbers, even though QLC+ stores the
     * pairs flattened in the file: a list of eight numbers that is really four
     * pairs is a body where dropping one element silently shifts every fixture
     * onto the wrong channel.
     */
    bool readChannels(const QJsonValue &value, QList<QPair<quint32, quint32>> &channels,
                      QString &error)
    {
        if (value.isArray() == false)
        {
            error = QStringLiteral("Send a \"channels\" array of "
                                   "{\"fixture\": id, \"channel\": n} objects");
            return false;
        }

        for (const QJsonValue &entry : value.toArray())
        {
            const QJsonObject object = entry.toObject();
            const QJsonValue fixture = object.value("fixture");
            const QJsonValue channel = object.value("channel");

            if (fixture.isDouble() == false || channel.isDouble() == false
                || fixture.toInt(-1) < 0 || channel.toInt(-1) < 0)
            {
                error = QStringLiteral("Every channel needs a non-negative "
                                       "\"fixture\" and \"channel\"");
                return false;
            }

            channels.append(qMakePair(quint32(fixture.toInt()), quint32(channel.toInt())));
        }

        return true;
    }

    /**
     * Never keep this one.
     *
     * The entry document names the hashed bundle, so a browser that serves it
     * from cache runs whatever bundle it named the day it was cached -- against
     * today's API. That is the failure the service worker's own comment warns
     * about, and it happened anyway because nothing here said not to cache the
     * one file that must not be: no headers at all means the browser applies
     * its own heuristic, and the heuristic for a document with no dates is to
     * keep it.
     *
     * "no-cache" is not "do not store": it stores it and revalidates every
     * time, which is exactly right for a small file that changes with every
     * build.
     */
    void noCache(QHttpServerResponse &response)
    {
        response.setHeader("Cache-Control", "no-cache, must-revalidate");
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

QStringList ApiServer::recentProjects() const
{
    QSettings settings;
    return settings.value(QStringLiteral("recents/projects")).toStringList();
}

void ApiServer::rememberRecent(const QString &path)
{
    QSettings settings;
    QStringList recents = settings.value(QStringLiteral("recents/projects")).toStringList();
    recents.removeAll(path);
    recents.prepend(path);
    while (recents.size() > 10)
        recents.removeLast();
    settings.setValue(QStringLiteral("recents/projects"), recents);
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
            QHttpServerResponse page = QHttpServerResponse::fromFile(
                QDir(webRoot).absoluteFilePath(QStringLiteral("index.html")));
            noCache(page);
            return page;
        });

        /* The three files a browser needs at the root to install the app: the
         * manifest, the icon it names, and the service worker.
         *
         * A service worker is only allowed to control the paths under its own,
         * so /sw.js has to be at the root -- it cannot live in assets/ with
         * everything else. Named one by one rather than served from a
         * directory: this is the only part of the tree where a file name from
         * the network could reach a path, and an allow-list has no traversal to
         * get wrong.
         */
        struct RootFile { const char *path; const char *file; const char *type; };
        static const RootFile rootFiles[] = {
            {"/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"},
            {"/icon.svg", "icon.svg", "image/svg+xml"},
            {"/sw.js", "sw.js", "text/javascript"},
        };

        for (const RootFile &entry : rootFiles)
        {
            const QString file = QString::fromLatin1(entry.file);
            const QString type = QString::fromLatin1(entry.type);

            m_server->route(QString::fromLatin1(entry.path), QHttpServerRequest::Method::Get,
                            [webRoot, file, type]() {
                const QString path = QDir(webRoot).absoluteFilePath(file);
                if (QFileInfo::exists(path) == false)
                    return jsonError(StatusCode::NotFound, QStringLiteral("No such file"));

                QHttpServerResponse response = QHttpServerResponse::fromFile(path);
                response.setHeader("Content-Type", type.toUtf8());
                noCache(response);
                return response;
            });
        }

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

            /* Vite puts the content hash in the name, so this exact file can
               never change: caching it for a year is not a gamble, it is the
               whole point of the hash, and it is what makes a reload on a
               venue's wifi instant. */
            QHttpServerResponse asset = QHttpServerResponse::fromFile(path);
            asset.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            return asset;
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
        body["blackout"] = doc->inputOutputMap()->blackout();

        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/fixtures", QHttpServerRequest::Method::Get, [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();
        return QHttpServerResponse(JsonView::fixtures(doc));
    });

    /* One fixture, with its channels named. The list route deliberately leaves
       them out -- a rig of 30 movers is a thousand channel names nobody asked
       for -- but pointing a fader at "Dimmer" instead of at channel 5 is the
       difference between patching and guessing. */
    m_server->route("/api/v1/fixtures/<arg>", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        Fixture *fixture = doc->fixture(id);
        if (fixture == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such fixture"));

        QJsonObject body = JsonView::fixture(fixture);

        QJsonArray channels;
        for (quint32 i = 0; i < fixture->channels(); i++)
        {
            const QLCChannel *channel = fixture->channel(i);

            QJsonObject entry;
            entry["index"] = qint64(i);
            entry["name"] = channel != nullptr ? channel->name()
                                               : QStringLiteral("Canal %1").arg(i + 1);
            if (channel != nullptr)
                entry["group"] = QLCChannel::groupToString(channel->group());

            /* The modifier bends every value this channel puts out, and it is
               part of the patch rather than of any cue -- so a lamp behaving
               oddly is explained here or nowhere. */
            const ChannelModifier *modifier = fixture->channelModifier(i);
            if (modifier != nullptr)
                entry["modifier"] = modifier->name();

            channels.append(entry);
        }
        body["channelList"] = channels;

        return QHttpServerResponse(body);
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
    m_server->route("/api/v1/vc", QHttpServerRequest::Method::Get, [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        VcWidget root;
        if (VirtualConsole::parse(m_engine->preservedSections(), root) == false)
        {
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("This project has no Virtual Console"));
        }

        return QHttpServerResponse(JsonView::vcWidget(root, doc, m_engine->levels()));
    });

    /* Editing the console. These reach the same preserved XML the route above
       reads, and they patch it -- see VcPatch. Nothing here writes to disk;
       the project is saved by POST /api/v1/project/save, like every other
       edit. */
    /* Every edit addresses a widget by id, and QLC+ 4 wrote none -- the console
       that ships with QLC+ to this day has not one. Such a project is not
       partly editable, it is entirely uneditable until this has run. */
    /* Undo and redo, scoped to the console -- which is what the path says.
     *
     * The console is preserved XML, so undoing is swapping a string back and
     * costs nothing. Undoing a change to Doc would rebuild the document and
     * drop every running function, and a control that can black out a rig is
     * not an undo button whatever it is labelled. */
    m_server->route("/api/v1/vc/undo", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        if (m_engine->undoConsole() == false)
        {
            return jsonError(StatusCode::Conflict,
                             QStringLiteral("There is nothing to undo in this console"));
        }

        QJsonObject body;
        body["undo"] = m_engine->undoDepth();
        body["redo"] = m_engine->redoDepth();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/vc/redo", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        if (m_engine->redoConsole() == false)
        {
            return jsonError(StatusCode::Conflict,
                             QStringLiteral("There is nothing to redo in this console"));
        }

        QJsonObject body;
        body["undo"] = m_engine->undoDepth();
        body["redo"] = m_engine->redoDepth();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/vc/history", QHttpServerRequest::Method::Get,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonObject body;
        body["undo"] = m_engine->undoDepth();
        body["redo"] = m_engine->redoDepth();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/vc/widgets/ids", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        int assigned = 0;
        const VcPatch::Result result = m_engine->assignWidgetIds(assigned);
        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject body;
        body["assigned"] = assigned;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/vc/widgets", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        QString newId;
        /* toVariant() first: a JSON number's toString() is silently empty,
           which parked every "create inside this frame" at the root. */
        const VcPatch::Result result =
            m_engine->addWidget(body.value("type").toString(),
                                body.value("parent").toVariant().toString(),
                                body, newId);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = newId;
        response["type"] = body.value("type").toString().toLower();
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/vc/widgets/<arg>", QHttpServerRequest::Method::Patch,
                    [this, doc, denied](const QString &widgetId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        widgetId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Widget id must be a number"));

        const QJsonObject patch = QJsonDocument::fromJson(request.body()).object();

        const VcPatch::Result result = m_engine->editWidget(widgetId, patch);
        if (result.ok == false)
        {
            /* "No widget with id" is the only one of these that is about the
               thing not existing; the rest are about the request. */
            return jsonError(result.error.startsWith(QStringLiteral("No widget"))
                                 ? StatusCode::NotFound
                                 : StatusCode::BadRequest,
                             result.error);
        }

        /* Answer with the widget as it now stands, read back out of the XML
           rather than echoed from the request -- so the response says what was
           actually stored, not what was asked for. */
        VcWidget root;
        if (VirtualConsole::parse(m_engine->preservedSections(), root) == false)
            return QHttpServerResponse(QJsonObject());

        const VcWidget *patched = findWidget(root, widgetId.toUInt());
        return QHttpServerResponse(patched ? JsonView::vcWidget(*patched, doc, m_engine->levels()) : QJsonObject());
    });

    m_server->route("/api/v1/vc/widgets/<arg>", QHttpServerRequest::Method::Delete,
                    [this, denied](const QString &widgetId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        widgetId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Widget id must be a number"));

        const VcPatch::Result result = m_engine->removeWidget(widgetId);
        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject body;
        body["removed"] = widgetId;
        return QHttpServerResponse(body);
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

    m_server->route("/api/v1/fixtures/<arg>/clone", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        QList<quint32> ids;
        const DocWriter::Result result = m_engine->withFixturesLocked([&] {
            return DocWriter::cloneFixtures(doc, id, body.value("quantity").toInt(1),
                                            body.value("gap").toInt(0), ids);
        });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonArray created;
        for (quint32 newId : ids)
            created.append(qint64(newId));

        QJsonObject response;
        response["created"] = created;
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/fixtures/rgbpanel", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        DocWriter::PanelSpec spec;
        spec.name = body.value("name").toString();
        spec.universe = body.value("universe").toInt(1);
        spec.address = body.value("address").toInt(1);
        spec.rows = body.value("rows").toInt(1);
        spec.columns = body.value("columns").toInt(1);
        if (body.contains("components"))
            spec.components = body.value("components").toString();
        spec.sixteenBit = body.value("sixteenBit").toBool(false);
        if (body.contains("direction"))
            spec.direction = body.value("direction").toString();
        if (body.contains("startCorner"))
            spec.startCorner = body.value("startCorner").toString();
        if (body.contains("displacement"))
            spec.displacement = body.value("displacement").toString();
        spec.physicalWidth = body.value("physicalWidth").toInt(0);
        spec.physicalHeight = body.value("physicalHeight").toDouble(0);

        quint32 groupId = 0;
        QList<quint32> ids;
        const DocWriter::Result result = m_engine->withFixturesLocked(
            [&] { return DocWriter::addRgbPanel(doc, spec, groupId, ids); });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonArray created;
        for (quint32 id : ids)
            created.append(qint64(id));

        QJsonObject response;
        response["group"] = qint64(groupId);
        response["created"] = created;
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/fixtures/<arg>/remap", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        DocWriter::RemapSpec spec;
        spec.manufacturer = body.value("manufacturer").toString();
        spec.model = body.value("model").toString();
        spec.mode = body.value("mode").toString();
        spec.name = body.value("name").toString();
        spec.universe = body.value("universe").toInt(-1);
        spec.address = body.value("address").toInt(-1);

        QList<SceneValue> from, to;
        const DocWriter::Result result = m_engine->withFixturesLocked(
            [&] { return DocWriter::remapFixture(doc, id, spec, from, to); });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        /* The engine fixed the document; the console is ours to fix. Sliders
           hold (fixture, channel) pairs, and a channel that meant "dimmer" on
           the old lamp must keep meaning dimmer on the new one -- rewritten
           through the same patch path an editor uses, so validation is the
           same too. */
        int slidersTouched = 0;
        VcWidget root;
        if (VirtualConsole::parse(m_engine->preservedSections(), root))
        {
            QList<const VcWidget *> stack{&root};
            while (stack.isEmpty() == false)
            {
                const VcWidget *widget = stack.takeLast();
                for (const VcWidget &child : widget->children)
                    stack.append(&child);

                if (widget->levelChannels.isEmpty() || widget->hasId == false)
                    continue;

                bool touched = false;
                QJsonArray channels;
                for (const auto &channel : widget->levelChannels)
                {
                    if (channel.first != id)
                    {
                        QJsonObject entry;
                        entry["fixture"] = qint64(channel.first);
                        entry["channel"] = qint64(channel.second);
                        channels.append(entry);
                        continue;
                    }

                    touched = true;
                    for (int i = 0; i < from.count(); i++)
                    {
                        if (from.at(i).fxi == id && from.at(i).channel == channel.second)
                        {
                            QJsonObject entry;
                            entry["fixture"] = qint64(to.at(i).fxi);
                            entry["channel"] = qint64(to.at(i).channel);
                            channels.append(entry);
                            break;
                        }
                    }
                    /* A channel with no counterpart on the new lamp drops out,
                       exactly as the engine drops it from scenes. */
                }

                if (touched)
                {
                    QJsonObject patch;
                    patch["levelChannels"] = channels;
                    if (m_engine->editWidget(QString::number(widget->id), patch).ok)
                        slidersTouched++;
                }
            }
        }

        const Fixture *fixture = doc->fixture(id);
        QJsonObject response;
        response["id"] = qint64(id);
        response["channelsCarried"] = from.count();
        response["slidersTouched"] = slidersTouched;
        response["fixture"] = fixture ? JsonView::fixture(fixture) : QJsonObject();
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/plan/fixtures/<arg>/linked", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        int linkedIndex = 0;
        const DocWriter::Result result = m_engine->withFixturesLocked([&] {
            return DocWriter::addLinkedFixture(doc, id, body.value("head").toInt(0),
                                               body.value("name").toString(),
                                               body.value("x").toDouble(0),
                                               body.value("y").toDouble(0), linkedIndex);
        });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        response["linked"] = linkedIndex;
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/plan/fixtures/<arg>/linked/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawId, const QString &rawLinked,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        bool linkedOk = false;
        const int linked = rawLinked.toInt(&linkedOk);
        if (ok == false || linkedOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QUrlQuery query(request.url());
        const int head = query.queryItemValue(QStringLiteral("head")).toInt();

        const DocWriter::Result result = m_engine->withFixturesLocked(
            [&] { return DocWriter::removeLinkedFixture(doc, id, head, linked); });
        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject response;
        response["removed"] = linked;
        return QHttpServerResponse(response);
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

        /* And take the fixture out of the Virtual Console with it. Doc hands
           out the lowest free id, so leaving the references behind means the
           next fixture patched inherits this one's sliders and XY pad heads. */
        const int forgotten = m_engine->forgetFixture(id);

        QJsonObject body;
        body["removed"] = qint64(id);
        body["consoleReferencesRemoved"] = forgotten;
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

    m_server->route("/api/v1/functions", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        quint32 id = 0;
        const DocWriter::Result result =
            DocWriter::createFunction(doc, body.value("type").toString(),
                                      body.value("name").toString(), id);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        const Function *function = doc->function(id);
        return QHttpServerResponse(function ? JsonView::function(function) : QJsonObject(),
                                   StatusCode::Created);
    });

    m_server->route("/api/v1/functions/<arg>", QHttpServerRequest::Method::Patch,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const QJsonObject patch = QJsonDocument::fromJson(request.body()).object();

        if (patch.contains("name"))
        {
            const DocWriter::Result result =
                DocWriter::renameFunction(doc, id, patch.value("name").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("fadeIn") || patch.contains("fadeOut") || patch.contains("duration"))
        {
            const DocWriter::Result result =
                DocWriter::setFunctionSpeeds(doc, id, patch.value("fadeIn").toInt(-1),
                                             patch.value("fadeOut").toInt(-1),
                                             patch.value("duration").toInt(-1));
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("runOrder") || patch.contains("direction"))
        {
            const DocWriter::Result result =
                DocWriter::setFunctionRun(doc, id, patch.value("runOrder").toString(),
                                          patch.value("direction").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        /* The folder tree. Present-and-empty moves the function to the root,
           which is a real request and not a no-op. */
        if (patch.contains("path"))
        {
            const DocWriter::Result result =
                DocWriter::setFunctionPath(doc, id, patch.value("path").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("timeDivision") || patch.contains("bpm"))
        {
            const Function *function = doc->function(id);
            const QString division = patch.contains("timeDivision")
                ? patch.value("timeDivision").toString()
                : (function != nullptr && function->type() == Function::ShowType
                       ? Show::tempoToString(
                             qobject_cast<const Show *>(function)->timeDivisionType())
                       : QString());
            const int bpm = patch.value("bpm").toInt(
                function != nullptr && function->type() == Function::ShowType
                    ? qobject_cast<const Show *>(function)->timeDivisionBPM()
                    : 120);
            const DocWriter::Result result = DocWriter::setShowTimeDivision(doc, id, division, bpm);
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("tempoType"))
        {
            const DocWriter::Result result =
                DocWriter::setFunctionTempo(doc, id, patch.value("tempoType").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (patch.contains("fadeInMode") || patch.contains("fadeOutMode")
            || patch.contains("durationMode"))
        {
            const DocWriter::Result result = DocWriter::setChaserSpeedModes(
                doc, id, patch.value("fadeInMode").toString(),
                patch.value("fadeOutMode").toString(), patch.value("durationMode").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        const Function *function = doc->function(id);
        if (function == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        return QHttpServerResponse(JsonView::function(function));
    });

    m_server->route("/api/v1/functions/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const bool force = QUrlQuery(request.url().query())
                               .queryItemValue(QStringLiteral("force")) == QStringLiteral("true");

        const DocWriter::Result result = DocWriter::deleteFunction(doc, id, force);
        if (result.ok == false)
            return jsonError(StatusCode::Conflict, result.error);

        QJsonObject response;
        response["removed"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* Scene body: one channel of one fixture. value -1 clears it. */
    m_server->route("/api/v1/functions/<arg>/values", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const DocWriter::Result result =
            DocWriter::setSceneValue(doc, id, quint32(body.value("fixture").toInt(-1)),
                                     quint32(body.value("channel").toInt(-1)),
                                     body.value("value").toInt(-1));
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["scene"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* Chaser body: steps. */
    m_server->route("/api/v1/functions/<arg>/steps", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const DocWriter::Result result =
            DocWriter::addChaserStep(doc, id, quint32(body.value("function").toInt(-1)),
                                     body.value("index").toInt(-1),
                                     body.value("fadeIn").toInt(0),
                                     body.value("hold").toInt(0),
                                     body.value("fadeOut").toInt(0));
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["chaser"] = qint64(id);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    /* Editing one step: fades, hold, duration, its note, or the function it
       points at. Only what the body names is touched. */
    m_server->route("/api/v1/functions/<arg>/steps/<arg>", QHttpServerRequest::Method::Patch,
                    [doc, denied](const QString &rawId, const QString &rawIndex,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false, indexOk = false;
        const quint32 id = rawId.toUInt(&ok);
        const int index = rawIndex.toInt(&indexOk);
        if (ok == false || indexOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const int fadeIn = body.value("fadeIn").toInt(-1);
        const int hold = body.value("hold").toInt(-1);
        const int fadeOut = body.value("fadeOut").toInt(-1);
        const int duration = body.value("duration").toInt(-1);
        const QString note = body.value("note").toString();
        const quint32 functionId = quint32(body.value("function").toInt(-1));

        const DocWriter::Result result = DocWriter::setChaserStep(
            doc, id, index,
            body.contains("fadeIn") ? &fadeIn : nullptr,
            body.contains("hold") ? &hold : nullptr,
            body.contains("fadeOut") ? &fadeOut : nullptr,
            body.contains("duration") ? &duration : nullptr,
            body.contains("note") ? &note : nullptr,
            body.contains("function") ? &functionId : nullptr);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(JsonView::functionBody(doc, doc->function(id)));
    });

    /* Reordering is one atomic permutation, not a dance of moves: the shuffle
       button sends the shuffled order it wants, and what lands in the file is
       exactly that. */
    m_server->route("/api/v1/functions/<arg>/steps/order", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        if (body.value("order").isArray() == false)
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send {\"order\": [indices]}"));

        QList<int> order;
        for (const QJsonValue &value : body.value("order").toArray())
            order.append(value.toInt(-1));

        const DocWriter::Result result = DocWriter::setChaserStepsOrder(doc, id, order);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(JsonView::functionBody(doc, doc->function(id)));
    });

    /* A sequence step's own DMX values -- the half that makes a sequence a
       sequence rather than a chaser. */
    m_server->route("/api/v1/functions/<arg>/steps/<arg>/values", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &rawId, const QString &rawIndex,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false, indexOk = false;
        const quint32 id = rawId.toUInt(&ok);
        const int index = rawIndex.toInt(&indexOk);
        if (ok == false || indexOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        if (body.value("values").isArray() == false)
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send {\"values\": [{\"fixture\", \"channel\", \"value\"}]}"));

        QList<SceneValue> values;
        for (const QJsonValue &entry : body.value("values").toArray())
        {
            const QJsonObject one = entry.toObject();
            const int fixture = one.value("fixture").toInt(-1);
            const int channel = one.value("channel").toInt(-1);
            const int value = one.value("value").toInt(-1);
            if (fixture < 0 || channel < 0 || value < 0 || value > 255)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Each value needs fixture, channel and value 0-255"));
            values.append(SceneValue(quint32(fixture), quint32(channel), uchar(value)));
        }

        const DocWriter::Result result = DocWriter::setSequenceStepValues(doc, id, index, values);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(JsonView::functionBody(doc, doc->function(id)));
    });

    /* A copy, QLC+-style: same everything, name suffixed. */
    m_server->route("/api/v1/functions/<arg>/clone", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        quint32 newId = Function::invalidId();
        const DocWriter::Result result = DocWriter::cloneFunction(doc, id, newId);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(newId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    /* The waveform: peak per bucket over the whole file, 0-100. Decoded with
       the same plugins that will play it, so what the editor draws is what
       the show will hear -- or exactly the silence it will not. */
    m_server->route("/api/v1/functions/<arg>/waveform", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const Function *function = doc->function(id);
        if (function == nullptr || function->type() != Function::AudioType)
            return jsonError(StatusCode::NotFound, QStringLiteral("No audio function with that id"));

        const Audio *audio = qobject_cast<const Audio *>(function);
        const QString source = audio->getSourceFileName();
        if (source.isEmpty() || QFileInfo::exists(source) == false)
            return jsonError(StatusCode::Conflict,
                             QStringLiteral("The audio file is not on this machine: %1").arg(source));

        const QUrlQuery query(request.url());
        int points = query.queryItemValue(QStringLiteral("points")).toInt();
        if (points <= 0)
            points = 200;
        points = qMin(points, 2000);

        AudioDecoder *decoder = doc->audioPluginCache()->getDecoderForFile(source);
        if (decoder == nullptr)
            return jsonError(StatusCode::Conflict,
                             QStringLiteral("No decoder can read %1").arg(source));

        /* One pass, S16 assumed: every shipped decoder emits S16LE. Peaks are
           bucketed by byte position against the total estimated from the
           duration, so a short read still yields a full-length silhouette. */
        const AudioParameters parameters = decoder->audioParameters();
        const qint64 totalMs = decoder->totalTime();
        const qint64 bytesPerSecond =
            qint64(parameters.sampleRate()) * parameters.channels() * 2;
        const qint64 totalBytes = qMax(qint64(1), totalMs * bytesPerSecond / 1000);

        QVector<int> peaks(points, 0);
        QByteArray chunk(32768, 0);
        qint64 position = 0;
        for (;;)
        {
            const qint64 got = decoder->read(chunk.data(), chunk.size());
            if (got <= 0)
                break;
            const qint16 *samples = reinterpret_cast<const qint16 *>(chunk.constData());
            const int count = int(got / 2);
            for (int i = 0; i < count; i++)
            {
                const qint64 byteAt = position + qint64(i) * 2;
                int bucket = int(byteAt * points / totalBytes);
                if (bucket >= points)
                    bucket = points - 1;
                const int value = qAbs(int(samples[i]));
                if (value > peaks[bucket])
                    peaks[bucket] = value;
            }
            position += got;
        }
        delete decoder;

        QJsonArray wave;
        for (int peak : peaks)
            wave.append(peak * 100 / 32767);

        QJsonObject body;
        body["points"] = wave;
        body["duration"] = qint64(totalMs);
        return QHttpServerResponse(body);
    });

    /* Bake: the matrix frozen into a Scene + Sequence pair, exactly like
       QLC+ 5's "save to sequence". The matrix itself is untouched. */
    m_server->route("/api/v1/functions/<arg>/bake", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        quint32 sceneId = Function::invalidId();
        quint32 sequenceId = Function::invalidId();
        const DocWriter::Result result =
            DocWriter::bakeMatrixToSequence(doc, id, sceneId, sequenceId);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["scene"] = qint64(sceneId);
        response["sequence"] = qint64(sequenceId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    /* Who uses this function. Deleting one that a chaser steps through, a
       collection carries, a show schedules or a button fires is exactly the
       moment this list earns its place. */
    m_server->route("/api/v1/functions/<arg>/usage", QHttpServerRequest::Method::Get,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));
        if (doc->function(id) == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        QJsonArray functions;
        for (const Function *other : doc->functions())
        {
            if (other->id() == id)
                continue;

            bool uses = false;
            if (other->type() == Function::ChaserType || other->type() == Function::SequenceType)
            {
                const Chaser *chaser = qobject_cast<const Chaser *>(other);
                for (const ChaserStep &step : chaser->steps())
                    uses = uses || step.fid == id;
            }
            else if (other->type() == Function::CollectionType)
            {
                uses = qobject_cast<const Collection *>(other)->functions().contains(id);
            }
            else if (other->type() == Function::ShowType)
            {
                const Show *show = qobject_cast<const Show *>(other);
                for (const Track *track : show->tracks())
                {
                    for (const ShowFunction *item : track->showFunctions())
                        uses = uses || item->functionID() == id;
                }
            }

            if (uses)
            {
                QJsonObject entry;
                entry["id"] = qint64(other->id());
                entry["name"] = other->name();
                entry["type"] = Function::typeToString(other->type());
                functions.append(entry);
            }
        }

        /* The console's references, read from the same parsed tree the web
           renders -- so what this reports and what the screen shows cannot
           disagree. */
        QJsonArray widgets;
        VcWidget root;
        if (VirtualConsole::parse(m_engine->preservedSections(), root))
        {
            QList<const VcWidget *> stack{&root};
            while (stack.isEmpty() == false)
            {
                const VcWidget *widget = stack.takeLast();
                for (const VcWidget &child : widget->children)
                    stack.append(&child);

                bool uses = (widget->hasFunction && widget->functionId == id)
                    || (widget->hasChaser && widget->chaserId == id);
                for (const VcWidget::SpeedTarget &target : widget->speedTargets)
                    uses = uses || target.functionId == id;

                if (uses)
                {
                    QJsonObject entry;
                    if (widget->hasId)
                        entry["id"] = qint64(widget->id);
                    entry["caption"] = widget->caption;
                    entry["type"] = widget->type;
                    widgets.append(entry);
                }
            }
        }

        QJsonObject body;
        body["functions"] = functions;
        body["widgets"] = widgets;
        body["startup"] = doc->startupFunction() == id;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/functions/<arg>/steps/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &rawId, const QString &rawIndex,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false, indexOk = false;
        const quint32 id = rawId.toUInt(&ok);
        const int index = rawIndex.toInt(&indexOk);
        if (ok == false || indexOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const DocWriter::Result result = DocWriter::removeChaserStep(doc, id, index);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["chaser"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* The algorithms an RGB matrix can run, so a caller is not guessing. */
    m_server->route("/api/v1/algorithms", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray names;
        for (const QString &name : RGBAlgorithm::algorithms(doc))
            names.append(name);

        QJsonObject body;
        body["algorithms"] = names;
        return QHttpServerResponse(body);
    });

    /* What a function is made of. Without this a client can change a body it
       cannot see, which is not editing, it is guessing. */
    m_server->route("/api/v1/functions/<arg>/body", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const Function *function = doc->function(id);
        if (function == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        return QHttpServerResponse(JsonView::functionBody(doc, function));
    });

    /* Bodies of the remaining editable types. One route, dispatching on the
       function's own type, because a caller should not have to know which URL
       shape a type happens to use. */
    m_server->route("/api/v1/functions/<arg>/body", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const Function *function = doc->function(id);
        if (function == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such function"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        DocWriter::Result result = DocWriter::Result::failure(
            QStringLiteral("%1 functions have no editable body here yet")
                .arg(Function::typeToString(function->type())));

        switch (function->type())
        {
        case Function::RGBMatrixType:
        {
            QList<QString> colours;
            for (const QJsonValue &value : body.value("colors").toArray())
                colours.append(value.toString());

            result = DocWriter::setRgbMatrix(doc, id, body.value("fixtureGroup").toInt(-1),
                                             body.value("algorithm").toString(), colours);
            if (result.ok)
                result = DocWriter::setRgbMatrixExtras(doc, id, body);
            break;
        }
        case Function::ScriptType:
            result = DocWriter::setScriptData(doc, id, body.value("data").toString());
            break;
        case Function::AudioType:
        {
            /* Absent leaves the device alone; an empty string is "back to the
               system default", which is a different request. */
            const QString device = body.value("device").toString();
            result = DocWriter::setAudioSource(doc, id, body.value("source").toString(),
                                               body.value("volume").toDouble(-1.0),
                                               body.contains("device") ? &device : nullptr);
            break;
        }
        case Function::VideoType:
            result = DocWriter::setVideoSource(doc, id, body.value("source").toString());
            break;
        case Function::EFXType:
        {
            QList<quint32> fixtures;
            const bool hasFixtures = body.value("fixtures").isArray();
            if (hasFixtures)
            {
                for (const QJsonValue &value : body.value("fixtures").toArray())
                {
                    if (value.isDouble() == false || value.toInt(-1) < 0)
                    {
                        return jsonError(StatusCode::BadRequest,
                                         QStringLiteral("Fixture ids must be non-negative numbers"));
                    }
                    fixtures.append(quint32(value.toInt()));
                }
            }

            result = DocWriter::setEfx(doc, id, body.value("algorithm").toString(), body,
                                       hasFixtures ? &fixtures : nullptr);
            break;
        }
        case Function::SceneType:
        {
            /* The palettes a scene carries, plus the fixtures they resolve
               against. Values keep their own POST route. */
            if (body.contains(QStringLiteral("palettes")) == false)
            {
                result = DocWriter::Result::failure(
                    QStringLiteral("A scene's body PUT takes {\"palettes\": [ids], "
                                   "\"fixtures\": [ids]}"));
                break;
            }
            QList<quint32> palettes;
            for (const QJsonValue &value : body.value(QStringLiteral("palettes")).toArray())
                palettes.append(quint32(value.toInt(-1)));
            QList<quint32> fixtures;
            const bool hasFixtures = body.value(QStringLiteral("fixtures")).isArray();
            for (const QJsonValue &value : body.value(QStringLiteral("fixtures")).toArray())
                fixtures.append(quint32(value.toInt(-1)));
            result = DocWriter::setScenePalettes(doc, id, palettes,
                                                 hasFixtures ? &fixtures : nullptr);
            break;
        }
        case Function::SequenceType:
            result = DocWriter::setSequenceScene(doc, id,
                                                 quint32(body.value("scene").toInt(-1)));
            break;
        default:
            break;
        }

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(JsonView::function(doc->function(id)));
    });

    /* Collection body: the functions it fires together. */
    m_server->route("/api/v1/functions/<arg>/members", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Function id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        if (body.value("functions").isArray() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Send a \"functions\" array"));

        QList<quint32> members;
        for (const QJsonValue &value : body.value("functions").toArray())
        {
            if (value.isDouble() == false || value.toInt(-1) < 0)
                return jsonError(StatusCode::BadRequest, QStringLiteral("Function ids must be numbers"));
            members.append(quint32(value.toInt()));
        }

        const DocWriter::Result result = DocWriter::setCollectionMembers(doc, id, members);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["collection"] = qint64(id);
        return QHttpServerResponse(response);
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

            /* The grid is the group: which way an effect snakes across the rig
               is decided by which head sits in which cell. */
            QJsonArray cells;
            const QMap<QLCPoint, GroupHead> heads = group->headsMap();
            for (auto it = heads.constBegin(); it != heads.constEnd(); ++it)
            {
                QJsonObject cell;
                cell["x"] = it.key().x();
                cell["y"] = it.key().y();
                cell["fixture"] = qint64(it.value().fxi);
                cell["head"] = it.value().head;
                cells.append(cell);
            }

            QJsonObject size;
            size["width"] = group->size().width();
            size["height"] = group->size().height();

            QJsonObject entry;
            entry["id"] = qint64(group->id());
            entry["name"] = group->name();
            entry["fixtures"] = members;
            entry["size"] = size;
            entry["cells"] = cells;
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

        /* Three shapes of patch: a name, a flat member list, a full grid.
           Absent is not empty -- only the keys that are present act, so a
           rename does not read as "remove every fixture from this group". */
        if (body.contains("name"))
        {
            const DocWriter::Result result =
                DocWriter::renameFixtureGroup(doc, id, body.value("name").toString());
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        if (body.contains("cells"))
        {
            if (body.value("cells").isArray() == false || body.value("size").isObject() == false)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("A grid patch is {\"size\": {\"width\", "
                                                "\"height\"}, \"cells\": [{x, y, fixture, "
                                                "head}]}"));
            }

            const QJsonObject size = body.value("size").toObject();
            QList<DocWriter::GroupCell> cells;
            for (const QJsonValue &value : body.value("cells").toArray())
            {
                const QJsonObject raw = value.toObject();
                DocWriter::GroupCell cell;
                cell.x = raw.value("x").toInt(-1);
                cell.y = raw.value("y").toInt(-1);
                cell.fixture = quint32(raw.value("fixture").toInt(-1));
                cell.head = raw.value("head").toInt(0);
                cells.append(cell);
            }

            const DocWriter::Result result =
                DocWriter::setFixtureGroupGrid(doc, id, size.value("width").toInt(0),
                                               size.value("height").toInt(0), cells);
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }
        else if (body.contains("fixtures"))
        {
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
        }

        QJsonObject response;
        response["id"] = qint64(id);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/fixture-groups/<arg>/transform", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Group id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const DocWriter::Result result =
            DocWriter::transformFixtureGroup(doc, id, body.value("op").toString());
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        response["op"] = body.value("op");
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

    /* The last external control this daemon saw.
     *
     * Nobody knows that their fader is channel 47 of input universe 1, so a
     * binding is learned by pressing the thing. The live feed carries these as
     * they happen, which is what an interface in learn mode watches; this route
     * is for the case where it missed one, and it says plainly when nothing has
     * arrived at all -- a daemon with no input plugins patched will never see
     * anything, and that is worth being told rather than waiting for.
     */
    m_server->route("/api/v1/input/last", QHttpServerRequest::Method::Get,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const EngineHost::SeenInput seen = m_engine->lastInput();

        QJsonObject body;
        body["seen"] = seen.valid;
        if (seen.valid)
        {
            body["universe"] = qint64(seen.universe);
            body["channel"] = qint64(seen.channel);
            body["value"] = int(seen.value);
        }
        else
        {
            body["note"] = QStringLiteral(
                "Nothing has arrived on an input universe since this daemon started. Patch an "
                "input in Universes, then move the control.");
        }

        return QHttpServerResponse(body);
    });

    /* The live desk: absolute values pinned on individual channels.
     *
     * This is what makes the plan a place to work rather than a place to look.
     * Selecting four lamps and giving them a colour is, once the colour has
     * been resolved into channels, exactly this: a handful of channels held at
     * exact values, each its own.
     *
     * Deliberately generic. The interface already knows which channel of a
     * fixture is its red -- GET /plan reports the roles, and the same map is
     * what paints the plan -- so resolving a colour into channels happens once,
     * in the place that also reads them back. A second mapping on this side
     * would be a second thing to drift.
     *
     * It writes nothing to the document: this is a desk, not an edit. Nothing
     * here survives a reload, and it says so by holding no state anybody has to
     * remember to save.
     */
    m_server->route("/api/v1/live", QHttpServerRequest::Method::Get,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray values;
        for (const auto &entry : m_engine->levels()->liveValues())
        {
            QJsonObject one;
            one["fixture"] = qint64(entry.first.first);
            one["channel"] = qint64(entry.first.second);
            one["value"] = int(entry.second);
            values.append(one);
        }

        QJsonObject body;
        body["values"] = values;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/live", QHttpServerRequest::Method::Put,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        if (body.value("values").isArray() == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send a \"values\" array of "
                                            "{\"fixture\": id, \"channel\": n, \"value\": 0-255}"));
        }

        QList<QPair<LevelSource::Channel, uchar>> values;

        for (const QJsonValue &entry : body.value("values").toArray())
        {
            const QJsonObject one = entry.toObject();
            const QJsonValue fixture = one.value("fixture");
            const QJsonValue channel = one.value("channel");
            const QJsonValue value = one.value("value");

            if (fixture.isDouble() == false || channel.isDouble() == false
                || value.isDouble() == false || fixture.toInt(-1) < 0 || channel.toInt(-1) < 0
                || value.toInt(-1) < 0 || value.toInt(256) > 255)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Every value needs a non-negative \"fixture\" and "
                                                "\"channel\", and a \"value\" from 0 to 255"));
            }

            values.append(qMakePair(qMakePair(quint32(fixture.toInt()), quint32(channel.toInt())),
                                    uchar(value.toInt())));
        }

        QString error;
        if (m_engine->setLiveValues(values, error) == false)
            return jsonError(StatusCode::BadRequest, error);

        QJsonObject response;
        response["held"] = values.count();
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/live", QHttpServerRequest::Method::Delete,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        m_engine->releaseLive();

        QJsonObject response;
        response["held"] = 0;
        return QHttpServerResponse(response);
    });

    /* The plan: where each fixture stands, and what colour it is right now.
     *
     * Only the layout and the roles come from here. The colours are worked out
     * in the browser from the DMX frames it already receives -- a round trip
     * per frame would make the plan a slideshow, and a plan that lags is worse
     * than no plan, because it is believed.
     */
    m_server->route("/api/v1/plan", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        return QHttpServerResponse(JsonView::plan(doc));
    });

    m_server->route("/api/v1/plan/fixtures/<arg>", QHttpServerRequest::Method::Put,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const auto number = [&body](const char *key, double &into) {
            const QJsonValue value = body.value(QLatin1String(key));
            if (value.isDouble() == false)
                return false;
            into = value.toDouble();
            return true;
        };

        double x = 0, y = 0, rotation = 0;
        const bool hasX = number("x", x);
        const bool hasY = number("y", y);
        const bool hasRotation = number("rotation", rotation);
        const QString gel = body.value("gel").toString();
        const int head = body.value("head").toInt(0);
        const int linked = body.value("linked").toInt(0);
        const int zoom = body.value("zoom").toInt(-1);

        /* The flags must be booleans when present: a "hidden" of "yes" that
           quietly read as false would answer 200 and hide nothing. */
        bool hidden = false, locked = false, invertPan = false, invertTilt = false;
        bool hasHidden = false, hasLocked = false, hasInvertPan = false, hasInvertTilt = false;
        const auto flag = [&body](const char *key, bool &into, bool &present) -> bool {
            const QJsonValue value = body.value(QLatin1String(key));
            if (value.isUndefined())
                return true;
            if (value.isBool() == false)
                return false;
            into = value.toBool();
            present = true;
            return true;
        };
        if (flag("hidden", hidden, hasHidden) == false
            || flag("locked", locked, hasLocked) == false
            || flag("invertPan", invertPan, hasInvertPan) == false
            || flag("invertTilt", invertTilt, hasInvertTilt) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("hidden, locked, invertPan and invertTilt are booleans"));
        }
        if (body.contains("zoom") && body.value("zoom").isDouble() == false)
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"zoom\" is a beam width in degrees"));

        /* A plan is a top view, and this build of the engine writes only X and Y
           to the file (monitorproperties.cpp:959 puts the third coordinate
           behind QMLUI). Accepting a height would hold it until the next save
           and then lose it, and a lamp that moves when the project is reopened
           is worse than one that could never be raised. */
        if (body.contains("z"))
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("A plan is a top view: send \"x\" and \"y\". A height "
                                            "would not survive being saved."));
        }

        /* A body that names a key with something that is not a number is a
           mistake, not an omission. Ignoring it would move a lamp to where it
           already was and answer 200. */
        for (const char *key : {"x", "y", "rotation"})
        {
            const QJsonValue value = body.value(QLatin1String(key));
            if (value.isUndefined() == false && value.isDouble() == false)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("\"%1\" must be a number in millimetres")
                                     .arg(QLatin1String(key)));
            }
        }

        DocWriter::PlanItemPatch patch;
        patch.x = hasX ? &x : nullptr;
        patch.y = hasY ? &y : nullptr;
        patch.rotation = hasRotation ? &rotation : nullptr;
        patch.gel = body.contains("gel") ? &gel : nullptr;
        patch.zoom = body.contains("zoom") ? &zoom : nullptr;
        patch.hidden = hasHidden ? &hidden : nullptr;
        patch.locked = hasLocked ? &locked : nullptr;
        patch.invertPan = hasInvertPan ? &invertPan : nullptr;
        patch.invertTilt = hasInvertTilt ? &invertTilt : nullptr;

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::setPlanItem(doc, id, head, linked, patch);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/plan/fixtures/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::clearPlanPosition(doc, id);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::NotFound, result.error);

        QJsonObject response;
        response["removed"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* The background image the project names, served from wherever it lives on
     * this machine.
     *
     * The path comes from the project rather than from the request, which is
     * the whole reason this is safe: nothing here takes a file name from the
     * network. A project that names a file that is gone gets a 404, which is
     * the truth -- the drawing the plan was built against is not there.
     */
    m_server->route("/api/v1/plan/background", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QString path = doc->monitorProperties()->commonBackgroundImage();
        if (path.isEmpty())
            return jsonError(StatusCode::NotFound, QStringLiteral("This project has no plan background"));

        if (QFileInfo::exists(path) == false)
        {
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("The project names \"%1\" as its plan background, and "
                                            "it is not there").arg(path));
        }

        return QHttpServerResponse::fromFile(path);
    });

    /* Shows: the multi-track timeline.
     *
     * A show is the one function whose body is a screen rather than a list, and
     * the only one this daemon could not read at all. A track holds a scene and
     * carries functions placed in time; the sequences on it are that scene's
     * values over the length of the show.
     */
    m_server->route("/api/v1/functions/<arg>/tracks/<arg>/solo", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawShow, const QString &rawTrack,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, trackOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 trackId = rawTrack.toUInt(&trackOk);
        if (showOk == false || trackOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        if (body.value("solo").isBool() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Send {\"solo\": true|false}"));

        const DocWriter::Result result =
            DocWriter::setShowTrackSolo(doc, showId, trackId, body.value("solo").toBool());
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["track"] = qint64(trackId);
        response["solo"] = body.value("solo");
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/functions/<arg>/time", QHttpServerRequest::Method::Post,
                    [doc, denied](const QString &rawShow, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 showId = rawShow.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Show id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const QString action = body.value("action").toString();
        const quint32 at = quint32(qMax(0, body.value("at").toInt(0)));
        const quint32 amount = quint32(qMax(0, body.value("amount").toInt(0)));

        int primary = 0, moved = 0;
        DocWriter::Result result = DocWriter::Result::success();
        if (action == QStringLiteral("insert"))
            result = DocWriter::insertShowTime(doc, showId, at, amount, primary, moved);
        else if (action == QStringLiteral("cut"))
            result = DocWriter::cutShowTime(doc, showId, at, amount, primary, moved);
        else
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"action\" is insert or cut"));

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response[action == QStringLiteral("insert") ? "stretched" : "shrunk"] = primary;
        response["moved"] = moved;
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/functions/<arg>/tracks", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 showId = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Show id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const quint32 sceneId = body.contains("scene")
                                    ? quint32(body.value("scene").toInt(-1))
                                    : Function::invalidId();

        quint32 trackId = 0;
        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::addShowTrack(doc, showId, body.value("name").toString(), sceneId,
                                             trackId);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(trackId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/functions/<arg>/tracks/<arg>", QHttpServerRequest::Method::Patch,
                    [this, doc, denied](const QString &rawShow, const QString &rawTrack,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, trackOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 trackId = rawTrack.toUInt(&trackOk);
        if (showOk == false || trackOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const QString name = body.value("name").toString();
        const bool mute = body.value("mute").toBool();
        const quint32 scene = quint32(body.value("scene").toInt(-1));

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::setShowTrack(doc, showId, trackId,
                                             body.contains("name") ? &name : nullptr,
                                             body.contains("mute") ? &mute : nullptr,
                                             body.contains("scene") ? &scene : nullptr);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(trackId);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/functions/<arg>/tracks/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawShow, const QString &rawTrack,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, trackOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 trackId = rawTrack.toUInt(&trackOk);
        if (showOk == false || trackOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::removeShowTrack(doc, showId, trackId);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["removed"] = qint64(trackId);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/functions/<arg>/tracks/<arg>/items",
                    QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawShow, const QString &rawTrack,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, trackOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 trackId = rawTrack.toUInt(&trackOk);
        if (showOk == false || trackOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        if (body.value("function").isDouble() == false || body.value("function").toInt(-1) < 0)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Send a \"function\" id"));

        const int start = body.value("start").toInt(0);
        const int duration = body.value("duration").toInt(0);
        if (start < 0 || duration < 0)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("A start and a duration are milliseconds, and neither "
                                            "can be negative"));
        }

        quint32 itemId = 0;
        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::addShowItem(doc, showId, trackId,
                                            quint32(body.value("function").toInt()),
                                            quint32(start), quint32(duration), itemId);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(itemId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/functions/<arg>/items/<arg>", QHttpServerRequest::Method::Patch,
                    [this, doc, denied](const QString &rawShow, const QString &rawItem,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, itemOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 itemId = rawItem.toUInt(&itemOk);
        if (showOk == false || itemOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const int start = body.value("start").toInt(-1);
        const int duration = body.value("duration").toInt(-1);
        if ((body.contains("start") && start < 0) || (body.contains("duration") && duration < 0))
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("A start and a duration are milliseconds, and neither "
                                            "can be negative"));
        }

        const quint32 startValue = quint32(start);
        const quint32 durationValue = quint32(duration);
        const QString color = body.value("color").toString();
        const bool locked = body.value("locked").toBool();

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::setShowItem(doc, showId, itemId,
                                            body.contains("start") ? &startValue : nullptr,
                                            body.contains("duration") ? &durationValue : nullptr,
                                            body.contains("color") ? &color : nullptr,
                                            body.contains("locked") ? &locked : nullptr);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(itemId);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/functions/<arg>/items/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawShow, const QString &rawItem,
                                        const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool showOk = false, itemOk = false;
        const quint32 showId = rawShow.toUInt(&showOk);
        const quint32 itemId = rawItem.toUInt(&itemOk);
        if (showOk == false || itemOk == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Ids must be numbers"));

        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::removeShowItem(doc, showId, itemId);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["removed"] = qint64(itemId);
        return QHttpServerResponse(response);
    });

    /* Channel modifiers: the curve a channel's values pass through on the way
     * out.
     *
     * "Invert" turns a fader upside down; "Exponential Deep" bends a dimmer to
     * match a lamp that does not fade linearly; "Always Full" pins a channel
     * that has to stay open. It belongs to the patch rather than to any cue,
     * which is why it is edited on the fixture and not in a scene.
     */
    m_server->route("/api/v1/modifiers", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray names;
        for (const QString &name : doc->modifiersCache()->templateNames())
            names.append(name);

        QJsonObject body;
        body["modifiers"] = names;
        return QHttpServerResponse(body);
    });

    /* The curve itself, 256 values.
     *
     * Worth a route, because the names are the only thing a client has to go on
     * and they do not say much: "Exponential Medium" and "Exponential Deep" are
     * both plausible and only one of them is what the lamp needs. Drawn, they
     * are obvious. */
    m_server->route("/api/v1/modifiers/<arg>", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &name, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        ChannelModifier *modifier = doc->modifiersCache()->modifier(name);
        if (modifier == nullptr)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("No channel modifier named \"%1\"").arg(name));

        QJsonArray curve;
        for (int i = 0; i < 256; i++)
            curve.append(int(modifier->getValue(uchar(i))));

        QJsonObject body;
        body["name"] = modifier->name();
        body["curve"] = curve;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/fixtures/<arg>/modifiers", QHttpServerRequest::Method::Put,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Fixture id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        /* Absent is not empty: a PUT that forgot the key, or a malformed body,
           would otherwise read as "take every modifier off this fixture". */
        if (body.value("modifiers").isObject() == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send a \"modifiers\" object of "
                                            "{\"<channel>\": \"<name>\"}. To clear them all, "
                                            "send an empty one."));
        }

        const QJsonObject wanted = body.value("modifiers").toObject();
        QMap<quint32, QString> byChannel;

        for (auto it = wanted.constBegin(); it != wanted.constEnd(); ++it)
        {
            bool channelOk = false;
            const uint channel = it.key().toUInt(&channelOk);
            if (channelOk == false)
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("\"%1\" is not a channel number").arg(it.key()));
            }

            /* null clears one channel without having to send the rest. */
            byChannel.insert(quint32(channel),
                             it.value().isNull() ? QString() : it.value().toString());
        }

        DocWriter::Result result = DocWriter::Result::success();

        /* Through the lock: this claims the universes to push the new curves
           down, and the timer thread is writing to them. */
        m_engine->withFixturesLocked([&]() {
            result = DocWriter::setChannelModifiers(doc, id, byChannel);
            return true;
        });

        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        response["modifiers"] = wanted;
        return QHttpServerResponse(response);
    });

    /* Channels groups: one fader over a handful of channels picked by hand.
     *
     * Not fixture groups. A fixture group gathers whole fixtures so an effect
     * can run across them; a channels group gathers the dimmer of one lamp, the
     * strobe of another and the fog machine's fan, so one fader moves all
     * three. QLC+ keeps them in the Simple Desk, which is why they were the
     * last thing here with no way in from a browser. */
    m_server->route("/api/v1/channel-groups", QHttpServerRequest::Method::Get,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        return QHttpServerResponse(JsonView::channelGroups(doc, m_engine->levels()));
    });

    m_server->route("/api/v1/channel-groups", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        QList<QPair<quint32, quint32>> channels;
        QString reason;
        if (readChannels(body.value("channels"), channels, reason) == false)
            return jsonError(StatusCode::BadRequest, reason);

        quint32 groupId = 0;
        QString error;
        if (m_engine->addChannelGroup(body.value("name").toString(), channels, groupId, error)
            == false)
        {
            return jsonError(StatusCode::BadRequest, error);
        }

        QJsonObject response;
        response["id"] = qint64(groupId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/channel-groups/<arg>", QHttpServerRequest::Method::Patch,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Group id must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();

        const bool renaming = body.contains("name");
        const bool rechannelling = body.contains("channels");
        if (renaming == false && rechannelling == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send a \"name\", a \"channels\" array, or both"));
        }

        QList<QPair<quint32, quint32>> channels;
        if (rechannelling)
        {
            QString reason;
            if (readChannels(body.value("channels"), channels, reason) == false)
                return jsonError(StatusCode::BadRequest, reason);
        }

        const QString name = body.value("name").toString();
        QString error;
        if (m_engine->updateChannelGroup(id, renaming ? &name : nullptr,
                                         rechannelling ? &channels : nullptr, error) == false)
        {
            return jsonError(StatusCode::BadRequest, error);
        }

        return QHttpServerResponse(JsonView::channelGroup(doc, id, m_engine->levels()));
    });

    m_server->route("/api/v1/channel-groups/<arg>", QHttpServerRequest::Method::Delete,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Group id must be a number"));

        QString error;
        if (m_engine->removeChannelGroup(id, error) == false)
            return jsonError(StatusCode::NotFound, error);

        QJsonObject response;
        response["removed"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* The audio inputs this machine offers, and the one the capture uses.
     *
     * Worth a route of its own, because the wrong input is silent rather than
     * broken: a widget listening to a headphones jack with nothing plugged in
     * looks exactly like a widget that does not work, and an operator can only
     * tell the two apart by being shown the list. */
    m_server->route("/api/v1/audio", QHttpServerRequest::Method::Get,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray inputs;
        for (const QString &name : AudioTriggers::availableInputs())
            inputs.append(name);

        /* And what it can play through, which is a separate question from what
         * it can listen to and was not answerable at all until now.
         *
         * An Audio function that reads its file, reports its length and makes
         * no sound looks identical to one that is simply not playing yet. The
         * two things that decide it -- a decoder for the file, and an output to
         * put the samples on -- are both answered here, so an interface can say
         * which one is missing instead of showing a play button and hoping. */
        QJsonArray outputs;
        for (const AudioDeviceInfo &info : doc->audioPluginCache()->audioDevicesList())
        {
            if (info.capabilities & AUDIO_CAP_OUTPUT)
                outputs.append(info.deviceName);
        }

        QJsonObject body;
        body["inputs"] = inputs;
        body["selected"] = AudioTriggers::selectedInput();
        body["capturing"] = m_engine->audio()->isCapturing();
        if (m_engine->audio()->unavailableReason().isEmpty() == false)
            body["unavailable"] = m_engine->audio()->unavailableReason();

        body["outputs"] = outputs;
        body["formats"] = QJsonArray::fromStringList(m_engine->audioFormats());
        body["canPlay"] = outputs.isEmpty() == false
                          && m_engine->audioFormats().isEmpty() == false;

        if (m_engine->audioFormats().isEmpty())
        {
            body["silentBecause"] = QStringLiteral(
                "No audio decoder plugin was found, so no file can be read. They install "
                "alongside the output plugins, under audio/.");
        }
        else if (outputs.isEmpty())
        {
            body["silentBecause"] = QStringLiteral(
                "This machine reports no audio outputs, so there is nowhere to put the "
                "samples. On a server that usually means no sound server is running for "
                "this user.");
        }

        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/audio", QHttpServerRequest::Method::Put,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const QString input = body.value("input").toString();

        if (m_engine->audio()->selectInput(input) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("No audio input called \"%1\". Available: %2")
                                 .arg(input, AudioTriggers::availableInputs()
                                                 .join(QStringLiteral(", "))));
        }

        QJsonObject response;
        response["selected"] = AudioTriggers::selectedInput();
        response["capturing"] = m_engine->audio()->isCapturing();
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

        /* The name travels in the same request that creates the universe.
           This route used to ignore its body, which cost nothing visible: the
           universe appeared, named "Universe N", and the name the operator
           typed was quietly gone. */
        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString name = asked.value(QStringLiteral("name")).toString();

        const DocWriter::Result added = DocWriter::addUniverse(doc);
        if (added.ok && name.isEmpty() == false)
        {
            const int index = int(doc->inputOutputMap()->universesCount()) - 1;
            const DocWriter::Result named = DocWriter::renameUniverse(doc, index, name);
            if (named.ok == false)
            {
                QJsonObject body;
                return writeResult(named, body);
            }
        }

        QJsonObject body;
        body["universes"] = int(doc->inputOutputMap()->universesCount());
        return writeResult(added, body);
    });

    m_server->route("/api/v1/universes/<arg>/parameters", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &rawIndex, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int index = rawIndex.toInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a number"));

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        if (body.value("parameters").isObject() == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Send {\"target\": \"input\"|\"output\", "
                                            "\"index\": n, \"parameters\": {key: value}}"));
        }

        QMap<QString, QVariant> parameters;
        const QJsonObject raw = body.value("parameters").toObject();
        for (auto it = raw.constBegin(); it != raw.constEnd(); ++it)
            parameters.insert(it.key(), it.value().toVariant());

        const DocWriter::Result result = DocWriter::setPatchParameters(
            doc, index, body.value("target").toString(QStringLiteral("output")),
            body.value("index").toInt(0), parameters);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["universe"] = index;
        return QHttpServerResponse(response);
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
                                          output.value("line").toString(),
                                          output.value("index").toInt(-1));
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

        /* Where this universe's feedback goes out: the motorized faders and
           LEDs of whatever is patched as its input. Cleared with an empty
           plugin, like the output. */
        if (patch.contains("feedback"))
        {
            const QJsonObject feedback = patch.value("feedback").toObject();
            const DocWriter::Result result =
                DocWriter::setFeedbackPatch(doc, index, feedback.value("plugin").toString(),
                                            feedback.value("line").toString());
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

        /* A recovery copy newer than the project it shadows. Reported, never
           auto-loaded: the operator decides whether the crash's last thirty
           seconds are worth more than what the file says. */
        const QString autosave = m_engine->pendingAutosave();
        if (autosave.isEmpty() == false)
        {
            QJsonObject recovery;
            recovery["name"] = QFileInfo(autosave).fileName();
            recovery["savedAt"] =
                QFileInfo(autosave).lastModified().toString(Qt::ISODate);
            body["autosave"] = recovery;
        }

        /* The function the show opens with. -1 is "none", like the file. */
        body["startupFunction"] = doc->startupFunction() == Function::invalidId()
            ? qint64(-1)
            : qint64(doc->startupFunction());

        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project", QHttpServerRequest::Method::Patch,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject patch = QJsonDocument::fromJson(request.body()).object();
        if (patch.contains(QStringLiteral("startupFunction")))
        {
            const DocWriter::Result result = DocWriter::setStartupFunction(
                doc, qint64(patch.value(QStringLiteral("startupFunction")).toDouble(-1)));
            if (result.ok == false)
                return jsonError(StatusCode::BadRequest, result.error);
        }

        QJsonObject body;
        body["startupFunction"] = doc->startupFunction() == Function::invalidId()
            ? qint64(-1)
            : qint64(doc->startupFunction());
        return QHttpServerResponse(body);
    });

    /* Media for the matrices: an image or GIF, dropped next to the projects
       so the show travels with its pictures. The name is a bare file name --
       no directories, no dot-dot -- and only image types QImage can read. */
    m_server->route("/api/v1/assets", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QUrlQuery query(request.url());
        const QString name = QFileInfo(query.queryItemValue(QStringLiteral("name"))).fileName();
        if (name.isEmpty())
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Give the file a name: POST /assets?name=logo.png"));

        static const QStringList allowed{QStringLiteral("png"), QStringLiteral("jpg"),
                                         QStringLiteral("jpeg"), QStringLiteral("gif"),
                                         QStringLiteral("bmp"), QStringLiteral("webp")};
        if (allowed.contains(QFileInfo(name).suffix().toLower()) == false)
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Only image files: %1").arg(allowed.join(", ")));

        const QByteArray data = request.body();
        if (data.isEmpty())
            return jsonError(StatusCode::BadRequest, QStringLiteral("The body is the file"));
        if (data.size() > 20 * 1024 * 1024)
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("20 MB is the cap for an asset"));

        QDir assets(m_engine->projectsDirectory() + QStringLiteral("/assets"));
        if (assets.exists() == false && assets.mkpath(QStringLiteral(".")) == false)
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("Could not create the assets directory"));

        const QString path = assets.filePath(name);
        QFile file(path);
        if (file.open(QIODevice::WriteOnly) == false)
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("Could not write %1").arg(path));
        file.write(data);
        file.close();

        QJsonObject response;
        response["path"] = path;
        response["size"] = qint64(data.size());
        return QHttpServerResponse(response, StatusCode::Created);
    });

    /* Palettes: one value with a name, referenced from scenes -- retint the
       palette and every look that carries it retints with it. */
    m_server->route("/api/v1/palettes", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray palettes;
        for (const QLCPalette *palette : doc->palettes())
        {
            QJsonObject entry;
            entry["id"] = qint64(palette->id());
            entry["name"] = palette->name();
            entry["type"] = QLCPalette::typeToString(palette->type());
            entry["values"] = QJsonArray::fromVariantList(palette->values());

            QJsonObject fanning;
            fanning["type"] = QLCPalette::fanningTypeToString(palette->fanningType());
            fanning["layout"] = QLCPalette::fanningLayoutToString(palette->fanningLayout());
            fanning["amount"] = palette->fanningAmount();
            fanning["value"] = QJsonValue::fromVariant(palette->fanningValue());
            entry["fanning"] = fanning;
            palettes.append(entry);
        }

        QJsonObject body;
        body["palettes"] = palettes;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/palettes", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        quint32 newId = QLCPalette::invalidId();
        const DocWriter::Result result =
            DocWriter::addPalette(doc, body.value(QStringLiteral("type")).toString(),
                                  body.value(QStringLiteral("name")).toString(), body, newId);
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(newId);
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/palettes/<arg>", QHttpServerRequest::Method::Patch,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Palette id must be a number"));

        const DocWriter::Result result =
            DocWriter::updatePalette(doc, id, QJsonDocument::fromJson(request.body()).object());
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        QJsonObject response;
        response["id"] = qint64(id);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/palettes/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Palette id must be a number"));

        const DocWriter::Result result = DocWriter::removePalette(doc, id);
        if (result.ok == false)
            return jsonError(StatusCode::Conflict, result.error);

        QJsonObject response;
        response["removed"] = qint64(id);
        return QHttpServerResponse(response);
    });

    /* Apply: the palette resolved against fixtures, held on the LIVE desk --
       which is exactly what lets the dump capture an applied palette. */
    m_server->route("/api/v1/palettes/<arg>/apply", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawId, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 id = rawId.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Palette id must be a number"));

        QLCPalette *palette = doc->palette(id);
        if (palette == nullptr)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such palette"));

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        QList<quint32> fixtures;
        for (const QJsonValue &value : asked.value(QStringLiteral("fixtures")).toArray())
        {
            const int fixtureId = value.toInt(-1);
            if (fixtureId < 0 || doc->fixture(quint32(fixtureId)) == nullptr)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("No fixture with id %1").arg(fixtureId));
            fixtures.append(quint32(fixtureId));
        }
        if (fixtures.isEmpty())
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Give {\"fixtures\": [ids]} to apply onto"));

        const QList<SceneValue> resolved = palette->valuesFromFixtures(doc, fixtures);
        for (const SceneValue &value : resolved)
            m_engine->levels()->setLiveValue(value.fxi, value.channel, value.value);

        QJsonObject response;
        response["applied"] = resolved.count();
        return QHttpServerResponse(response);
    });

    /* The gel books: colour filter collections shipped with the daemon. Read
       per request -- they are a handful of small XML files -- and served with
       names, because a gel without its name is just a hex code. */
    m_server->route("/api/v1/colorfilters", QHttpServerRequest::Method::Get,
                    [denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QJsonArray books;
        const QString directory = InstallPaths::colorFilters();
        if (directory.isEmpty() == false)
        {
            for (const QFileInfo &info :
                 QDir(directory).entryInfoList({QStringLiteral("*.qxcf")}, QDir::Files))
            {
                QFile file(info.absoluteFilePath());
                if (file.open(QIODevice::ReadOnly) == false)
                    continue;

                QXmlStreamReader reader(&file);
                QString bookName = info.baseName();
                QJsonArray colors;
                while (reader.readNextStartElement() || reader.atEnd() == false)
                {
                    if (reader.isStartElement() == false)
                    {
                        if (reader.atEnd())
                            break;
                        continue;
                    }
                    if (reader.name() == QStringLiteral("Name")
                        && colors.isEmpty() && reader.prefix().isEmpty())
                    {
                        const QString text = reader.readElementText();
                        if (text.isEmpty() == false)
                            bookName = text;
                    }
                    else if (reader.name() == QStringLiteral("Color"))
                    {
                        QJsonObject color;
                        color["name"] =
                            reader.attributes().value(QStringLiteral("Name")).toString();
                        color["rgb"] =
                            reader.attributes().value(QStringLiteral("RGB")).toString();
                        colors.append(color);
                        reader.skipCurrentElement();
                    }
                }
                file.close();

                if (colors.isEmpty())
                    continue;
                QJsonObject book;
                book["name"] = bookName;
                book["colors"] = colors;
                books.append(book);
            }
        }

        QJsonObject body;
        body["filters"] = books;
        return QHttpServerResponse(body);
    });

    /* The script checker: the engine's own tokenizer, run on whatever text
       arrives, answering WHICH lines it refuses. Stateless -- nothing is
       created or modified. */
    m_server->route("/api/v1/script/check", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        Script probe(doc);
        probe.setData(asked.value(QStringLiteral("data")).toString());

        QJsonArray lines;
        for (int line : probe.syntaxErrorsLines())
            lines.append(line);

        QJsonObject body;
        body["errors"] = lines;
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

    /* The disk-path routes. Strict token, whatever the loopback policy says:
       the rest of the API touches the show, these touch the filesystem, and
       "anything on this machine may run lights" must never grow into
       "anything that can reach this socket can read or write my files". The
       desktop shell holds the token; a phone on the venue network does not.

       The name-only routes above stay as the phone-safe surface. */
    m_server->route("/api/v1/project/new", QHttpServerRequest::Method::Post,
                    [this](const QHttpServerRequest &request) {
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        m_engine->newProject();

        QJsonObject body;
        body["path"] = QString();
        body["modified"] = false;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project/open", QHttpServerRequest::Method::Post,
                    [this](const QHttpServerRequest &request) {
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString path = asked.value(QStringLiteral("path")).toString();
        if (path.isEmpty() || QFileInfo(path).isAbsolute() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Give an absolute path"));
        if (path.endsWith(QStringLiteral(".qxw"), Qt::CaseInsensitive) == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Only .qxw projects open"));
        if (QFileInfo::exists(path) == false)
            return jsonError(StatusCode::NotFound, QStringLiteral("No such file"));

        QString errorMessage;
        if (m_engine->loadProject(path, errorMessage) == false)
            return jsonError(StatusCode::Conflict, errorMessage);

        rememberRecent(path);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        const QString unresolved = m_engine->projectErrors();
        if (unresolved.isEmpty() == false)
            body["unresolved"] = unresolved;
        return QHttpServerResponse(body);
    });

    /* Input profiles: what each control on a MIDI wing IS. The editor's whole
       job is writing .qxi files QLC+ itself would load; learning a control is
       the web reading /input/last and filling the channel in. Only profiles in
       the user directory can be edited -- the system ones ship with the
       installation and are every project's shared vocabulary. */
    m_server->route("/api/v1/inputprofiles/<arg>", QHttpServerRequest::Method::Get,
                    [doc, denied](const QString &name, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QLCInputProfile *profile = doc->inputOutputMap()->profile(name);
        if (profile == nullptr)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("No input profile named \"%1\"").arg(name));

        QJsonObject body;
        body["name"] = profile->name();
        body["manufacturer"] = profile->manufacturer();
        body["model"] = profile->model();
        body["type"] = QLCInputProfile::typeToString(profile->type());
        body["editable"] = profile->path().startsWith(
            InputOutputMap::userProfileDirectory().absolutePath());

        QJsonArray channels;
        const QMap<quint32, QLCInputChannel *> map = profile->channels();
        for (auto it = map.constBegin(); it != map.constEnd(); ++it)
        {
            QJsonObject channel;
            channel["channel"] = qint64(it.key());
            channel["name"] = it.value()->name();
            channel["type"] = QLCInputChannel::typeToString(it.value()->type());
            channels.append(channel);
        }
        body["channels"] = channels;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/inputprofiles", QHttpServerRequest::Method::Post,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const QString manufacturer = body.value("manufacturer").toString().trimmed();
        const QString model = body.value("model").toString().trimmed();
        if (manufacturer.isEmpty() || model.isEmpty())
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("A profile needs a manufacturer and a model"));
        }

        const QString name = QStringLiteral("%1 %2").arg(manufacturer, model);
        if (doc->inputOutputMap()->profile(name) != nullptr)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("There is already a profile named \"%1\"").arg(name));
        }

        QLCInputProfile *profile = new QLCInputProfile();
        profile->setManufacturer(manufacturer);
        profile->setModel(model);
        const QString typeName = body.value("type").toString(QStringLiteral("MIDI"));
        profile->setType(QLCInputProfile::stringToType(typeName));

        QDir directory = InputOutputMap::userProfileDirectory();
        const QString fileName = QStringLiteral("%1-%2.qxi")
            .arg(manufacturer, model).replace(QChar(' '), QChar('-'));
        const QString path = directory.absoluteFilePath(fileName);
        if (profile->saveXML(path) == false)
        {
            delete profile;
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("Could not write %1").arg(path));
        }

        if (doc->inputOutputMap()->addProfile(profile) == false)
        {
            delete profile;
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("The engine refused the profile"));
        }

        QJsonObject response;
        response["name"] = name;
        return QHttpServerResponse(response, StatusCode::Created);
    });

    m_server->route("/api/v1/inputprofiles/<arg>/channels/<arg>", QHttpServerRequest::Method::Put,
                    [doc, denied](const QString &name, const QString &rawChannel,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 number = rawChannel.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Channel must be a number"));

        QLCInputProfile *profile = doc->inputOutputMap()->profile(name);
        if (profile == nullptr)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("No input profile named \"%1\"").arg(name));
        if (profile->path().startsWith(
                InputOutputMap::userProfileDirectory().absolutePath()) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"%1\" ships with the installation; copy it into "
                                            "a new profile to change it").arg(name));
        }

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        const QString typeName = body.value("type").toString(QStringLiteral("Button"));
        const QLCInputChannel::Type type = QLCInputChannel::stringToType(typeName);
        if (QLCInputChannel::typeToString(type) != typeName)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"%1\" is not a channel type").arg(typeName));
        }

        QLCInputChannel *channel = new QLCInputChannel();
        channel->setName(body.value("name").toString());
        channel->setType(type);

        profile->removeChannel(number);
        if (profile->insertChannel(number, channel) == false)
        {
            delete channel;
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("The profile refused channel %1").arg(number));
        }

        if (profile->saveXML(profile->path()) == false)
        {
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("Could not write %1").arg(profile->path()));
        }

        QJsonObject response;
        response["channel"] = qint64(number);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/inputprofiles/<arg>/channels/<arg>",
                    QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &name, const QString &rawChannel,
                                  const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const quint32 number = rawChannel.toUInt(&ok);
        if (ok == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Channel must be a number"));

        QLCInputProfile *profile = doc->inputOutputMap()->profile(name);
        if (profile == nullptr)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("No input profile named \"%1\"").arg(name));
        if (profile->path().startsWith(
                InputOutputMap::userProfileDirectory().absolutePath()) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"%1\" ships with the installation").arg(name));
        }

        if (profile->removeChannel(number) == false)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("The profile has no channel %1").arg(number));

        if (profile->saveXML(profile->path()) == false)
        {
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("Could not write %1").arg(profile->path()));
        }

        QJsonObject response;
        response["removed"] = qint64(number);
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/inputprofiles/<arg>", QHttpServerRequest::Method::Delete,
                    [doc, denied](const QString &name, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        QLCInputProfile *profile = doc->inputOutputMap()->profile(name);
        if (profile == nullptr)
            return jsonError(StatusCode::NotFound,
                             QStringLiteral("No input profile named \"%1\"").arg(name));
        if (profile->path().startsWith(
                InputOutputMap::userProfileDirectory().absolutePath()) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"%1\" ships with the installation").arg(name));
        }

        const QString path = profile->path();
        if (doc->inputOutputMap()->removeProfile(name) == false)
            return jsonError(StatusCode::InternalServerError,
                             QStringLiteral("The engine refused to drop the profile"));
        QFile::remove(path);

        QJsonObject response;
        response["removed"] = name;
        return QHttpServerResponse(response);
    });

    /* The global beat: QLC+'s BPM toolbar. Internal means the engine's own
       metronome; chasers whose tempo is Beats advance on it. */
    m_server->route("/api/v1/beat", QHttpServerRequest::Method::Get,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        /* Through InputOutputMap rather than straight at the timer: the
           generator type is what the .qxw persists, and a project can arrive
           with the metronome already armed. */
        QJsonObject body;
        body["source"] = doc->inputOutputMap()->beatGeneratorType() == InputOutputMap::Internal
            ? QStringLiteral("internal") : QStringLiteral("none");
        body["bpm"] = doc->masterTimer()->bpmNumber();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/beat", QHttpServerRequest::Method::Put,
                    [doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject body = QJsonDocument::fromJson(request.body()).object();
        InputOutputMap *map = doc->inputOutputMap();

        if (body.contains("source"))
        {
            const QString source = body.value("source").toString();
            if (source == QStringLiteral("internal"))
                map->setBeatGeneratorType(InputOutputMap::Internal);
            else if (source == QStringLiteral("none"))
                map->setBeatGeneratorType(InputOutputMap::Disabled);
            else
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("\"source\" is internal or none (external "
                                                "sources arrive with MIDI clock support)"));
            }
            doc->setModified();
        }

        if (body.contains("bpm"))
        {
            const int bpm = body.value("bpm").toInt(-1);
            if (bpm < 1 || bpm > 500)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("BPM must be between 1 and 500"));
            /* Straight at the timer as well as through the map: the map
               swallows a BPM while the generator is off, and asking for a
               tempo should never be silently ignored. */
            doc->masterTimer()->requestBpmNumber(bpm);
            map->setBpmNumber(bpm);
        }

        QJsonObject response;
        response["source"] = map->beatGeneratorType() == InputOutputMap::Internal
            ? QStringLiteral("internal") : QStringLiteral("none");
        response["bpm"] = doc->masterTimer()->bpmNumber();
        return QHttpServerResponse(response);
    });

    m_server->route("/api/v1/project/import/preview", QHttpServerRequest::Method::Post,
                    [this, doc](const QHttpServerRequest &request) {
        /* A disk path from the network: the strict token, like save-as. */
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString path = asked.value(QStringLiteral("path")).toString();
        if (path.isEmpty() || QFileInfo(path).isAbsolute() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Give an absolute path"));

        QJsonObject out;
        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&] {
            result = ProjectImport::preview(doc, path, out);
            return true;
        });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(out);
    });

    m_server->route("/api/v1/project/import", QHttpServerRequest::Method::Post,
                    [this, doc](const QHttpServerRequest &request) {
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString path = asked.value(QStringLiteral("path")).toString();
        if (path.isEmpty() || QFileInfo(path).isAbsolute() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Give an absolute path"));

        /* "all", or a list of ids. Absent means none of that kind. */
        ProjectImport::Selection selection;
        const auto pick = [&asked](const char *key, bool &all, QList<quint32> &ids) -> bool {
            const QJsonValue value = asked.value(QLatin1String(key));
            if (value.isUndefined())
                return true;
            if (value.isString() && value.toString() == QStringLiteral("all"))
            {
                all = true;
                return true;
            }
            if (value.isArray() == false)
                return false;
            for (const QJsonValue &entry : value.toArray())
            {
                if (entry.isDouble() == false || entry.toInt(-1) < 0)
                    return false;
                ids.append(quint32(entry.toInt()));
            }
            return true;
        };
        if (pick("fixtures", selection.allFixtures, selection.fixtures) == false
            || pick("functions", selection.allFunctions, selection.functions) == false)
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("\"fixtures\" and \"functions\" are \"all\" or "
                                            "arrays of ids from the preview"));
        }
        if (selection.allFixtures == false && selection.fixtures.isEmpty()
            && selection.allFunctions == false && selection.functions.isEmpty())
        {
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Nothing chosen: name fixtures, functions or both"));
        }

        QJsonObject report;
        DocWriter::Result result = DocWriter::Result::success();
        m_engine->withFixturesLocked([&] {
            result = ProjectImport::apply(doc, path, selection, report);
            return true;
        });
        if (result.ok == false)
            return jsonError(StatusCode::BadRequest, result.error);

        return QHttpServerResponse(report);
    });

    m_server->route("/api/v1/project/save-as", QHttpServerRequest::Method::Post,
                    [this](const QHttpServerRequest &request) {
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        QString path = asked.value(QStringLiteral("path")).toString();
        if (path.isEmpty() || QFileInfo(path).isAbsolute() == false)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Give an absolute path"));
        /* The suffix is appended, not demanded: every file dialog in the
           world lets the operator type a bare name, and refusing it would
           make the shell re-implement this rule. */
        if (path.endsWith(QStringLiteral(".qxw"), Qt::CaseInsensitive) == false)
            path += QStringLiteral(".qxw");

        QString errorMessage;
        if (m_engine->saveProject(path, errorMessage) == false)
            return jsonError(StatusCode::Conflict, errorMessage);

        rememberRecent(path);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project/recover", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        /* Ordinary auth: this loads a file the daemon itself wrote next to
           the project, never a path a client chose. */
        if (denied(request))
            return unauthorized();

        QString errorMessage;
        if (m_engine->recoverAutosave(errorMessage) == false)
            return jsonError(StatusCode::Conflict, errorMessage);

        QJsonObject body;
        body["path"] = m_engine->projectPath();
        body["modified"] = true;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/project/recents", QHttpServerRequest::Method::Get,
                    [this](const QHttpServerRequest &request) {
        /* Strict as well: a list of paths is a map of the disk. */
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        QJsonArray entries;
        for (const QString &path : recentProjects())
        {
            QJsonObject entry;
            entry["path"] = path;
            entry["name"] = QFileInfo(path).fileName();
            entry["exists"] = QFileInfo::exists(path);
            entries.append(entry);
        }

        QJsonObject body;
        body["recents"] = entries;
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

    m_server->route("/api/v1/grandmaster", QHttpServerRequest::Method::Get,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const EngineHost::GrandMasterState state = m_engine->grandMaster();
        QJsonObject body;
        body["value"] = state.value;
        body["channelMode"] = state.channelMode;
        body["valueMode"] = state.valueMode;
        body["visible"] = state.visible;
        if (state.hasInput)
        {
            QJsonObject input;
            input["universe"] = qint64(state.inputUniverse);
            input["channel"] = qint64(state.inputChannel);
            body["input"] = input;
        }
        else
            body["input"] = QJsonValue::Null;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/grandmaster", QHttpServerRequest::Method::Put,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();

        const int value = asked.contains(QStringLiteral("value"))
            ? asked.value(QStringLiteral("value")).toInt(-1)
            : -1;
        if (asked.contains(QStringLiteral("value")) && value < 0)
            return jsonError(StatusCode::BadRequest, QStringLiteral("value must be 0..255"));

        const int visible = asked.contains(QStringLiteral("visible"))
            ? (asked.value(QStringLiteral("visible")).toBool() ? 1 : 0)
            : -1;

        QString errorMessage;
        if (m_engine->setGrandMaster(value,
                                     asked.value(QStringLiteral("channelMode")).toString(),
                                     asked.value(QStringLiteral("valueMode")).toString(),
                                     visible, errorMessage)
            == false)
        {
            return jsonError(StatusCode::BadRequest, errorMessage);
        }

        /* The external control bound to the big fader. {universe, channel}
           binds, null unbinds, absent leaves it alone -- the same contract a
           widget's input patch uses. */
        if (asked.contains(QStringLiteral("input")))
        {
            const QJsonValue input = asked.value(QStringLiteral("input"));
            bool ok = false;
            if (input.isNull())
                ok = m_engine->setGrandMasterInput(false, 0, 0, errorMessage);
            else if (input.isObject())
            {
                const QJsonObject bound = input.toObject();
                const int universe = bound.value(QStringLiteral("universe")).toInt(-1);
                const int channel = bound.value(QStringLiteral("channel")).toInt(-1);
                if (universe < 0 || channel < 0)
                {
                    return jsonError(StatusCode::BadRequest,
                                     QStringLiteral("An input needs a non-negative "
                                                    "\"universe\" and \"channel\""));
                }
                ok = m_engine->setGrandMasterInput(true, quint32(universe),
                                                   quint32(channel), errorMessage);
            }
            else
            {
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("\"input\" is {\"universe\": n, "
                                                "\"channel\": n} or null"));
            }
            if (ok == false)
                return jsonError(StatusCode::BadRequest, errorMessage);
        }

        const EngineHost::GrandMasterState state = m_engine->grandMaster();
        QJsonObject body;
        body["value"] = state.value;
        body["channelMode"] = state.channelMode;
        body["valueMode"] = state.valueMode;
        body["visible"] = state.visible;
        if (state.hasInput)
        {
            QJsonObject input;
            input["universe"] = qint64(state.inputUniverse);
            input["channel"] = qint64(state.inputChannel);
            body["input"] = input;
        }
        else
            body["input"] = QJsonValue::Null;
        return QHttpServerResponse(body);
    });

    /* The Simple Desk: raw channels of a universe, held by hand -- including
       channels with no fixture patched, which is precisely what tells this
       desk apart from /live. Universe indices here are the 1-based ids the
       /universes list shows. */
    m_server->route("/api/v1/simpledesk/<arg>", QHttpServerRequest::Method::Get,
                    [this, denied](const QString &rawUniverse, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int universe = rawUniverse.toInt(&ok) - 1;
        if (ok == false || universe < 0)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a 1-based number"));

        const QHash<quint32, uchar> held = m_engine->desk()->held(quint32(universe));
        QJsonObject channels;
        for (auto it = held.constBegin(); it != held.constEnd(); ++it)
            channels.insert(QString::number(it.key() + 1), int(it.value()));

        QJsonObject body;
        body["universe"] = universe + 1;
        body["held"] = channels;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/simpledesk/<arg>/channels", QHttpServerRequest::Method::Put,
                    [this, denied](const QString &rawUniverse, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int universe = rawUniverse.toInt(&ok) - 1;
        if (ok == false || universe < 0)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a 1-based number"));

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QJsonObject values = asked.value(QStringLiteral("values")).toObject();
        if (values.isEmpty())
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("Give {\"values\": {\"<canal 1-512>\": 0-255}}"));

        /* Validated whole before anything lands: a request that is half
           nonsense must not half-happen. */
        QVector<QPair<quint32, uchar>> parsed;
        for (auto it = values.constBegin(); it != values.constEnd(); ++it)
        {
            bool channelOk = false;
            const int channel = it.key().toInt(&channelOk);
            const int value = it.value().toInt(-1);
            if (channelOk == false || channel < 1 || channel > 512)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Channel %1 is not 1..512").arg(it.key()));
            if (value < 0 || value > 255)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Value for channel %1 is not 0..255").arg(it.key()));
            parsed.append({quint32(channel - 1), uchar(value)});
        }

        for (const auto &pair : parsed)
            m_engine->desk()->setChannel(quint32(universe), pair.first, pair.second);

        emit m_engine->deskChanged(quint32(universe));

        QJsonObject body;
        body["universe"] = universe + 1;
        body["held"] = int(m_engine->desk()->held(quint32(universe)).size());
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/simpledesk/<arg>/channels/<arg>",
                    QHttpServerRequest::Method::Delete,
                    [this, denied](const QString &rawUniverse, const QString &rawChannel,
                                   const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int universe = rawUniverse.toInt(&ok) - 1;
        bool channelOk = false;
        const int channel = rawChannel.toInt(&channelOk);
        if (ok == false || universe < 0 || channelOk == false || channel < 1 || channel > 512)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe or channel out of range"));

        m_engine->desk()->resetChannel(quint32(universe), quint32(channel - 1));
        emit m_engine->deskChanged(quint32(universe));

        QJsonObject body;
        body["released"] = channel;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/simpledesk/<arg>", QHttpServerRequest::Method::Delete,
                    [this, denied](const QString &rawUniverse, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int universe = rawUniverse.toInt(&ok) - 1;
        if (ok == false || universe < 0)
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a 1-based number"));

        m_engine->desk()->resetUniverse(quint32(universe));
        emit m_engine->deskChanged(quint32(universe));

        QJsonObject body;
        body["released"] = universe + 1;
        return QHttpServerResponse(body);
    });

    /* What a dump would capture, live: the button in the bar wears this
       number. `bare` counts what the desk holds on unpatched addresses --
       values a scene has no words for, said instead of silently shrunk. */
    m_server->route("/api/v1/dump", QHttpServerRequest::Method::Get,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QList<EngineHost::DumpValue> values = m_engine->dumpableValues();
        QSet<int> groups;
        for (const EngineHost::DumpValue &value : values)
            groups.insert(value.group);

        QJsonArray kinds;
        for (int group : groups)
            kinds.append(QLCChannel::groupToString(QLCChannel::Group(group)));

        QJsonObject body;
        body["count"] = values.count();
        body["bare"] = m_engine->bareHeldCount();
        body["groups"] = kinds;
        return QHttpServerResponse(body);
    });

    m_server->route("/api/v1/dump", QHttpServerRequest::Method::Post,
                    [this, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString name = asked.value(QStringLiteral("name")).toString();
        const quint32 sceneId = asked.contains(QStringLiteral("sceneId"))
            ? quint32(asked.value(QStringLiteral("sceneId")).toDouble())
            : Function::invalidId();
        const bool nonZeroOnly = asked.value(QStringLiteral("nonZeroOnly")).toBool(false);

        QList<int> groups;
        for (const QJsonValue &entry : asked.value(QStringLiteral("groups")).toArray())
        {
            const QLCChannel::Group group =
                QLCChannel::stringToGroup(entry.toString());
            if (group == QLCChannel::NoGroup)
                return jsonError(StatusCode::BadRequest,
                                 QStringLiteral("Unknown channel group \"%1\"")
                                     .arg(entry.toString()));
            groups.append(int(group));
        }

        quint32 outSceneId = Function::invalidId();
        int written = 0;
        QString errorMessage;
        if (m_engine->dumpToScene(name, sceneId, nonZeroOnly, groups, outSceneId,
                                  written, errorMessage)
            == false)
        {
            return jsonError(StatusCode::Conflict, errorMessage);
        }

        QJsonObject body;
        body["scene"] = qint64(outSceneId);
        body["written"] = written;
        return QHttpServerResponse(body, StatusCode::Created);
    });

    /* The keypad, parsed by the engine's own parser so "1 THRU 10 AT FULL"
       means here exactly what it means in QLC+ 5 -- including the relative
       commands, which read the universe's current values as their base. */
    m_server->route("/api/v1/simpledesk/<arg>/keypad", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QString &rawUniverse, const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        bool ok = false;
        const int universe = rawUniverse.toInt(&ok) - 1;
        if (ok == false || universe < 0
            || quint32(universe) >= doc->inputOutputMap()->universesCount())
            return jsonError(StatusCode::BadRequest, QStringLiteral("Universe must be a 1-based number"));

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const QString command = asked.value(QStringLiteral("command")).toString().trimmed();
        if (command.isEmpty())
            return jsonError(StatusCode::BadRequest, QStringLiteral("Give {\"command\": \"...\"}"));

        const QList<Universe *> universes = doc->inputOutputMap()->universes();
        QByteArray uniData = universes.at(universe)->preGMValues();

        KeyPadParser parser;
        const QList<SceneValue> values =
            parser.parseCommand(doc, command.toUpper(), uniData);
        if (values.isEmpty())
            return jsonError(StatusCode::BadRequest,
                             QStringLiteral("The command names no channels"));

        QJsonArray applied;
        for (const SceneValue &value : values)
        {
            m_engine->desk()->setChannel(quint32(universe), value.channel, value.value);
            QJsonObject one;
            one["channel"] = int(value.channel) + 1;
            one["value"] = int(value.value);
            applied.append(one);
        }

        emit m_engine->deskChanged(quint32(universe));

        QJsonObject body;
        body["universe"] = universe + 1;
        body["applied"] = applied;
        return QHttpServerResponse(body);
    });

    /* Stop is not blackout: it ends every running function -- optionally
       fading it out over a moment -- and touches nothing else. QLC+ calls
       this the panic button, and a panic that can only snap to black makes
       operators hesitate to press it. */
    m_server->route("/api/v1/stop", QHttpServerRequest::Method::Post,
                    [this, doc, denied](const QHttpServerRequest &request) {
        if (denied(request))
            return unauthorized();

        const QJsonObject asked = QJsonDocument::fromJson(request.body()).object();
        const int fadeMs = asked.value(QStringLiteral("fadeMs")).toInt(0);
        if (fadeMs < 0 || fadeMs > 60000)
            return jsonError(StatusCode::BadRequest, QStringLiteral("fadeMs must be 0..60000"));

        m_engine->stopEverything(fadeMs);

        QJsonObject body;
        body["stopping"] = doc->masterTimer()->runningFunctions();
        body["fadeMs"] = fadeMs;
        QHttpServerResponse response(body, StatusCode::Accepted);
        return response;
    });

    /* Not `denied`: the token is demanded even on loopback, where the rest of
       the API deliberately works without one. Killing the desk is in a
       different class from using it, and the strict check is what keeps
       "anything on this machine may run lights" from becoming "anything that
       can open a socket may stop the show". The desktop shell holds the token;
       a phone on the venue network does not. */
    m_server->route("/api/v1/shutdown", QHttpServerRequest::Method::Post,
                    [this](const QHttpServerRequest &request) {
        if (m_auth.authorizeStrict(request) == false)
            return unauthorized();

        /* Accepted, not done: the response has to leave before the process
           starts dying, so the emission is queued behind this handler. */
        QMetaObject::invokeMethod(this, [this]() {
            emit shutdownRequested();
        }, Qt::QueuedConnection);

        QJsonObject body;
        body["shuttingDown"] = true;
        QHttpServerResponse response(body, StatusCode::Accepted);
        noCache(response);
        return response;
    });
}
