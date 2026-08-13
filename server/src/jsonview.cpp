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

#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "inputoutputmap.h"
#include "outputpatch.h"
#include "universe.h"
#include "fixture.h"
#include "function.h"
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

QJsonArray JsonView::universes(const Doc *doc)
{
    QJsonArray array;

    const QList<Universe *> list = doc->inputOutputMap()->universes();
    for (int i = 0; i < list.count(); i++)
        array.append(universe(list.at(i), i));

    return array;
}

QJsonObject JsonView::vcWidget(const VcWidget &widget)
{
    QJsonObject json;

    json["type"] = widget.type;
    json["id"] = qint64(widget.id);
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
        /* Only a level slider with channels behind it can actually be moved
           from here; saying so keeps the interface from offering a control
           that would do nothing. */
        json["controllable"] = (widget.sliderMode == QStringLiteral("level")
                                && widget.levelChannels.isEmpty() == false);
    }

    if (widget.children.isEmpty() == false)
    {
        QJsonArray children;
        for (const VcWidget &child : widget.children)
            children.append(vcWidget(child));
        json["children"] = children;
    }

    return json;
}
