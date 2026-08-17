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

#include <QJsonObject>
#include <QJsonArray>
#include <QFileInfo>
#include <QDir>
#include <QSet>

#include "enginehost.h"
#include "installpaths.h"
#include "fixturelibrary.h"
#include "workspaceloader.h"
#include "virtualconsole.h"
#include "docwriter.h"
#include "levelsource.h"

#include "qlcfile.h"
#include "qlcmodifierscache.h"
#include "rgbscriptscache.h"
#include "ioplugincache.h"
#include "qlcioplugin.h"
#include "audioplugincache.h"
#include "inputoutputmap.h"
#include "mastertimer.h"
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

    delete m_levels;
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

    /* Output plugins. Skipping them keeps the engine fully functional but
       silent on the wire. */
    if (options.noOutput == false)
    {
        m_pluginPath = InstallPaths::ioPlugins(options.pluginDirectory);
        if (m_pluginPath.isEmpty() == false)
        {
            m_doc->ioPluginCache()->load(QDir(m_pluginPath));

            const QList<QLCIOPlugin *> plugins = m_doc->ioPluginCache()->plugins();
            for (QLCIOPlugin *plugin : plugins)
                m_loadedPlugins << plugin->name();
        }
    }

    /* Audio decoders. They install alongside the output plugins, so the same
       resolution finds them.
     *
     * These decode files; playing the result still needs a Qt multimedia
       backend, which the AppImage does not bundle yet. An Audio function in a
       project therefore loads and reports its formats but stays silent there. */
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

    /* Registered before the timer starts, so the first tick already has it. */
    m_levels = new LevelSource(m_doc);
    m_doc->masterTimer()->registerDMXSource(m_levels);

    m_doc->masterTimer()->start();
    m_running = true;

    return true;
}

void EngineHost::teachSliders()
{
    if (m_levels == nullptr)
        return;

    m_levels->forgetSliders();

    VcWidget root;
    if (VirtualConsole::parse(m_preserved.sections, root) == false)
        return;

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
        teachSliders();
    }

    if (ok)
    {
        m_projectPath = QFileInfo(fileName).absoluteFilePath();

        /* Default the writable directory to wherever the show already lives,
           which is where an operator expects "save" to put it. */
        if (m_projectsDirectory.isEmpty())
            m_projectsDirectory = QFileInfo(m_projectPath).absolutePath();

        if (m_levels != nullptr)
            m_levels->forgetEverything();
        teachSliders();
    }

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

QString EngineHost::projectErrors() const
{
    return m_doc == nullptr ? QString() : m_doc->errorLog();
}
