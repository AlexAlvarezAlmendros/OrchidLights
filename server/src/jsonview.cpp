/*
  OrchidLights
  jsonview.cpp

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

#include <QTime>

#include "jsonview.h"
#include "virtualconsole.h"
#include "levelsource.h"

#include "qlcfixturemode.h"
#include "qlcphysical.h"
#include "qlcfixturedef.h"
#include "inputoutputmap.h"
#include "outputpatch.h"
#include "inputpatch.h"
#include "universe.h"
#include "fixture.h"
#include "qlcchannel.h"
#include "qlcpalette.h"
#include "rgbalgorithm.h"
#include "rgbtext.h"
#include "rgbimage.h"
#if QT_VERSION >= QT_VERSION_CHECK(5, 0, 0)
  #include "rgbscriptv4.h"
#else
  #include "rgbscript.h"
#endif
#include "rgbscriptproperty.h"
#include "fixturegroup.h"
#include "channelsgroup.h"
#include "collection.h"
#include "rgbmatrix.h"
#include "efxfixture.h"
#include "sequence.h"
#include "showfunction.h"
#include "show.h"
#include "monitorproperties.h"
#include "qlcfixturehead.h"
#include "track.h"
#include "script.h"
#include "audio.h"
#include "video.h"
#include "efx.h"
#include "chaserstep.h"
#include "scenevalue.h"
#include "function.h"
#include "chaser.h"
#include "scene.h"
#include "doc.h"

QJsonObject JsonView::fixture(const Fixture *fixture)
{
    QJsonObject json;

    json["id"] = qint64(fixture->id());
    json["name"] = fixture->name();
    json["type"] = fixture->typeString();

    /* 1-based, as printed on the fixture and typed into a desk. */
    json["universe"] = qint64(fixture->universe()) + 1;
    json["address"] = qint64(fixture->address()) + 1;
    json["channels"] = qint64(fixture->channels());

    const QLCFixtureDef *def = fixture->fixtureDef();
    if (def != nullptr)
    {
        json["manufacturer"] = def->manufacturer();
        json["model"] = def->model();
    }

    const QLCFixtureMode *mode = fixture->fixtureMode();
    if (mode != nullptr)
        json["mode"] = mode->name();

    /* A fixture whose definition could not be resolved still loads, backed by a
       generic dimmer. Saying so is the difference between a patch that looks
       right and one that is right. */
    json["resolved"] = (def != nullptr && mode != nullptr);

    /* How many of its channels pass through a curve on the way out.
     *
     * Only the count, so the patch list can mark the fixtures worth opening: a
     * lamp behaving oddly is explained by a modifier more often than by
     * anything else in the patch, and there is no other way to notice one
     * without opening every fixture in turn.
     *
     * The const_cast is Fixture::channelModifier missing a const overload
     * upstream; it reads a member and changes nothing. */
    Fixture *mutableFixture = const_cast<Fixture *>(fixture);
    int modifiers = 0;
    for (quint32 i = 0; i < fixture->channels(); i++)
    {
        if (mutableFixture->channelModifier(i) != nullptr)
            modifiers++;
    }
    if (modifiers > 0)
        json["modifiers"] = modifiers;

    json["heads"] = fixture->heads();

    /* What the lamp weighs and draws, for the summary a rigger prints. The
       definition's physical block is optional, so only what it actually says
       is repeated here -- an invented zero reads as "weightless", not
       "unknown". */
    if (mode != nullptr)
    {
        const QLCPhysical physical = mode->physical();
        QJsonObject phys;
        if (physical.weight() > 0)
            phys["weight"] = physical.weight();
        if (physical.powerConsumption() > 0)
            phys["power"] = physical.powerConsumption();
        if (physical.width() > 0)
            phys["width"] = physical.width();
        if (physical.height() > 0)
            phys["height"] = physical.height();
        if (physical.depth() > 0)
            phys["depth"] = physical.depth();
        if (phys.isEmpty() == false)
            json["physical"] = phys;
    }

    return json;
}

QJsonObject JsonView::function(const Function *function)
{
    QJsonObject json;

    json["id"] = qint64(function->id());
    json["name"] = function->name();
    json["type"] = Function::typeToString(function->type());
    json["running"] = function->isRunning();
    /* Flashing is not running: the engine's flash overlay lights without
       owning the run state, and a client that cannot see it draws a lit
       button as dark. */
    if (function->flashing())
        json["flashing"] = true;

    /* Speeds, in milliseconds. Exposed so a speed dial's effect is observable
       rather than merely acknowledged. */
    json["fadeIn"] = qint64(function->fadeInSpeed());
    json["fadeOut"] = qint64(function->fadeOutSpeed());
    json["duration"] = qint64(function->duration());

    /* Organization and run semantics. The path is the folder tree the
       function lives in; run order and direction are QLC+'s own strings,
       lowercased the way the PATCH accepts them back. */
    /* Simplified: the bare folder, without the type-name root QLC+ 5
       prefixes internally. */
    if (function->path(true).isEmpty() == false)
        json["path"] = function->path(true);
    json["runOrder"] = Function::runOrderToString(function->runOrder()).toLower();
    json["direction"] = Function::directionToString(function->direction()).toLower();
    json["tempoType"] = Function::tempoTypeToString(function->tempoType()).toLower();

    /* Where a chaser has got to. This rides on the function list, which the
       live feed already broadcasts, so a cue list can show the cue that is
       actually up without asking for it. */
    if (function->type() == Function::ChaserType)
    {
        const Chaser *chaser = qobject_cast<const Chaser *>(function);
        json["step"] = chaser->currentStepIndex();
        json["steps"] = chaser->stepsCount();
    }

    return json;
}

QJsonObject JsonView::universe(const Universe *universe, int index)
{
    QJsonObject json;

    json["id"] = index + 1;
    json["name"] = universe->name();

    QJsonArray outputs;
    for (int i = 0; i < universe->outputPatchesCount(); i++)
    {
        const OutputPatch *patch = universe->outputPatch(i);
        if (patch == nullptr)
            continue;

        QJsonObject out;
        out["plugin"] = patch->pluginName();
        out["output"] = patch->outputName();

        /* The plugin's own knobs (ArtNet's target IP, OSC's ports), read
           back from the plugin so what is shown is what is running. */
        const QMap<QString, QVariant> parameters =
            const_cast<OutputPatch *>(patch)->getPluginParameters();
        if (parameters.isEmpty() == false)
        {
            QJsonObject knobs;
            for (auto it = parameters.constBegin(); it != parameters.constEnd(); ++it)
                knobs[it.key()] = QJsonValue::fromVariant(it.value());
            out["parameters"] = knobs;
        }
        outputs.append(out);
    }
    json["outputs"] = outputs;

    /* No output patch means this universe reaches nothing, however healthy the
       rest of the project looks. */
    json["patched"] = (outputs.isEmpty() == false);

    const InputPatch *input = universe->inputPatch();
    if (input != nullptr)
    {
        QJsonObject in;
        in["plugin"] = input->pluginName();
        in["line"] = input->inputName();
        in["profile"] = input->profileName();

        const QMap<QString, QVariant> parameters =
            const_cast<InputPatch *>(input)->getPluginParameters();
        if (parameters.isEmpty() == false)
        {
            QJsonObject knobs;
            for (auto it = parameters.constBegin(); it != parameters.constEnd(); ++it)
                knobs[it.key()] = QJsonValue::fromVariant(it.value());
            in["parameters"] = knobs;
        }
        json["input"] = in;
    }

    const OutputPatch *feedback = universe->feedbackPatch();
    if (feedback != nullptr && feedback->isPatched())
    {
        QJsonObject fb;
        fb["plugin"] = feedback->pluginName();
        fb["line"] = feedback->outputName();
        json["feedback"] = fb;
    }

    /* Passthrough sends what arrives on the input straight back out. Worth
       reporting, because a universe in passthrough ignores the desk and an
       operator staring at unresponsive lights has no other way to find out. */
    json["passthrough"] = universe->passthrough();

    return json;
}

QJsonArray JsonView::fixtures(const Doc *doc)
{
    QJsonArray array;
    for (const Fixture *f : doc->fixtures())
        array.append(fixture(f));
    return array;
}

QJsonArray JsonView::functions(const Doc *doc)
{
    QJsonArray array;
    for (const Function *f : doc->functions())
        array.append(function(f));
    return array;
}

QJsonObject JsonView::functionBody(const Doc *doc, const Function *function)
{
    QJsonObject json;
    json["id"] = qint64(function->id());
    json["type"] = Function::typeToString(function->type());

    /* A name for whatever this step or member points at. A cue list showing
       "función 7" is a cue list nobody can run. */
    const auto named = [doc](quint32 id) {
        const Function *target = doc->function(id);
        return target != nullptr ? target->name() : QStringLiteral("(borrada)");
    };

    if (function->type() == Function::ChaserType)
    {
        const Chaser *chaser = qobject_cast<const Chaser *>(function);

        QJsonArray steps;
        const QList<ChaserStep> list = chaser->steps();
        for (int i = 0; i < list.count(); i++)
        {
            const ChaserStep &step = list.at(i);

            QJsonObject entry;
            entry["index"] = i;
            entry["function"] = qint64(step.fid);
            entry["name"] = step.note.isEmpty() ? named(step.fid) : step.note;
            /* The raw note travels apart from the display name, so an editor
               can tell "named by hand" from "named after its function". */
            if (step.note.isEmpty() == false)
                entry["note"] = step.note;
            entry["fadeIn"] = qint64(step.fadeIn);
            entry["hold"] = qint64(step.hold);
            entry["fadeOut"] = qint64(step.fadeOut);
            entry["duration"] = qint64(step.duration);
            steps.append(entry);
        }

        json["steps"] = steps;
        json["step"] = chaser->currentStepIndex();
        json["fadeInMode"] = Chaser::speedModeToString(chaser->fadeInMode()).toLower();
        json["fadeOutMode"] = Chaser::speedModeToString(chaser->fadeOutMode()).toLower();
        json["durationMode"] = Chaser::speedModeToString(chaser->durationMode()).toLower();
        return json;
    }

    if (function->type() == Function::SceneType)
    {
        const Scene *scene = qobject_cast<const Scene *>(function);

        QJsonArray values;
        for (const SceneValue &value : scene->values())
        {
            QJsonObject entry;
            entry["fixture"] = qint64(value.fxi);
            entry["channel"] = qint64(value.channel);
            entry["value"] = value.value;

            const Fixture *fixture = doc->fixture(value.fxi);
            if (fixture != nullptr)
            {
                entry["fixtureName"] = fixture->name();

                const QLCChannel *channel = fixture->channel(value.channel);
                if (channel != nullptr)
                    entry["channelName"] = channel->name();
            }

            values.append(entry);
        }

        json["values"] = values;

        /* The palettes this scene resolves at start, with names -- and the
           fixtures they resolve against, which for a palette-only scene is
           the whole recipe. */
        if (scene->palettes().isEmpty() == false)
        {
            QJsonArray palettes;
            for (quint32 id : scene->palettes())
            {
                const QLCPalette *palette = doc->palette(id);
                QJsonObject entry;
                entry["id"] = qint64(id);
                entry["name"] =
                    palette != nullptr ? palette->name() : QStringLiteral("(borrada)");
                palettes.append(entry);
            }
            json["palettes"] = palettes;

            QJsonArray fixtures;
            for (quint32 id : scene->fixtures())
                fixtures.append(qint64(id));
            json["fixtures"] = fixtures;
        }
        return json;
    }

    if (function->type() == Function::CollectionType)
    {
        const Collection *collection = qobject_cast<const Collection *>(function);

        QJsonArray members;
        for (quint32 id : collection->functions())
        {
            QJsonObject entry;
            entry["function"] = qint64(id);
            entry["name"] = named(id);
            members.append(entry);
        }

        json["members"] = members;
        return json;
    }

    if (function->type() == Function::EFXType)
    {
        const EFX *efx = qobject_cast<const EFX *>(function);

        json["algorithm"] = EFX::algorithmToString(efx->algorithm());

        QJsonObject geometry;
        geometry["width"] = efx->width();
        geometry["height"] = efx->height();
        geometry["xOffset"] = efx->xOffset();
        geometry["yOffset"] = efx->yOffset();
        geometry["rotation"] = efx->rotation();
        geometry["startOffset"] = efx->startOffset();
        geometry["xFrequency"] = efx->xFrequency();
        geometry["yFrequency"] = efx->yFrequency();
        geometry["xPhase"] = efx->xPhase();
        geometry["yPhase"] = efx->yPhase();
        json["geometry"] = geometry;
        json["propagation"] = EFX::propagationModeToString(efx->propagationMode());

        /* Twice over, on purpose: "fixtures" is exactly what PUT takes back,
           and "heads" is the same thing with names on it. An EFX listing
           "fixture 7" is one nobody can check against the rig. */
        QJsonArray ids;
        QJsonArray heads;
        for (const EFXFixture *member : efx->fixtures())
        {
            ids.append(qint64(member->head().fxi));

            QJsonObject entry;
            entry["fixture"] = qint64(member->head().fxi);
            entry["head"] = member->head().head;
            entry["offset"] = member->startOffset();
            entry["reverse"] = member->direction() == Function::Backward;
            entry["mode"] = EFXFixture::modeToString(member->mode());

            const Fixture *fixture = doc->fixture(member->head().fxi);
            entry["name"] = fixture != nullptr ? fixture->name()
                                               : QStringLiteral("(borrado)");
            heads.append(entry);
        }
        json["fixtures"] = ids;
        json["heads"] = heads;
        return json;
    }

    if (function->type() == Function::RGBMatrixType)
    {
        const RGBMatrix *matrix = qobject_cast<const RGBMatrix *>(function);

        const RGBAlgorithm *algorithm = matrix->algorithm();
        json["algorithm"] = algorithm != nullptr ? algorithm->name() : QString();

        /* A matrix without a group is legal to build and produces nothing, so
           the group is reported rather than assumed. */
        const quint32 groupId = matrix->fixtureGroup();
        json["fixtureGroup"] = qint64(groupId);

        const FixtureGroup *group = doc->fixtureGroup(groupId);
        json["groupName"] = group != nullptr ? group->name() : QString();

        QJsonArray colors;
        const int accepted = algorithm != nullptr ? algorithm->acceptColors() : 0;
        for (int i = 0; i < accepted; i++)
        {
            const QColor color = matrix->getColor(i);
            colors.append(color.isValid() ? color.name() : QString());
        }

        /* The same spelling PUT takes, so a client can read a body, change a
           field and send it straight back. */
        json["colors"] = colors;
        json["acceptsColors"] = accepted;
        json["blendMode"] = Universe::blendModeToString(matrix->blendMode());
        json["controlMode"] = RGBMatrix::controlModeToString(matrix->controlMode());

        if (algorithm != nullptr && algorithm->type() == RGBAlgorithm::Text)
        {
            const RGBText *text = static_cast<const RGBText *>(algorithm);
            QJsonObject entry;
            entry["content"] = text->text();
            entry["font"] = text->font().toString();
            entry["animation"] = RGBText::animationStyleToString(text->animationStyle());
            json["text"] = entry;
            json["animations"] = QJsonArray::fromStringList(RGBText::animationStyles());
        }
        else if (algorithm != nullptr && algorithm->type() == RGBAlgorithm::Image)
        {
            const RGBImage *image = static_cast<const RGBImage *>(algorithm);
            QJsonObject entry;
            entry["file"] = image->filename();
            entry["animation"] = RGBImage::animationStyleToString(image->animationStyle());
            json["image"] = entry;
            json["animations"] = QJsonArray::fromStringList(RGBImage::animationStyles());
        }
        else if (algorithm != nullptr && algorithm->type() == RGBAlgorithm::Script)
        {
            /* The script's own knobs, values read through the MATRIX (which
               owns the applied set), shapes from the property declarations. */
            RGBScript *script =
                const_cast<RGBScript *>(static_cast<const RGBScript *>(algorithm));
            QJsonArray properties;
            for (const RGBScriptProperty &property : script->properties())
            {
                QJsonObject entry;
                entry["name"] = property.m_name;
                entry["label"] = property.m_displayName;
                switch (property.m_type)
                {
                case RGBScriptProperty::List:
                    entry["type"] = QStringLiteral("list");
                    entry["values"] = QJsonArray::fromStringList(property.m_listValues);
                    break;
                case RGBScriptProperty::Range:
                    entry["type"] = QStringLiteral("range");
                    entry["min"] = property.m_rangeMinValue;
                    entry["max"] = property.m_rangeMaxValue;
                    break;
                case RGBScriptProperty::Float:
                    entry["type"] = QStringLiteral("float");
                    break;
                default:
                    entry["type"] = QStringLiteral("string");
                    break;
                }
                /* Non-const in the engine only because it may lazily ask the
                   script; reading through const_cast is safe here. */
                entry["value"] = const_cast<RGBMatrix *>(matrix)->property(property.m_name);
                properties.append(entry);
            }
            json["properties"] = properties;
        }
        return json;
    }

    if (function->type() == Function::ScriptType)
    {
        json["data"] = qobject_cast<const Script *>(function)->data();
        return json;
    }

    if (function->type() == Function::AudioType)
    {
        const Audio *audio = qobject_cast<const Audio *>(function);
        json["source"] = audio->getSourceFileName();
        json["volume"] = audio->volume();

        /* Which output it plays through, empty for the system default. A show
           that sends its click track to a wedge and its playback to the PA
           names them, and a name that is only in the file is a setting nobody
           can check. */
        if (audio->audioDevice().isEmpty() == false)
            json["device"] = audio->audioDevice();

        return json;
    }

    if (function->type() == Function::VideoType)
    {
        json["source"] = qobject_cast<const Video *>(function)->sourceUrl();
        return json;
    }

    if (function->type() == Function::SequenceType)
    {
        /* A sequence is a chaser bound to one scene: its steps are that
           scene's values, step by step, so both halves have to be reported. */
        const Sequence *sequence = qobject_cast<const Sequence *>(function);
        const quint32 sceneId = sequence->boundSceneID();

        json["scene"] = qint64(sceneId);
        const Function *scene = doc->function(sceneId);
        json["sceneName"] = scene != nullptr ? scene->name() : QStringLiteral("(borrada)");

        QJsonArray steps;
        const QList<ChaserStep> list = sequence->steps();
        for (int i = 0; i < list.count(); i++)
        {
            const ChaserStep &step = list.at(i);
            QJsonObject entry;
            entry["index"] = i;
            /* Same shape as a chaser's steps, so one client type fits both:
               the function is the bound scene, the name is the note or a
               plain ordinal. */
            entry["function"] = qint64(step.fid);
            entry["name"] = step.note.isEmpty()
                ? QStringLiteral("Paso %1").arg(i + 1)
                : step.note;
            entry["fadeIn"] = qint64(step.fadeIn);
            entry["hold"] = qint64(step.hold);
            entry["fadeOut"] = qint64(step.fadeOut);
            entry["duration"] = qint64(step.duration);
            if (step.note.isEmpty() == false)
                entry["note"] = step.note;

            QJsonArray values;
            for (const SceneValue &value : step.values)
            {
                QJsonObject one;
                one["fixture"] = qint64(value.fxi);
                one["channel"] = qint64(value.channel);
                one["value"] = value.value;
                values.append(one);
            }
            entry["values"] = values;
            steps.append(entry);
        }
        json["steps"] = steps;
        return json;
    }

    if (function->type() == Function::ShowType)
    {
        /* A multi-track timeline. Each track carries functions placed at a
           time, and what a track is *bound* to matters as much as what is on
           it: a track holds a scene, and the sequences on that track are that
           scene's values over time. A track whose scene is gone is a track
           whose sequences address nothing. */
        const Show *show = qobject_cast<const Show *>(function);

        QJsonArray tracks;
        quint32 total = 0;

        for (const Track *track : show->tracks())
        {
            QJsonObject entry;
            entry["id"] = qint64(track->id());
            entry["name"] = track->name();
            entry["mute"] = track->isMute();

            const quint32 sceneId = track->getSceneID();
            if (sceneId != Function::invalidId())
            {
                entry["scene"] = qint64(sceneId);
                const Function *scene = doc->function(sceneId);
                entry["sceneName"] = scene != nullptr ? scene->name()
                                                      : QStringLiteral("(borrada)");
            }

            QJsonArray items;
            for (const ShowFunction *item : track->showFunctions())
            {
                const Function *placed = doc->function(item->functionID());

                QJsonObject one;
                one["id"] = qint64(item->id());
                one["function"] = qint64(item->functionID());
                one["start"] = qint64(item->startTime());

                /* The duration the timeline actually honours. A ShowFunction
                   left at 0 borrows the function's own, and reporting the
                   stored 0 would draw a bar of no width for something that
                   plays for a minute. */
                const quint32 duration = item->duration(doc);
                one["duration"] = qint64(duration);
                one["locked"] = item->isLocked();

                if (item->color().isValid())
                    one["color"] = item->color().name();

                if (placed != nullptr)
                {
                    one["name"] = placed->name();
                    one["type"] = Function::typeToString(placed->type());
                }
                else
                {
                    /* Reported rather than hidden: a show with a hole in it
                       plays silence where a cue used to be, and the timeline is
                       the only place that can say so. */
                    one["missing"] = true;
                    one["name"] = QStringLiteral("(borrada)");
                }

                total = qMax(total, item->startTime() + duration);
                items.append(one);
            }

            entry["functions"] = items;
            tracks.append(entry);
        }

        json["tracks"] = tracks;
        json["duration"] = qint64(total);
        json["timeDivision"] = Show::tempoToString(show->timeDivisionType());
        json["bpm"] = show->timeDivisionBPM();
        return json;
    }

    json["note"] = QStringLiteral("The body of a %1 is not readable yet")
                       .arg(Function::typeToString(function->type()).toLower());
    return json;
}

QJsonArray JsonView::universes(const Doc *doc)
{
    QJsonArray array;

    const QList<Universe *> list = doc->inputOutputMap()->universes();
    for (int i = 0; i < list.count(); i++)
        array.append(universe(list.at(i), i));

    return array;
}

QJsonObject JsonView::channelGroup(const Doc *doc, quint32 groupId, const LevelSource *levels)
{
    QJsonObject json;

    const ChannelsGroup *group = doc->channelsGroup(groupId);
    if (group == nullptr)
        return json;

    json["id"] = qint64(group->id());
    json["name"] = group->name();

    QJsonArray channels;
    int missing = 0;

    for (const SceneValue &value : group->getChannels())
    {
        QJsonObject entry;
        entry["fixture"] = qint64(value.fxi);
        entry["channel"] = qint64(value.channel);

        const Fixture *fixture = doc->fixture(value.fxi);
        const QLCChannel *channel = fixture != nullptr ? fixture->channel(value.channel) : nullptr;

        /* A channel whose fixture is gone is reported as it is stored, marked.
           Silently dropping it would make a group look smaller than it is and
           hide the reason a fader stopped doing half of what it did. */
        if (fixture == nullptr)
        {
            entry["missing"] = true;
            missing++;
        }
        else
        {
            entry["fixtureName"] = fixture->name();
            entry["address"] = qint64(fixture->universeAddress() + value.channel);
            entry["universe"] = qint64(fixture->universe()) + 1;
            if (channel != nullptr)
            {
                entry["name"] = channel->name();
                entry["group"] = QLCChannel::groupToString(channel->group());
            }
        }

        channels.append(entry);
    }

    json["channels"] = channels;
    if (missing > 0)
        json["missing"] = missing;

    if (levels != nullptr)
    {
        const quint32 sliderId = LevelSource::channelGroupSlider(group->id());
        json["value"] = int(levels->value(sliderId));

        /* A group whose channels have all lost their fixtures still loads, and
           its fader still moves, and nothing happens. Say so rather than
           drawing a control that lies. */
        json["controllable"] = levels->knows(sliderId);
    }

    return json;
}

QJsonArray JsonView::channelGroups(const Doc *doc, const LevelSource *levels)
{
    QJsonArray array;

    for (const ChannelsGroup *group : doc->channelsGroups())
    {
        if (group != nullptr)
            array.append(channelGroup(doc, group->id(), levels));
    }

    return array;
}

QJsonObject JsonView::plan(const Doc *doc)
{
    QJsonObject json;

    /* Doc::monitorProperties has no const overload upstream; it returns a
       member and changes nothing. */
    MonitorProperties *monitor = const_cast<Doc *>(doc)->monitorProperties();

    /* The stage, in metres or feet as the project says. Positions are stored in
       millimetres against this, so the interface needs both to place anything. */
    QJsonObject grid;
    grid["width"] = monitor->gridSize().x();
    grid["height"] = monitor->gridSize().y();
    grid["depth"] = monitor->gridSize().z();
    grid["units"] = monitor->gridUnits() == MonitorProperties::Feet ? QStringLiteral("feet")
                                                                    : QStringLiteral("meters");
    json["grid"] = grid;

    json["background"] = monitor->commonBackgroundImage().isEmpty() == false;

    QJsonArray fixtures;

    for (const Fixture *fixture : doc->fixtures())
    {
        QJsonObject entry;
        entry["id"] = qint64(fixture->id());
        entry["name"] = fixture->name();
        entry["universe"] = qint64(fixture->universe()) + 1;
        entry["address"] = qint64(fixture->address());
        entry["channels"] = qint64(fixture->channels());

        /* Placed or not, said plainly. QLC+ stores a position only for fixtures
           somebody has put somewhere. */
        if (monitor->containsFixture(fixture->id()))
        {
            const QVector3D position = monitor->fixturePosition(fixture->id(), 0, 0);
            const QVector3D rotation = monitor->fixtureRotation(fixture->id(), 0, 0);

            /* X and Y only: a plan is a top view, and this build of the engine
               saves nothing else (monitorproperties.cpp:959). */
            entry["x"] = position.x();
            entry["y"] = position.y();
            entry["rotation"] = rotation.y();

            const QColor gel = monitor->fixtureGelColor(fixture->id(), 0, 0);
            if (gel.isValid())
                entry["gel"] = gel.name();

            const int zoom = monitor->fixtureFixedZoom(fixture->id(), 0, 0);
            if (zoom > 0)
                entry["zoom"] = zoom;

            const quint32 flags = monitor->fixtureFlags(fixture->id(), 0, 0);
            if (flags & MonitorProperties::HiddenFlag)
                entry["hidden"] = true;
            if (flags & MonitorProperties::LockedFlag)
                entry["locked"] = true;
            if (flags & MonitorProperties::InvertedPanFlag)
                entry["invertPan"] = true;
            if (flags & MonitorProperties::InvertedTiltFlag)
                entry["invertTilt"] = true;

            /* A multi-head bar stores an item per head beyond the fixture's
               own. Saying which heads carry properties is what lets a client
               edit them without inventing entries for the rest. */
            QJsonArray headItems;
            for (quint32 subID : monitor->fixtureIDList(fixture->id()))
            {
                const quint16 headIndex = monitor->fixtureHeadIndex(subID);
                const quint16 linkedIndex = monitor->fixtureLinkedIndex(subID);
                if (headIndex == 0 || linkedIndex != 0)
                    continue;

                QJsonObject item;
                item["head"] = headIndex;

                const QVector3D headPos =
                    monitor->fixturePosition(fixture->id(), headIndex, 0);
                item["x"] = headPos.x();
                item["y"] = headPos.y();
                item["rotation"] =
                    monitor->fixtureRotation(fixture->id(), headIndex, 0).y();

                const QColor headGel =
                    monitor->fixtureGelColor(fixture->id(), headIndex, 0);
                if (headGel.isValid())
                    item["gel"] = headGel.name();

                const int headZoom =
                    monitor->fixtureFixedZoom(fixture->id(), headIndex, 0);
                if (headZoom > 0)
                    item["zoom"] = headZoom;

                const quint32 headFlags =
                    monitor->fixtureFlags(fixture->id(), headIndex, 0);
                if (headFlags & MonitorProperties::HiddenFlag)
                    item["hidden"] = true;
                if (headFlags & MonitorProperties::LockedFlag)
                    item["locked"] = true;
                if (headFlags & MonitorProperties::InvertedPanFlag)
                    item["invertPan"] = true;
                if (headFlags & MonitorProperties::InvertedTiltFlag)
                    item["invertTilt"] = true;

                headItems.append(item);
            }
            if (headItems.isEmpty() == false)
                entry["headItems"] = headItems;

            /* Linked items: the same lamp drawn again. Only on the plan and
               in the file; the DMX is untouched. */
            QJsonArray linkedItems;
            for (quint32 subID : monitor->fixtureIDList(fixture->id()))
            {
                const quint16 headIndex = monitor->fixtureHeadIndex(subID);
                const quint16 linkedIndex = monitor->fixtureLinkedIndex(subID);
                if (linkedIndex == 0)
                    continue;

                QJsonObject item;
                item["linked"] = linkedIndex;
                item["head"] = headIndex;
                item["name"] = monitor->fixtureName(fixture->id(), headIndex, linkedIndex);

                const QVector3D linkedPos =
                    monitor->fixturePosition(fixture->id(), headIndex, linkedIndex);
                item["x"] = linkedPos.x();
                item["y"] = linkedPos.y();
                item["rotation"] =
                    monitor->fixtureRotation(fixture->id(), headIndex, linkedIndex).y();
                linkedItems.append(item);
            }
            if (linkedItems.isEmpty() == false)
                entry["linkedItems"] = linkedItems;
        }

        entry["heads"] = fixture->heads();

        /* Which channels decide what this lamp looks like.
         *
         * Offsets from the fixture's address, not absolute addresses: the
         * interface reads them against the frame it already has, and a fixture
         * that gets re-patched keeps the same roles. */
        QJsonObject roles;

        const quint32 dimmer = fixture->masterIntensityChannel();
        if (dimmer != QLCChannel::invalid())
            roles["intensity"] = qint64(dimmer);

        const QVector<quint32> rgb = fixture->rgbChannels();
        if (rgb.size() == 3)
        {
            roles["red"] = qint64(rgb.at(0));
            roles["green"] = qint64(rgb.at(1));
            roles["blue"] = qint64(rgb.at(2));
        }

        const QVector<quint32> cmy = fixture->cmyChannels();
        if (cmy.size() == 3)
        {
            roles["cyan"] = qint64(cmy.at(0));
            roles["magenta"] = qint64(cmy.at(1));
            roles["yellow"] = qint64(cmy.at(2));
        }

        const auto role = [&](int preset, const char *name) {
            const quint32 channel = fixture->channelNumber(preset, QLCChannel::MSB);
            if (channel != QLCChannel::invalid())
                roles[QLatin1String(name)] = qint64(channel);
        };

        role(QLCChannel::IntensityWhite, "white");
        role(QLCChannel::IntensityAmber, "amber");
        role(QLCChannel::IntensityUV, "uv");

        entry["roles"] = roles;

        /* A fixture that resolved to a generic dimmer has no colour channels at
           all, and drawing it grey with no explanation reads as "off". */
        entry["resolved"] = fixture->fixtureMode() != nullptr;

        fixtures.append(entry);
    }

    json["fixtures"] = fixtures;
    return json;
}

QJsonObject JsonView::vcWidget(const VcWidget &widget, const Doc *doc,
                               const LevelSource *levels)
{
    QJsonObject json;

    json["type"] = widget.type;
    if (widget.hasId)
        json["id"] = qint64(widget.id);
    if (widget.page != 0)
        json["page"] = widget.page;
    if (widget.caption.isEmpty() == false)
        json["caption"] = widget.caption;

    QJsonObject geometry;
    geometry["x"] = widget.geometry.x();
    geometry["y"] = widget.geometry.y();
    geometry["width"] = widget.geometry.width();
    geometry["height"] = widget.geometry.height();
    json["geometry"] = geometry;

    if (widget.background.isEmpty() == false)
        json["background"] = widget.background;
    if (widget.foreground.isEmpty() == false)
        json["foreground"] = widget.foreground;

    /* The font as the file holds it -- QFont::toString(), sixteen fields --
       plus the two an operator actually chooses, split out. A browser cannot do
       anything with "Arial,12,-1,5,400,0,0,0,0,0,0,0,0,0,0,1" except send it
       back, and the round trip is what keeps the other fourteen fields. */
    if (widget.font.isEmpty() == false)
    {
        json["font"] = widget.font;

        const QStringList parts = widget.font.split(QLatin1Char(','));
        if (parts.count() >= 2)
        {
            json["fontFamily"] = parts.at(0);
            const int size = parts.at(1).toInt();
            if (size > 0)
                json["fontSize"] = size;
        }
    }

    if (widget.frameStyle.isEmpty() == false)
        json["frameStyle"] = widget.frameStyle;

    /* What moves this widget from outside. The universe is an input universe,
       which is a different numbering from the DMX universes the fixtures live
       in, so it is reported under its own key rather than next to anything that
       might be mistaken for a patch. */
    if (widget.hasInput)
    {
        QJsonObject input;
        input["universe"] = qint64(widget.inputUniverse);
        input["channel"] = qint64(widget.inputChannel);
        /* Only when custom: the absent case IS 0/255, and writing the
           defaults would invite clients to send them back and dirty files. */
        if (widget.feedbackLower != 0)
            input["lower"] = int(widget.feedbackLower);
        if (widget.feedbackUpper != 255)
            input["upper"] = int(widget.feedbackUpper);
        json["input"] = input;
    }

    if (widget.key.isEmpty() == false)
        json["key"] = widget.key;
    if (widget.sliderStyle.isEmpty() == false)
        json["sliderStyle"] = widget.sliderStyle;

    if (widget.pagesLoop)
        json["pagesLoop"] = true;
    if (widget.pageShortcuts.isEmpty() == false)
    {
        QJsonArray shortcuts;
        for (const auto &shortcut : widget.pageShortcuts)
        {
            QJsonObject entry;
            entry["page"] = shortcut.first;
            entry["name"] = shortcut.second;
            shortcuts.append(entry);
        }
        json["pageShortcuts"] = shortcuts;
    }
    if (widget.sideFaderMode.isEmpty() == false
        && widget.sideFaderMode != QStringLiteral("None"))
        json["sideFaderMode"] = widget.sideFaderMode;

    if (widget.padPresets.isEmpty() == false)
    {
        QJsonArray presets;
        for (const VcWidget::PadPreset &preset : widget.padPresets)
        {
            QJsonObject entry;
            entry["id"] = preset.id;
            entry["type"] = preset.type;
            entry["name"] = preset.name;
            if (preset.functionId != UINT_MAX)
                entry["function"] = qint64(preset.functionId);
            if (preset.x >= 0)
            {
                entry["x"] = preset.x;
                entry["y"] = preset.y;
            }
            presets.append(entry);
        }
        json["padPresets"] = presets;
    }

    if (widget.schedules.isEmpty() == false)
    {
        QJsonArray schedules;
        for (const VcWidget::ClockSchedule &schedule : widget.schedules)
        {
            QJsonObject entry;
            entry["function"] = qint64(schedule.functionId);
            entry["start"] = QTime::fromMSecsSinceStartOfDay(schedule.startTime * 1000)
                                 .toString(QStringLiteral("HH:mm:ss"));
            if (schedule.stopTime >= 0)
                entry["stop"] = QTime::fromMSecsSinceStartOfDay(schedule.stopTime * 1000)
                                    .toString(QStringLiteral("HH:mm:ss"));
            entry["weekFlags"] = schedule.weekFlags;
            schedules.append(entry);
        }
        json["schedules"] = schedules;
    }

    if (widget.hasFunction)
        json["functionId"] = qint64(widget.functionId);
    if (widget.action.isEmpty() == false)
        json["action"] = widget.action;
    if (widget.flashOverride)
        json["flashOverride"] = true;
    if (widget.flashForceLTP)
        json["flashForceLTP"] = true;
    if (widget.startupIntensityEnabled)
    {
        QJsonObject intensity;
        intensity["enabled"] = true;
        intensity["value"] = widget.startupIntensity;
        json["startupIntensity"] = intensity;
    }

    if (widget.hasChaser)
    {
        json["chaserId"] = qint64(widget.chaserId);
        json["controllable"] = true;
    }

    if (widget.audioBars.isEmpty() == false || widget.audioBands > 0)
    {
        QJsonArray bars;
        for (const VcWidget::AudioBar &bar : widget.audioBars)
        {
            /* Bars of type 0 are unassigned: QLC+ writes the widget out only
               when at least one is assigned, but the rest still appear. */
            if (bar.type == 0)
                continue;

            QJsonObject entry;
            entry["name"] = bar.name;
            entry["index"] = bar.index;
            entry["volume"] = bar.isVolume;
            entry["minThreshold"] = bar.minThreshold;
            entry["maxThreshold"] = bar.maxThreshold;

            switch (bar.type)
            {
            case 1:
                entry["drives"] = QStringLiteral("dmx");
                entry["channels"] = bar.dmxChannels.count();
                break;
            case 2:
                entry["drives"] = QStringLiteral("function");
                entry["functionId"] = qint64(bar.functionId);
                break;
            case 3:
                entry["drives"] = QStringLiteral("widget");
                entry["widgetId"] = qint64(bar.targetWidgetId);
                break;
            default:
                entry["drives"] = QStringLiteral("nothing");
                break;
            }

            bars.append(entry);
        }

        json["bands"] = widget.audioBands;
        json["bars"] = bars;
        json["controllable"] = (bars.isEmpty() == false);
    }

    if (widget.matrixPresets.isEmpty() == false)
    {
        QJsonArray presets;
        for (const VcWidget::MatrixPreset &preset : widget.matrixPresets)
        {
            QJsonObject entry;
            entry["id"] = preset.id;
            entry["type"] = preset.type;
            if (preset.color.isEmpty() == false)
                entry["color"] = preset.color;
            if (preset.resource.isEmpty() == false)
                entry["resource"] = preset.resource;

            /* Colour and animation presets are buttons and can be applied.
               Knobs are continuous, and images and text need a file: they are
               reported rather than offered, because a control that looks live
               and does nothing is the failure this project exists to avoid.
             *
             * Note the Knob exclusion is not decoration -- "Color1Knob" starts
             * with "Color" too, and a prefix test alone offered every knob. */
            entry["applicable"] =
                (preset.type.startsWith(QStringLiteral("Color"))
                 && preset.type.contains(QStringLiteral("Knob")) == false)
                || preset.type == QStringLiteral("Animation");
            presets.append(entry);
        }

        json["presets"] = presets;
        json["instantApply"] = widget.instantApply;
    }

    if (widget.pages > 0)
    {
        json["pages"] = widget.pages;
        json["currentPage"] = widget.currentPage;
    }
    if (widget.showHeader == false)
        json["showHeader"] = false;
    if (widget.collapsed)
        json["collapsed"] = true;

    if (widget.padHeads.isEmpty() == false)
    {
        /* The heads themselves are not sent: an interface steers the pad, not
           the lamps, and their limits are the project's business. What it does
           need is whether there is anything steerable behind this pad, and
           where it was left.
         *
         * Counted against Doc rather than taken from the file, because a pad
         * can name a fixture that has no pan or tilt at all -- and then it is
         * a control that looks right and moves nothing. */
        int steerable = 0;
        for (const VcWidget::PadHead &head : widget.padHeads)
        {
            const Fixture *fixture = doc != nullptr ? doc->fixture(head.fixtureId) : nullptr;
            if (doc == nullptr
                || (fixture != nullptr
                    && (fixture->channelNumber(QLCChannel::Pan, QLCChannel::MSB, head.head)
                            != QLCChannel::invalid()
                        || fixture->channelNumber(QLCChannel::Tilt, QLCChannel::MSB, head.head)
                            != QLCChannel::invalid())))
            {
                steerable++;
            }
        }

        json["padHeads"] = steerable;
        json["padX"] = widget.padX;
        json["padY"] = widget.padY;
        json["controllable"] = (steerable > 0);
    }

    if (widget.clockType.isEmpty() == false)
    {
        json["clockType"] = widget.clockType;
        json["clockTime"] = widget.clockTime;
    }

    if (widget.speedTargets.isEmpty() == false)
    {
        QJsonArray targets;
        for (const VcWidget::SpeedTarget &target : widget.speedTargets)
        {
            QJsonObject entry;
            entry["functionId"] = qint64(target.functionId);
            entry["fadeIn"] = target.fadeIn;
            entry["fadeOut"] = target.fadeOut;
            entry["duration"] = target.duration;
            targets.append(entry);
        }
        json["speedTargets"] = targets;
        json["speedMs"] = widget.speedMs;
        json["speedMin"] = widget.speedMin;
        json["speedMax"] = widget.speedMax;
        json["controllable"] = true;
    }

    if (widget.sliderMode.isEmpty() == false)
    {
        json["sliderMode"] = widget.sliderMode;
        json["low"] = widget.low;
        json["high"] = widget.high;
        json["value"] = widget.value;
        /* A slider is movable when there is something behind it: channels for
           a level slider, a function for a playback one. Saying so keeps the
           interface from offering a control that would do nothing.
         *
         * A submaster is not, yet: it scales the widgets around it, and that
           is not modelled. Offering it would be a lie the operator discovers
           when nothing dims. */
        if (widget.sliderMode == QStringLiteral("submaster"))
        {
            /* A submaster is movable when it encloses something a submaster
               actually scales -- a fader with channels, a playback, a button,
               a cue list. One alone in a frame of labels and XY pads is a
               control that would do nothing, and saying otherwise is the exact
               failure this project exists to avoid. */
            json["controllable"] = (levels != nullptr && levels->scales(widget.id));
            json["scales"] = (levels != nullptr) ? levels->scaledCount(widget.id) : 0;
        }
        else
        {
            json["controllable"] =
                (widget.sliderMode == QStringLiteral("level")
                 && widget.levelChannels.isEmpty() == false)
                || (widget.sliderMode == QStringLiteral("playback") && widget.hasFunction
                    && widget.functionId != UINT_MAX)
                /* The grand master always exists; an adjust fader needs its
                   function. */
                || widget.sliderMode == QStringLiteral("grandmaster")
                || (widget.sliderMode == QStringLiteral("adjust")
                    && widget.adjustFunction != UINT_MAX);

            if (widget.adjustFunction != UINT_MAX)
            {
                QJsonObject adjust;
                adjust["function"] = qint64(widget.adjustFunction);
                adjust["attribute"] = widget.adjustAttribute;
                json["adjust"] = adjust;
            }
        }

        /* The channels themselves, so an editor can show what a fader is
           actually holding and send the list back changed. */
        QJsonArray channels;
        for (const auto &channel : widget.levelChannels)
        {
            QJsonObject entry;
            entry["fixture"] = qint64(channel.first);
            entry["channel"] = qint64(channel.second);
            channels.append(entry);
        }
        json["levelChannels"] = channels;
    }

    if (widget.children.isEmpty() == false)
    {
        QJsonArray children;
        for (const VcWidget &child : widget.children)
            children.append(vcWidget(child, doc, levels));
        json["children"] = children;
    }

    return json;
}
