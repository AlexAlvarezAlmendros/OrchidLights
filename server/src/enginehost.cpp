/*
  OrchidLights
  enginehost.cpp

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

#include <functional>
#include <algorithm>

#include <QJsonObject>
#include <QJsonArray>
#include <QFileInfo>
#include <QDir>
#include <QSet>
#include <QEventLoop>
#include <QTimer>
#include <QDateTime>

#include "enginehost.h"
#include "installpaths.h"
#include "fixturelibrary.h"
#include "workspaceloader.h"
#include "virtualconsole.h"
#include "docwriter.h"
#include "levelsource.h"
#include "inputrouter.h"
#include "simpledesksource.h"

#include "qlcfile.h"
#include "qlcmodifierscache.h"
#include "rgbscriptscache.h"
#include "ioplugincache.h"
#include "qlcioplugin.h"
#include "audioplugincache.h"
#include "audiorenderer.h"
#include "inputoutputmap.h"
#include "grandmaster.h"
#include "mastertimer.h"
#include "channelsgroup.h"
#include "function.h"
#include "universe.h"
#include "fixture.h"
#include "doc.h"

EngineHost::EngineHost(QObject *parent)
    : QObject(parent)
{
}

EngineHost::~EngineHost()
{
    if (m_doc != nullptr && m_running)
        m_doc->masterTimer()->stop();

    if (m_doc != nullptr && m_levels != nullptr)
        m_doc->masterTimer()->unregisterDMXSource(m_levels);
    if (m_doc != nullptr && m_desk != nullptr)
        m_doc->masterTimer()->unregisterDMXSource(m_desk);

    delete m_levels;
    delete m_desk;
}

void EngineHost::shutDown(bool zeroOutput)
{
    if (m_doc == nullptr || m_running == false)
        return;

    m_doc->masterTimer()->stopAllFunctions();

    if (zeroOutput)
    {
        /* Blackout zeroes the universes on the next timer tick; the tick runs
           in the timer's own thread at 50 Hz. Spinning the local event loop for
           a handful of ticks is what turns "we asked for dark" into "the zeroed
           frame left through the plugins" -- the only version an ArtNet node on
           the other end can tell apart. */
        m_doc->inputOutputMap()->setBlackout(true);

        QEventLoop settle;
        QTimer::singleShot(120, &settle, &QEventLoop::quit);
        settle.exec();
    }

    m_doc->masterTimer()->stop();
    m_running = false;
}

bool EngineHost::start(const Options &options, QString &errorMessage)
{
    Q_ASSERT(m_doc == nullptr);

    m_doc = new Doc(this);

    /* Fixture definitions. User profiles are read before the system library so
       they win on conflicts, matching QLC+. */
    const FixtureLibrary::Result library =
        FixtureLibrary::load(m_doc, options.fixtureDirectory);

    m_manufacturers = library.manufacturers;
    m_fixturePath = library.systemPath;
    m_userFixturePaths = library.userPaths;

    if (m_fixturePath.isEmpty())
    {
        errorMessage = QStringLiteral(
            "No system fixture library found. Every patched fixture would fall back "
            "to a generic dimmer, losing its channel definitions. "
            "Pass --fixtures <dir> or set ORCHID_FIXTURE_DIR.");
        return false;
    }

    /* Channel modifier templates. */
    const QString modifiers = InstallPaths::modifierTemplates();
    if (modifiers.isEmpty() == false)
        m_doc->modifiersCache()->load(QDir(modifiers), true);
    m_doc->modifiersCache()->load(QLCModifiersCache::userTemplateDirectory());

    /* RGB matrix scripts. */
    const QString scripts = InstallPaths::rgbScripts();
    if (scripts.isEmpty() == false)
        m_doc->rgbScriptsCache()->load(QDir(scripts));
    m_doc->rgbScriptsCache()->load(RGBScriptsCache::userScriptsDirectory());

    /* Where the plugins live. Resolved even when the output is disabled,
       because the audio decoders are installed under the same directory and
       --no-output is a statement about the DMX network, not about a sound
       file. */
    m_pluginPath = InstallPaths::ioPlugins(options.pluginDirectory);

    /* Output plugins. Skipping them keeps the engine fully functional but
       silent on the wire. */
    if (options.noOutput == false && m_pluginPath.isEmpty() == false)
    {
        m_doc->ioPluginCache()->load(QDir(m_pluginPath));

        const QList<QLCIOPlugin *> plugins = m_doc->ioPluginCache()->plugins();
        for (QLCIOPlugin *plugin : plugins)
            m_loadedPlugins << plugin->name();
    }

    /* Audio decoders, which install alongside the output plugins.
     *
     * Loading the cache is also what fills its list of output devices, so a
       daemon that never got here cannot even say what it would play through.
       That used to be tied to --no-output, which meant every test in this
       repository ran with audio quietly switched off, and an operator who
       started the daemon with the network disabled -- the obvious thing to do
       while building a show -- got an Audio function that read its file, showed
       its length, and played nothing. */
    if (m_pluginPath.isEmpty() == false)
    {
        const QString audioPath = QDir(m_pluginPath).absoluteFilePath(QStringLiteral("audio"));
        if (QDir(audioPath).exists())
        {
            m_doc->audioPluginCache()->load(QDir(audioPath));
            m_audioFormats = m_doc->audioPluginCache()->getSupportedFormats();
        }
    }

    Q_ASSERT(m_doc->inputOutputMap() != nullptr);

    /* Input profiles, ours and the legacy QLC+ ones, for the same reason the
       fixture definitions read both. */
    const QString profiles = InstallPaths::inputProfiles();
    if (profiles.isEmpty() == false)
        m_doc->inputOutputMap()->loadProfiles(QDir(profiles));

    m_doc->inputOutputMap()->loadProfiles(InputOutputMap::userProfileDirectory());

    const QString legacyProfiles = InstallPaths::legacyUserDirectory(QStringLiteral("inputprofiles"));
    if (legacyProfiles.isEmpty() == false)
        m_doc->inputOutputMap()->loadProfiles(QDir(legacyProfiles));

    m_doc->inputOutputMap()->loadDefaults();
    m_doc->inputOutputMap()->setBeatGeneratorType(InputOutputMap::Internal);
    m_doc->inputOutputMap()->startUniverses();

    /* Every external control that moves, remembered and passed on.
     *
     * Not filtered by value: a button that sends 127 and then 0 is two events,
     * and learning from the second would bind to the release. The interface
     * decides what to keep; this only reports. */
    connect(m_doc->inputOutputMap(), &InputOutputMap::inputValueChanged, this,
            [this](quint32 universe, quint32 channel, uchar value) {
        m_lastInput = {true, universe, channel, value};
        emit inputSeen(universe, channel, value);
    });

    /* Registered before the timer starts, so the first tick already has it. */
    m_levels = new LevelSource(m_doc);
    m_doc->masterTimer()->registerDMXSource(m_levels);

    m_desk = new SimpleDeskSource(m_doc);
    m_doc->masterTimer()->registerDMXSource(m_desk);

    /* No microphone is opened here: the triggers only ask for one once a
       widget is switched on. */
    m_triggers = new AudioTriggers(m_doc, m_levels, this);

    /* External input made to act: the bindings preserved in the console XML
       become a routing table, rebuilt on every console edit and project load
       (its constructor connects itself to those signals). */
    m_router = new InputRouter(this, this);

    m_doc->masterTimer()->start();
    m_running = true;

    /* The autosave: armed by every modification, disarmed by a real save. A
       daemon crash or an impatient power strip costs at most thirty seconds
       of edits instead of the evening's. */
    m_autosave = new QTimer(this);
    m_autosave->setSingleShot(true);
    bool intervalOk = false;
    int interval = qEnvironmentVariableIntValue("ORCHID_AUTOSAVE_MS", &intervalOk);
    if (intervalOk == false || interval <= 0)
        interval = 30000;
    m_autosave->setInterval(interval);

    connect(m_autosave, &QTimer::timeout, this, [this]() {
        const QString target = autosavePath();
        if (target.isEmpty() || m_doc->isModified() == false)
            return;
        QString ignored;
        /* Through the same writer as a real save, preserved sections included:
           an autosave that loses the Virtual Console is not a recovery file,
           it is a trap that looks like one. */
        WorkspaceLoader::save(m_doc, target, m_preserved, ignored);
    });

    connect(m_doc, &Doc::modified, this, [this](bool state) {
        if (state)
            armAutosave();
    });

    return true;
}

EngineHost::GrandMasterState EngineHost::grandMaster() const
{
    GrandMasterState state;
    InputOutputMap *map = m_doc->inputOutputMap();
    state.value = map->grandMasterValue();
    state.channelMode = GrandMaster::channelModeToString(map->grandMasterChannelMode());
    state.valueMode = GrandMaster::valueModeToString(map->grandMasterValueMode());
    const VcPatch::GrandMasterSettings settings =
        VcPatch::readGrandMaster(m_preserved.sections);
    state.visible = settings.visible;
    state.hasInput = settings.hasInput;
    state.inputUniverse = settings.inputUniverse;
    state.inputChannel = settings.inputChannel;
    return state;
}

bool EngineHost::setGrandMasterInput(bool bind, quint32 universe, quint32 channel,
                                     QString &errorMessage)
{
    /* Like every persisted console change: remembered first, so the binding
       joins the console's undo history like a widget edit would. */
    rememberConsole();

    const VcPatch::Result written =
        VcPatch::writeGrandMasterInput(m_preserved.sections, bind, universe, channel);
    if (written.ok == false)
    {
        errorMessage = written.error;
        return false;
    }

    m_doc->setModified();
    emit consoleChanged();
    emit grandMasterChanged();
    return true;
}

bool EngineHost::setGrandMaster(int value, const QString &channelMode,
                                const QString &valueMode, int visible,
                                QString &errorMessage)
{
    InputOutputMap *map = m_doc->inputOutputMap();

    /* Validated before anything is applied: a request that is half nonsense
       must not half-happen. */
    if (channelMode.isEmpty() == false && channelMode != QStringLiteral("Intensity")
        && channelMode != QStringLiteral("All"))
    {
        errorMessage = QStringLiteral("channelMode must be \"Intensity\" or \"All\"");
        return false;
    }
    if (valueMode.isEmpty() == false && valueMode != QStringLiteral("Reduce")
        && valueMode != QStringLiteral("Limit"))
    {
        errorMessage = QStringLiteral("valueMode must be \"Reduce\" or \"Limit\"");
        return false;
    }
    if (value > 255)
    {
        errorMessage = QStringLiteral("value must be 0..255");
        return false;
    }

    if (value >= 0)
        map->setGrandMasterValue(uchar(value));
    if (channelMode.isEmpty() == false)
        map->setGrandMasterChannelMode(GrandMaster::stringToChannelMode(channelMode));
    if (valueMode.isEmpty() == false)
        map->setGrandMasterValueMode(GrandMaster::stringToValueMode(valueMode));

    /* The modes and visibility persist with the show; the value does not.
       Written only when they changed, so moving the big fader all night never
       marks the project dirty. */
    if (channelMode.isEmpty() == false || valueMode.isEmpty() == false || visible >= 0)
    {
        /* Persisted changes join the console's undo history, exactly like a
           widget edit: flipping the mode materializes <Properties><GrandMaster>
           in projects that never carried them, and undo is what puts the
           bytes back -- the round-trip guard in CI is what proved a
           semantic restore is not a textual one. */
        rememberConsole();

        VcPatch::GrandMasterSettings settings = VcPatch::readGrandMaster(m_preserved.sections);
        if (channelMode.isEmpty() == false)
            settings.channelMode = channelMode;
        if (valueMode.isEmpty() == false)
            settings.valueMode = valueMode;
        if (visible >= 0)
            settings.visible = visible != 0;

        const VcPatch::Result written =
            VcPatch::writeGrandMaster(m_preserved.sections, settings);
        if (written.ok == false)
        {
            /* A project with no console yet: nowhere to persist, but the
               runtime change above is real. Say so instead of failing. */
            errorMessage.clear();
        }
        else
        {
            m_doc->setModified();
            emit consoleChanged();
        }
    }

    emit grandMasterChanged();
    return true;
}

QList<EngineHost::DumpValue> EngineHost::dumpableValues() const
{
    QList<DumpValue> out;
    /* Deduplicated by (fixture, channel): where the Simple Desk and the plan's
       live desk both hold the same channel, the Simple Desk wins -- it is the
       higher-priority fader on the wire, so it is also the truth here. */
    QSet<quint64> seen;

    const QHash<quint32, uchar> deskHeld = m_desk->heldEverywhere();
    for (auto it = deskHeld.constBegin(); it != deskHeld.constEnd(); ++it)
    {
        const quint32 address = it.key();
        const quint32 fixtureId = m_doc->fixtureForAddress(address);
        if (fixtureId == Fixture::invalidId())
            continue;
        Fixture *fixture = m_doc->fixture(fixtureId);
        if (fixture == nullptr)
            continue;

        const quint32 channel = (address & 0x01FF) - fixture->address();
        const QLCChannel *qlcChannel = fixture->channel(channel);

        DumpValue value;
        value.fixture = fixtureId;
        value.channel = channel;
        value.value = it.value();
        value.group = qlcChannel != nullptr ? int(qlcChannel->group()) : int(QLCChannel::NoGroup);
        out.append(value);
        seen.insert((quint64(fixtureId) << 32) | channel);
    }

    for (const auto &pair : m_levels->liveValues())
    {
        // LevelSource::Channel is (fixture id, channel index).
        const quint32 fixtureId = pair.first.first;
        const quint32 channelIndex = pair.first.second;
        const quint64 key = (quint64(fixtureId) << 32) | channelIndex;
        if (seen.contains(key))
            continue;
        Fixture *fixture = m_doc->fixture(fixtureId);
        if (fixture == nullptr)
            continue;
        const QLCChannel *qlcChannel = fixture->channel(channelIndex);

        DumpValue value;
        value.fixture = fixtureId;
        value.channel = channelIndex;
        value.value = pair.second;
        value.group = qlcChannel != nullptr ? int(qlcChannel->group()) : int(QLCChannel::NoGroup);
        out.append(value);
    }

    return out;
}

int EngineHost::bareHeldCount() const
{
    int bare = 0;
    const QHash<quint32, uchar> deskHeld = m_desk->heldEverywhere();
    for (auto it = deskHeld.constBegin(); it != deskHeld.constEnd(); ++it)
    {
        if (m_doc->fixtureForAddress(it.key()) == Fixture::invalidId())
            bare++;
    }
    return bare;
}

bool EngineHost::dumpToScene(const QString &name, quint32 sceneId, bool nonZeroOnly,
                             const QList<int> &groups, quint32 &outSceneId, int &written,
                             QString &errorMessage)
{
    QList<DumpValue> values = dumpableValues();

    if (nonZeroOnly)
    {
        values.erase(std::remove_if(values.begin(), values.end(),
                                    [](const DumpValue &v) { return v.value == 0; }),
                     values.end());
    }
    if (groups.isEmpty() == false)
    {
        values.erase(std::remove_if(values.begin(), values.end(),
                                    [&groups](const DumpValue &v) {
                                        return groups.contains(v.group) == false;
                                    }),
                     values.end());
    }

    if (values.isEmpty())
    {
        errorMessage = QStringLiteral(
            "Nothing to dump: the desk holds no values a scene can carry "
            "(after the filters, at least)");
        return false;
    }

    if (sceneId == Function::invalidId())
    {
        const DocWriter::Result made =
            DocWriter::createFunction(m_doc, QStringLiteral("Scene"),
                                      name.isEmpty() ? QStringLiteral("Volcado") : name,
                                      outSceneId);
        if (made.ok == false)
        {
            errorMessage = made.error;
            return false;
        }
    }
    else
    {
        Function *function = m_doc->function(sceneId);
        if (function == nullptr || function->type() != Function::SceneType)
        {
            errorMessage = QStringLiteral("No scene with id %1").arg(sceneId);
            return false;
        }
        outSceneId = sceneId;
    }

    written = 0;
    for (const DumpValue &value : values)
    {
        const DocWriter::Result set = DocWriter::setSceneValue(
            m_doc, outSceneId, value.fixture, value.channel, int(value.value));
        if (set.ok)
            written++;
    }

    if (written == 0)
    {
        errorMessage = QStringLiteral("No value could be written into the scene");
        return false;
    }

    m_doc->setModified();
    return true;
}

void EngineHost::stopEverything(int fadeMs)
{
    if (fadeMs > 0)
        m_doc->masterTimer()->fadeAndStopAll(fadeMs);
    else
        m_doc->masterTimer()->stopAllFunctions();
}

void EngineHost::armAutosave()
{
    if (m_autosave != nullptr)
        m_autosave->start();
}

void EngineHost::newProject()
{
    Q_ASSERT(m_doc != nullptr);

    m_doc->masterTimer()->stop();
    m_doc->clearContents();
    m_doc->clearErrorLog();
    m_doc->inputOutputMap()->startUniverses();
    m_doc->masterTimer()->start();

    /* No path on purpose: the next save must say where. Keeping the old one
       is how a blank workspace gets written over last night's show. */
    m_projectPath.clear();
    m_preserved = WorkspaceLoader::Preserved();

    /* A fresh show gets QLC+'s defaults, not the last project's habits. */
    m_doc->inputOutputMap()->setGrandMasterChannelMode(GrandMaster::Intensity);
    m_doc->inputOutputMap()->setGrandMasterValueMode(GrandMaster::Reduce);
    m_doc->inputOutputMap()->setGrandMasterValue(255);

    if (m_levels != nullptr)
        m_levels->forgetEverything();
    if (m_desk != nullptr)
        m_desk->forgetEverything();
    teachSliders();

    m_undo.clear();
    m_redo.clear();
    m_doc->resetModified();

    emit projectReplaced();
}

QString EngineHost::autosavePath() const
{
    if (m_projectPath.isEmpty() == false)
        return m_projectPath + QStringLiteral(".autosave.qxw");

    /* A brand-new show has no home yet; the autosave lives in the projects
       directory so a crash before the first save still leaves something. */
    if (m_projectsDirectory.isEmpty() == false)
        return QDir(m_projectsDirectory).absoluteFilePath(QStringLiteral("NewProject.autosave.qxw"));

    return QString();
}

bool EngineHost::recoverAutosave(QString &errorMessage)
{
    const QString shadow = pendingAutosave();
    if (shadow.isEmpty())
    {
        errorMessage = QStringLiteral("There is no recovery copy to load");
        return false;
    }

    const QString keep = m_projectPath;
    if (loadProject(shadow, errorMessage) == false)
        return false;

    /* The content is the autosave's; the identity stays the project's. And it
       IS modified relative to the file on disk -- that is the whole point. */
    m_projectPath = keep;
    m_doc->setModified();
    return true;
}

QString EngineHost::pendingAutosave() const
{
    const QString candidate = autosavePath();
    if (candidate.isEmpty() || QFileInfo::exists(candidate) == false)
        return QString();

    /* Only newer than the project it shadows: an autosave older than the real
       file is a leftover from an edit somebody went on to save properly. */
    if (m_projectPath.isEmpty() == false)
    {
        const QDateTime saved = QFileInfo(m_projectPath).lastModified();
        const QDateTime shadow = QFileInfo(candidate).lastModified();
        if (shadow <= saved)
            return QString();
    }

    return candidate;
}

QStringList EngineHost::audioOutputs() const
{
    QStringList names;

    if (m_doc == nullptr)
        return names;

    for (const AudioDeviceInfo &info : m_doc->audioPluginCache()->audioDevicesList())
    {
        if (info.capabilities & AUDIO_CAP_OUTPUT)
            names << info.deviceName;
    }

    return names;
}

void EngineHost::teachSliders()
{
    if (m_levels == nullptr)
        return;

    m_levels->forgetSliders();

    /* Channels groups first, and outside the console walk on purpose: they
       belong to the document, not to the Virtual Console, so they must survive
       a project whose console cannot be parsed at all. */
    for (const ChannelsGroup *group : m_doc->channelsGroups())
    {
        if (group == nullptr)
            continue;

        QList<LevelSource::Channel> channels;
        for (const SceneValue &value : group->getChannels())
            channels.append(qMakePair(value.fxi, value.channel));

        if (channels.isEmpty() == false)
            m_levels->defineChannelGroup(group->id(), channels);
    }

    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root) == false)
    {
        if (m_triggers != nullptr)
            m_triggers->learn(VcWidget());
        return;
    }

    /* Before the walk below, because a bar that holds DMX channels registers
       itself as a slider and the walk must not clear it again. */
    if (m_triggers != nullptr)
        m_triggers->learn(root);

    /* The walk carries the submasters enclosing each widget.
     *
     * A submaster scales the frame that holds it and everything below, so what
     * a widget ends up at is the product of the whole chain above it. The tree
     * has no parent pointers, so the chain is threaded down instead -- which is
     * also why this is resolved here, where the tree lives, rather than in
     * LevelSource, which never has to learn what a frame is. */
    struct Pending
    {
        const VcWidget *widget;
        LevelSource::Scope scope;
    };

    QVector<Pending> pending;
    pending.append({&root, LevelSource::Scope()});

    while (pending.isEmpty() == false)
    {
        const Pending item = pending.takeLast();
        const VcWidget *widget = item.widget;

        if (widget->sliderMode == QStringLiteral("submaster"))
        {
            m_levels->defineSubmaster(widget->id, widget->low, widget->high,
                                      uchar(qBound(0, widget->value, 255)));
        }
        else if (widget->sliderMode == QStringLiteral("level")
                 && widget->levelChannels.isEmpty() == false)
        {
            QList<LevelSource::Channel> channels;
            for (const auto &channel : widget->levelChannels)
                channels.append(channel);

            m_levels->defineSlider(widget->id, channels, item.scope);
        }
        else if (widget->sliderMode == QStringLiteral("playback") && widget->hasFunction
                 && widget->functionId != UINT_MAX)
        {
            /* A playback slider rides a function instead of writing channels,
               and names it as element text inside <Playback> rather than as an
               attribute -- which is why it reported none for so long. */
            m_levels->definePlayback(widget->id, widget->functionId, item.scope);
        }
        else if (widget->type == QStringLiteral("button") && widget->hasFunction
                 && widget->functionId != UINT_MAX)
        {
            /* Not started from here -- that is the operator's business. Only
               scaled, while it runs. */
            m_levels->defineButton(widget->id, widget->functionId, item.scope);
        }
        else if (widget->type == QStringLiteral("cuelist") && widget->hasChaser)
        {
            m_levels->defineCueList(widget->id, widget->chaserId, item.scope);
        }
        else if (widget->type == QStringLiteral("matrix") && widget->hasFunction
                 && widget->functionId != UINT_MAX)
        {
            /* A matrix widget is a fader over its matrix: at zero it stops it,
               above zero it rides its intensity. Exactly a playback slider, so
               it is registered as one rather than growing a second path. */
            m_levels->definePlayback(widget->id, widget->functionId, item.scope);
        }

        if (widget->padHeads.isEmpty() == false)
        {
            QList<LevelSource::PadHead> heads;
            for (const VcWidget::PadHead &head : widget->padHeads)
            {
                LevelSource::PadHead entry;
                entry.fixtureId = head.fixtureId;
                entry.head = head.head;
                entry.xMin = head.xMin;
                entry.xMax = head.xMax;
                entry.yMin = head.yMin;
                entry.yMax = head.yMax;
                entry.xReverse = head.xReverse;
                entry.yReverse = head.yReverse;
                heads.append(entry);
            }

            m_levels->definePad(widget->id, heads);
        }

        /* A frame's own submaster sliders extend the chain for everything below
           it -- but never for those submasters themselves.
         *
         * QLC+ excludes the sender when a submaster propagates, and with two in
         * one frame it is order-dependent and ratchets darker on every repeat.
         * Taking the product and leaving every submaster out of its own frame's
         * chain gives the same answer for every sane console and a defined,
         * idempotent one for the pathological case. It is a knowing difference,
         * and this is where it lives. */
        LevelSource::Scope below = item.scope;
        for (const VcWidget &child : widget->children)
        {
            if (child.sliderMode == QStringLiteral("submaster") && child.hasId)
                below.append(child.id);
        }

        for (const VcWidget &child : widget->children)
        {
            const bool isSubmaster = (child.sliderMode == QStringLiteral("submaster"));
            pending.append({&child, isSubmaster ? item.scope : below});
        }
    }
}

bool EngineHost::loadProject(const QString &fileName, QString &errorMessage)
{
    Q_ASSERT(m_doc != nullptr);

    /* Stop the clock across the swap. Loading rebuilds fixtures and functions
       underneath a timer that is writing DMX from another thread. */
    m_doc->masterTimer()->stop();
    m_doc->clearContents();
    m_doc->clearErrorLog();

    const bool ok = WorkspaceLoader::load(m_doc, fileName, m_preserved, errorMessage);

    m_doc->inputOutputMap()->startUniverses();
    m_doc->masterTimer()->start();

    if (ok == false)
    {
        /* The old show is already gone from memory -- clearContents() ran
           before the parse. Keeping the old path would leave a daemon holding
           an empty document that still believes it is that project, and the
           next save would write the emptiness over the real file. Forgetting
           the path makes the next save refuse instead. */
        m_projectPath.clear();
        m_preserved = WorkspaceLoader::Preserved();

        /* A different project entirely, so the values go too: an id that means
           one fader here meant another one there. */
        if (m_levels != nullptr)
            m_levels->forgetEverything();
        if (m_desk != nullptr)
            m_desk->forgetEverything();
        teachSliders();
    }

    if (ok)
    {
        m_projectPath = QFileInfo(fileName).absoluteFilePath();

        /* The console's Grand Master settings, applied to the engine that
           enforces them. Preserved-but-unread was the worst of both: the file
           kept saying Limit/All and the desk quietly ran Reduce/Intensity. */
        const VcPatch::GrandMasterSettings gm =
            VcPatch::readGrandMaster(m_preserved.sections);
        m_doc->inputOutputMap()->setGrandMasterChannelMode(
            GrandMaster::stringToChannelMode(gm.channelMode));
        m_doc->inputOutputMap()->setGrandMasterValueMode(
            GrandMaster::stringToValueMode(gm.valueMode));
        m_doc->inputOutputMap()->setGrandMasterValue(255);

        /* Default the writable directory to wherever the show already lives,
           which is where an operator expects "save" to put it. */
        if (m_projectsDirectory.isEmpty())
            m_projectsDirectory = QFileInfo(m_projectPath).absolutePath();

        if (m_levels != nullptr)
            m_levels->forgetEverything();
        if (m_desk != nullptr)
            m_desk->forgetEverything();
        teachSliders();
    }

    /* A different console entirely, so its history means nothing: undoing into
       another show's widgets would be worse than not undoing at all. */
    m_undo.clear();
    m_redo.clear();

    /* Announced either way: a load that failed cleared the document, and a
       client still showing the old show is showing something that is gone. */
    emit projectReplaced();

    return ok;
}

bool EngineHost::saveProject(const QString &fileName, QString &errorMessage)
{
    Q_ASSERT(m_doc != nullptr);

    const QString target = fileName.isEmpty() ? m_projectPath : fileName;
    if (target.isEmpty())
    {
        errorMessage = QStringLiteral("No project is loaded, so there is nothing to save over");
        return false;
    }

    if (WorkspaceLoader::save(m_doc, target, m_preserved, errorMessage) == false)
        return false;

    m_projectPath = QFileInfo(target).absoluteFilePath();
    m_doc->resetModified();

    /* Saved for real, so the recovery copy has nothing to recover. */
    if (m_autosave != nullptr)
        m_autosave->stop();
    const QString shadow = autosavePath();
    if (shadow.isEmpty() == false)
        QFile::remove(shadow);

    return true;
}

QStringList EngineHost::availableProjects() const
{
    if (m_projectsDirectory.isEmpty())
        return QStringList();

    QDir dir(m_projectsDirectory);
    dir.setFilter(QDir::Files);
    dir.setNameFilters(QStringList() << QString("*%1").arg(KExtWorkspace));
    dir.setSorting(QDir::Name);

    return dir.entryList();
}

QString EngineHost::resolveProjectName(const QString &name) const
{
    if (name.isEmpty() || m_projectsDirectory.isEmpty())
        return QString();

    /* A name, not a path. Anything with a separator in it, or the usual
       traversal tricks, is refused outright rather than normalised: normalising
       is where these bugs hide. */
    if (name.contains(QChar('/')) || name.contains(QChar('\\')) || name.contains(QStringLiteral("..")))
        return QString();

    if (name.endsWith(KExtWorkspace, Qt::CaseInsensitive) == false)
        return QString();

    return QDir(m_projectsDirectory).absoluteFilePath(name);
}

bool EngineHost::setSpeedDial(quint32 widgetId, int milliseconds)
{
    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root) == false)
        return false;

    /* QLC+'s multiplier table, times 1000. Index 0 is None: a speed the dial
       leaves alone, which is why most dials touch only one of the three. */
    static const int multipliers[] = {0, 0, 1000 / 16, 1000 / 8, 1000 / 4, 1000 / 2,
                                      1000, 1000 * 2, 1000 * 4, 1000 * 8, 1000 * 16};
    static const int multiplierCount = int(sizeof(multipliers) / sizeof(multipliers[0]));

    QVector<const VcWidget *> pending;
    pending.append(&root);

    while (pending.isEmpty() == false)
    {
        const VcWidget *widget = pending.takeLast();

        if (widget->id == widgetId && widget->speedTargets.isEmpty() == false)
        {
            for (const VcWidget::SpeedTarget &target : widget->speedTargets)
            {
                Function *function = m_doc->function(target.functionId);
                if (function == nullptr)
                    continue;

                const auto scaled = [&](int multiplier) {
                    return uint(qint64(milliseconds) * multipliers[multiplier] / 1000);
                };

                if (target.fadeIn > 0 && target.fadeIn < multiplierCount)
                    function->setFadeInSpeed(scaled(target.fadeIn));
                if (target.fadeOut > 0 && target.fadeOut < multiplierCount)
                    function->setFadeOutSpeed(scaled(target.fadeOut));
                if (target.duration > 0 && target.duration < multiplierCount)
                    function->setDuration(scaled(target.duration));
            }

            return true;
        }

        for (const VcWidget &child : widget->children)
            pending.append(&child);
    }

    return false;
}

QList<quint32> EngineHost::soloSiblings(quint32 functionId) const
{
    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root) == false)
        return QList<quint32>();

    /* Every function reachable from a widget in this subtree. Nested frames
       count: a solo frame's contents are everything inside it, however deep,
       which is how a bank built out of sub-frames still behaves as one. */
    const std::function<void(const VcWidget &, QList<quint32> &)> collect =
        [&collect](const VcWidget &widget, QList<quint32> &into) {
            if (widget.hasFunction && widget.functionId != UINT_MAX
                && into.contains(widget.functionId) == false)
            {
                into.append(widget.functionId);
            }

            for (const VcWidget &child : widget.children)
                collect(child, into);
        };

    QVector<const VcWidget *> pending;
    pending.append(&root);

    while (pending.isEmpty() == false)
    {
        const VcWidget *widget = pending.takeLast();

        if (widget->type == QStringLiteral("soloframe"))
        {
            QList<quint32> inside;
            collect(*widget, inside);

            if (inside.contains(functionId))
            {
                inside.removeAll(functionId);
                return inside;
            }
        }

        for (const VcWidget &child : widget->children)
            pending.append(&child);
    }

    return QList<quint32>();
}

QVector<ConsoleLayout::Page> EngineHost::layout() const
{
    QVector<ConsoleLayout::Page> pages;
    ConsoleLayout::parse(m_preserved.sections, pages);
    return pages;
}

void EngineHost::setLayout(const QVector<ConsoleLayout::Page> &pages)
{
    rememberConsole();

    /* Merge by page, do not replace wholesale. The interface only ever sends
       the page being edited, so replacing everything silently dropped the
       arrangement of every other page in the console. */
    QVector<ConsoleLayout::Page> merged;
    ConsoleLayout::parse(m_preserved.sections, merged);

    for (const ConsoleLayout::Page &page : pages)
    {
        bool replaced = false;
        for (ConsoleLayout::Page &existing : merged)
        {
            if (existing.id == page.id)
            {
                existing = page;
                replaced = true;
                break;
            }
        }
        if (replaced == false)
            merged.append(page);
    }

    /* The layout lives among the preserved sections, which is what carries it
       through a save. Replacing means dropping the copy that was read in --
       otherwise the file would grow a second, stale arrangement every time. */
    for (int i = m_preserved.sections.count() - 1; i >= 0; i--)
    {
        if (ConsoleLayout::isLayoutSection(m_preserved.sections.at(i)))
            m_preserved.sections.removeAt(i);
    }

    if (merged.isEmpty() == false)
        m_preserved.sections.append(ConsoleLayout::toXml(merged));

    m_doc->setModified();
    emit consoleChanged();
}

void EngineHost::releaseLevels(const QList<LevelSource::Channel> &channels)
{
    if (channels.isEmpty())
        return;

    /* Same reasoning as deleting a fixture: whatever the slider was holding
       stays latched in the universe buffer once the slider is gone, and with
       nothing left to move it the lamp simply stays where it was. The one
       control that could have turned it off is the thing being deleted. */
    QList<Universe *> universes = m_doc->inputOutputMap()->claimUniverses();

    for (const LevelSource::Channel &channel : channels)
    {
        const Fixture *fixture = m_doc->fixture(channel.first);
        if (fixture == nullptr)
            continue;

        const quint32 universeId = fixture->universe();
        if (int(universeId) >= universes.count())
            continue;

        universes.at(int(universeId))->write(int(fixture->address() + channel.second), 0, true);
    }

    m_doc->inputOutputMap()->releaseUniverses(true);
}

void EngineHost::forgetLayoutIds(const QStringList &widgetIds)
{
    if (widgetIds.isEmpty())
        return;

    QSet<quint32> gone;
    for (const QString &id : widgetIds)
    {
        bool ok = false;
        const quint32 value = id.toUInt(&ok);
        if (ok)
            gone.insert(value);
    }

    QVector<ConsoleLayout::Page> pages;
    if (ConsoleLayout::parse(m_preserved.sections, pages) == false)
        return;

    bool changed = false;

    for (ConsoleLayout::Page &page : pages)
    {
        for (int row = page.rows.count() - 1; row >= 0; row--)
        {
            QVector<quint32> &widgets = page.rows[row];

            for (int i = widgets.count() - 1; i >= 0; i--)
            {
                if (gone.contains(widgets.at(i)))
                {
                    widgets.remove(i);
                    changed = true;
                }
            }

            if (widgets.isEmpty())
                page.rows.remove(row);
        }
    }

    if (changed)
        setLayout(pages);
}

VcPatch::Result EngineHost::checkReferences(const QString &widgetId, const QJsonObject &patch) const
{
    /* The console is a text file: it will happily hold a function id that was
       deleted last month, and QLC+ loads it without a word, leaving a button
       that does nothing at all. Checking here is the difference between an
       error at the moment of the edit and a control that fails during a show. */
    QJsonValue function = patch.value(QStringLiteral("functionId"));
    if (function.isUndefined())
        function = patch.value(QStringLiteral("chaserId"));

    if (function.isUndefined() == false && function.isNull() == false)
    {
        if (function.isDouble() == false)
            return VcPatch::Result::failure(QStringLiteral("\"functionId\" must be an id or null"));

        const quint32 id = quint32(function.toDouble());
        const Function *target = m_doc->function(id);
        if (target == nullptr)
            return VcPatch::Result::failure(QStringLiteral("No function with id %1").arg(id));

        /* A cue list steps through a chaser. Anything else loads, shows the
           function's name, and then does nothing when the operator hits Next. */
        VcWidget root;
        if (VirtualConsole::parse(m_preserved.sections, root))
        {
            bool ok = false;
            const quint32 numeric = widgetId.toUInt(&ok);
            const VcWidget *widget = ok ? VirtualConsole::find(root, numeric) : nullptr;

            if (widget != nullptr && widget->type == QStringLiteral("cuelist")
                && target->type() != Function::ChaserType)
            {
                return VcPatch::Result::failure(
                    QStringLiteral("A cue list needs a chaser, and \"%1\" is a %2")
                        .arg(target->name(), target->typeToString(target->type()).toLower()));
            }
        }
    }

    const QJsonValue channels = patch.value(QStringLiteral("levelChannels"));
    if (channels.isUndefined() == false)
    {
        if (channels.isArray() == false)
            return VcPatch::Result::failure(QStringLiteral("\"levelChannels\" must be an array"));

        for (const QJsonValue &entry : channels.toArray())
        {
            const QJsonObject channel = entry.toObject();
            const quint32 fixtureId =
                quint32(channel.value(QStringLiteral("fixture")).toDouble(-1));
            const int index = channel.value(QStringLiteral("channel")).toInt(-1);

            const Fixture *fixture = m_doc->fixture(fixtureId);
            if (fixture == nullptr)
            {
                return VcPatch::Result::failure(
                    QStringLiteral("No fixture with id %1")
                        .arg(channel.value(QStringLiteral("fixture")).toInt(-1)));
            }

            if (index < 0 || quint32(index) >= fixture->channels())
            {
                return VcPatch::Result::failure(
                    QStringLiteral("\"%1\" has %2 channels, so %3 is not one of them")
                        .arg(fixture->name()).arg(fixture->channels()).arg(index));
            }
        }
    }

    return VcPatch::Result::success();
}

VcPatch::Result EngineHost::editWidget(const QString &widgetId, const QJsonObject &patch)
{
    const VcPatch::Result checked = checkReferences(widgetId, patch);
    if (checked.ok == false)
        return checked;

    /* Remembered before the change, and only once it is going to happen: a
       refused edit that still filled the undo stack would make the button undo
       nothing at all. */
    rememberConsole();

    const VcPatch::Result result = VcPatch::editWidget(m_preserved.sections, widgetId, patch);
    if (result.ok == false)
        return result;

    /* Re-read rather than reason about what the patch touched: a caption is
       harmless, but the same call is the one that will carry level channels
       later, and a stale LevelSource writes DMX nobody asked for. */
    teachSliders();
    m_doc->setModified();
    emit consoleChanged();

    return result;
}

VcPatch::Result EngineHost::addWidget(const QString &type, const QString &parentId,
                                      const QJsonObject &properties, QString &newId)
{
    const VcPatch::Result checked = checkReferences(QString(), properties);
    if (checked.ok == false)
        return checked;

    rememberConsole();

    /* A project born in this daemon has no <VirtualConsole> section until
       someone gives it a widget -- QLC+ always writes one, so a console is
       scaffolded here rather than telling the operator their brand-new
       project cannot hold a button. Same undo step as the widget itself. */
    if (VcPatch::sectionIndex(m_preserved.sections) < 0)
    {
        m_preserved.sections.append(QStringLiteral(
            "<VirtualConsole>\n <Frame Caption=\"\">\n"
            "  <Appearance>\n   <FrameStyle>None</FrameStyle>\n"
            "   <ForegroundColor>Default</ForegroundColor>\n"
            "   <BackgroundColor>Default</BackgroundColor>\n"
            "   <BackgroundImage>None</BackgroundImage>\n"
            "   <Font>Default</Font>\n  </Appearance>\n"
            " </Frame>\n <Properties>\n"
            "  <Size Width=\"1920\" Height=\"1080\"/>\n"
            " </Properties>\n</VirtualConsole>"));
    }

    const VcPatch::Result result =
        VcPatch::addWidget(m_preserved.sections, type, parentId, properties, newId);
    if (result.ok == false)
        return result;

    teachSliders();
    m_doc->setModified();
    emit consoleChanged();

    return result;
}

VcPatch::Result EngineHost::removeWidget(const QString &widgetId)
{
    /* Read the level channels out before the widget goes, while there is still
       something to read them from. A frame takes its sliders with it, so this
       walks the subtree, not just the widget named. */
    QList<LevelSource::Channel> held;

    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root))
    {
        bool ok = false;
        const quint32 target = widgetId.toUInt(&ok);

        QVector<const VcWidget *> pending;
        pending.append(&root);

        while (ok && pending.isEmpty() == false)
        {
            const VcWidget *widget = pending.takeLast();

            if (widget->hasId && widget->id == target)
            {
                QVector<const VcWidget *> subtree;
                subtree.append(widget);

                while (subtree.isEmpty() == false)
                {
                    const VcWidget *node = subtree.takeLast();
                    held.append(node->levelChannels);

                    for (const VcWidget &child : node->children)
                        subtree.append(&child);
                }

                break;
            }

            for (const VcWidget &child : widget->children)
                pending.append(&child);
        }
    }

    rememberConsole();

    QStringList removedIds;
    const VcPatch::Result result =
        VcPatch::removeWidget(m_preserved.sections, widgetId, removedIds);
    if (result.ok == false)
        return result;

    /* Order matters: stop the sliders driving those channels before zeroing
       them, or the next tick writes the old level straight back. */
    teachSliders();
    releaseLevels(held);
    forgetLayoutIds(removedIds);

    m_doc->setModified();
    emit consoleChanged();

    return result;
}

VcPatch::Result EngineHost::assignWidgetIds(int &assigned)
{
    rememberConsole();

    const VcPatch::Result result = VcPatch::assignIds(m_preserved.sections, assigned);

    if (result.ok && assigned > 0)
    {
        /* Level sliders are keyed by widget id, so the ones that just got one
           become drivable at this point and not before. */
        teachSliders();
        m_doc->setModified();
        emit consoleChanged();
    }

    return result;
}

bool EngineHost::applyMatrixPreset(quint32 widgetId, int presetId, QString &errorMessage)
{
    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root) == false)
    {
        errorMessage = QStringLiteral("This project has no Virtual Console");
        return false;
    }

    const VcWidget *widget = VirtualConsole::find(root, widgetId);
    if (widget == nullptr || widget->type != QStringLiteral("matrix"))
    {
        errorMessage = QStringLiteral("No matrix widget with id %1").arg(widgetId);
        return false;
    }

    if (widget->hasFunction == false || widget->functionId == UINT_MAX)
    {
        errorMessage = QStringLiteral("\"%1\" does not drive a matrix").arg(widget->caption);
        return false;
    }

    for (const VcWidget::MatrixPreset &preset : widget->matrixPresets)
    {
        if (preset.id != presetId)
            continue;

        QList<QPair<QString, QString>> properties;
        for (const auto &property : preset.properties)
            properties.append(property);

        const DocWriter::Result result =
            DocWriter::applyMatrixPreset(m_doc, widget->functionId, preset.type, preset.color,
                                         preset.resource, properties, widget->instantApply);

        errorMessage = result.error;
        return result.ok;
    }

    errorMessage = QStringLiteral("Widget %1 has no preset %2").arg(widgetId).arg(presetId);
    return false;
}

int EngineHost::forgetFixture(quint32 fixtureId)
{
    const int removed = VcPatch::forgetFixture(m_preserved.sections, fixtureId);

    if (removed > 0)
    {
        teachSliders();
        m_doc->setModified();
        emit consoleChanged();
    }

    return removed;
}

/*****************************************************************************
 * The live desk
 *****************************************************************************/

bool EngineHost::setLiveValues(const QList<QPair<LevelSource::Channel, uchar>> &values,
                               QString &errorMessage)
{
    if (m_levels == nullptr)
    {
        errorMessage = QStringLiteral("The engine is not running");
        return false;
    }

    /* Everything checked before anything is written: half a colour applied is
       a lamp nobody asked for, and it is worse than a refusal because it looks
       like a choice. */
    for (const auto &entry : values)
    {
        const Fixture *fixture = m_doc->fixture(entry.first.first);
        if (fixture == nullptr)
        {
            errorMessage = QStringLiteral("No fixture with id %1").arg(entry.first.first);
            return false;
        }

        if (entry.first.second >= fixture->channels())
        {
            errorMessage = QStringLiteral("\"%1\" has %2 channels, so it has no channel %3")
                               .arg(fixture->name())
                               .arg(fixture->channels())
                               .arg(entry.first.second);
            return false;
        }
    }

    for (const auto &entry : values)
        m_levels->setLiveValue(entry.first.first, entry.first.second, entry.second);

    emit liveChanged();
    return true;
}

void EngineHost::releaseLive()
{
    if (m_levels == nullptr)
        return;

    const QList<QPair<LevelSource::Channel, uchar>> held = m_levels->liveValues();

    m_levels->clearLive();

    QList<LevelSource::Channel> channels;
    for (const auto &entry : held)
        channels.append(entry.first);

    /* Zeroed, not merely dropped. The engine puts intensity channels back to
       zero on its own every tick, but a gobo wheel or a colour wheel stays
       exactly where it was left -- and the desk that could move it is the one
       just let go of. */
    releaseLevels(channels);

    emit liveChanged();
}

/*****************************************************************************
 * Channels groups
 *****************************************************************************/

namespace
{
    /** What a group is holding right now, as level-source channels. */
    QList<LevelSource::Channel> channelsOf(const ChannelsGroup *group)
    {
        QList<LevelSource::Channel> channels;
        if (group == nullptr)
            return channels;

        for (const SceneValue &value : group->getChannels())
            channels.append(qMakePair(value.fxi, value.channel));

        return channels;
    }
}

bool EngineHost::addChannelGroup(const QString &name, const QList<LevelSource::Channel> &channels,
                                 quint32 &groupId, QString &errorMessage)
{
    DocWriter::Result result = DocWriter::Result::success();

    /* Through the lock because teachSliders() afterwards is what puts the new
       group on the wire; without it the group is in the file and does nothing
       until the project is reloaded. */
    withFixturesLocked([&]() {
        result = DocWriter::addChannelsGroup(m_doc, name, channels, groupId);
        return true;
    });

    errorMessage = result.error;
    return result.ok;
}

bool EngineHost::updateChannelGroup(quint32 groupId, const QString *name,
                                    const QList<LevelSource::Channel> *channels,
                                    QString &errorMessage)
{
    const QList<LevelSource::Channel> before = channelsOf(m_doc->channelsGroup(groupId));

    DocWriter::Result result = DocWriter::Result::success();

    withFixturesLocked([&]() {
        result = DocWriter::setChannelsGroup(m_doc, groupId, name, channels);
        return true;
    });

    errorMessage = result.error;
    if (result.ok == false)
        return false;

    /* Channels the group no longer has are channels nothing moves any more.
       They stay latched at whatever the fader was holding, and the control that
       could have lowered them is precisely the one just edited away. */
    const QList<LevelSource::Channel> after = channelsOf(m_doc->channelsGroup(groupId));
    QList<LevelSource::Channel> dropped;
    for (const LevelSource::Channel &channel : before)
    {
        if (after.contains(channel) == false)
            dropped.append(channel);
    }

    releaseLevels(dropped);
    return true;
}

bool EngineHost::removeChannelGroup(quint32 groupId, QString &errorMessage)
{
    const QList<LevelSource::Channel> held = channelsOf(m_doc->channelsGroup(groupId));

    DocWriter::Result result = DocWriter::Result::success();

    withFixturesLocked([&]() {
        result = DocWriter::removeChannelsGroup(m_doc, groupId);
        return true;
    });

    errorMessage = result.error;
    if (result.ok == false)
        return false;

    releaseLevels(held);
    return true;
}

void EngineHost::rememberConsole()
{
    m_undo.append(m_preserved);

    /* Bounded, because a long editing session should not grow without limit.
       Fifty is far past what anyone reaches for, and the sections are a few
       kilobytes each. */
    while (m_undo.count() > 50)
        m_undo.removeFirst();

    /* A new edit is a new branch: whatever was undone is no longer ahead. */
    m_redo.clear();
}

bool EngineHost::undoConsole()
{
    if (m_undo.isEmpty())
        return false;

    m_redo.append(m_preserved);
    m_preserved = m_undo.takeLast();

    teachSliders();
    m_doc->setModified();
    emit consoleChanged();

    return true;
}

bool EngineHost::redoConsole()
{
    if (m_redo.isEmpty())
        return false;

    m_undo.append(m_preserved);
    m_preserved = m_redo.takeLast();

    teachSliders();
    m_doc->setModified();
    emit consoleChanged();

    return true;
}

QString EngineHost::projectErrors() const
{
    return m_doc == nullptr ? QString() : m_doc->errorLog();
}
