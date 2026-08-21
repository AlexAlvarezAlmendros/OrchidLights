/*
  OrchidLights
  widgetactions.cpp

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

#include "widgetactions.h"

#include "doc.h"
#include "enginehost.h"
#include "function.h"
#include "inputoutputmap.h"
#include "levelsource.h"
#include "mastertimer.h"
#include "virtualconsole.h"

void WidgetActions::startFunction(EngineHost *engine, quint32 functionId)
{
    Doc *doc = engine->doc();
    Function *function = doc->function(functionId);
    if (function == nullptr || function->isRunning())
        return;

    /* A solo frame's contents are mutually exclusive -- the colour bank where
       picking red should drop blue. Enforced here rather than in any client
       because every transport has to agree about it: if the browser did it
       and the MIDI wing did not, the frame would only be solo for whoever
       pressed last. */
    for (quint32 sibling : engine->soloSiblings(functionId))
    {
        Function *other = doc->function(sibling);
        if (other != nullptr && other->isRunning())
            other->stop(FunctionParent::master());
    }

    function->start(doc->masterTimer(), FunctionParent::master());
}

void WidgetActions::stopFunction(EngineHost *engine, quint32 functionId)
{
    Function *function = engine->doc()->function(functionId);
    if (function != nullptr && function->isRunning())
        function->stop(FunctionParent::master());
}

int WidgetActions::pressButton(EngineHost *engine, const VcWidget &widget, bool on)
{
    /* Toggle is what a button means when its file says nothing else. */
    const QString action =
        widget.action.isEmpty() ? QStringLiteral("Toggle") : widget.action;

    if (action == QStringLiteral("Flash"))
    {
        /* Flash follows both edges: light while held, dark on release. */
        if (widget.hasFunction == false)
            return -1;
        if (on)
            startFunction(engine, widget.functionId);
        else
            stopFunction(engine, widget.functionId);
        return on ? 1 : 0;
    }

    /* Everything below acts on the press edge and ignores the release --
       toggling on both edges would undo every press when the fader falls. */
    if (on == false)
        return -1;

    if (action == QStringLiteral("Blackout"))
    {
        InputOutputMap *map = engine->doc()->inputOutputMap();
        const bool now = map->blackout() == false;
        map->setBlackout(now);
        return now ? 1 : 0;
    }

    if (action == QStringLiteral("StopAll"))
    {
        engine->stopEverything(0);
        return 0;
    }

    if (widget.hasFunction == false)
        return -1;

    Function *function = engine->doc()->function(widget.functionId);
    if (function == nullptr)
        return -1;

    if (function->isRunning())
    {
        stopFunction(engine, widget.functionId);
        return 0;
    }
    startFunction(engine, widget.functionId);
    return 1;
}

bool WidgetActions::setSliderLevel(EngineHost *engine, quint32 widgetId, uchar value)
{
    if (engine->levels() == nullptr || engine->levels()->knows(widgetId) == false)
        return false;

    engine->levels()->setValue(widgetId, value);
    return true;
}
