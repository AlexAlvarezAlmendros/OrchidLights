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

#include "jsonview.h"
#include "virtualconsole.h"
#include "levelsource.h"

#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "inputoutputmap.h"
#include "outputpatch.h"
#include "inputpatch.h"
#include "universe.h"
#include "fixture.h"
#include "qlcchannel.h"
#include "collection.h"
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

    return json;
}

QJsonObject JsonView::function(const Function *function)
{
    QJsonObject json;

    json["id"] = qint64(function->id());
    json["name"] = function->name();
    json["type"] = Function::typeToString(function->type());
    json["running"] = function->isRunning();

    /* Speeds, in milliseconds. Exposed so a speed dial's effect is observable
       rather than merely acknowledged. */
    json["fadeIn"] = qint64(function->fadeInSpeed());
    json["fadeOut"] = qint64(function->fadeOutSpeed());
    json["duration"] = qint64(function->duration());

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
        json["input"] = in;
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
            entry["fadeIn"] = qint64(step.fadeIn);
            entry["hold"] = qint64(step.hold);
            entry["fadeOut"] = qint64(step.fadeOut);
            entry["duration"] = qint64(step.duration);
            steps.append(entry);
        }

        json["steps"] = steps;
        json["step"] = chaser->currentStepIndex();
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

    /* Everything else can be created, renamed, timed and deleted, but its body
       is not readable here yet. Saying so beats an empty list that reads as
       "this function is empty". */
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

    if (widget.hasFunction)
        json["functionId"] = qint64(widget.functionId);
    if (widget.action.isEmpty() == false)
        json["action"] = widget.action;

    if (widget.hasChaser)
    {
        json["chaserId"] = qint64(widget.chaserId);
        json["controllable"] = true;
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
                    && widget.functionId != UINT_MAX);
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
