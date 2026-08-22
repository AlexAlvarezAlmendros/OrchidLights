/*
  OrchidLights
  widgetactions.h

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

#ifndef WIDGETACTIONS_H
#define WIDGETACTIONS_H

#include <QtGlobal>

class EngineHost;
struct VcWidget;

/**
 * What a widget DOES, in one place.
 *
 * A button pressed on a phone, tapped over the WebSocket, or moved by a MIDI
 * fader through the input router must do exactly the same thing -- one
 * implementation is the only way "the same" stays true. Anything a widget can
 * be made to do lives here; the transports only decide when to call.
 */
namespace WidgetActions
{
    /** Start a function the way a tap does: enforcing that the members of a
     *  solo frame are mutually exclusive. Nothing happens if it runs. */
    void startFunction(EngineHost *engine, quint32 functionId);

    /** Stop it if it runs; nothing happens if it does not. */
    void stopFunction(EngineHost *engine, quint32 functionId);

    /** The engine's own flash: an overlay that lights without owning the
     *  function's run state. Override and forceLTP are the button's flags. */
    void flashFunction(EngineHost *engine, quint32 functionId, bool shouldOverride,
                       bool forceLTP);
    void unflashFunction(EngineHost *engine, quint32 functionId);

    /**
     * A button's press with the widget's own action semantics.
     *
     * Toggle acts on the press edge (on) and ignores the release; Flash
     * follows both edges; Blackout flips on the press edge; StopAll stops
     * everything, now, on the press edge.
     *
     * Returns the widget's RESULTING state: 1 now on, 0 now off, -1 nothing
     * happened (a release a Toggle ignores). Reported from what the press
     * DID, not from Function::isRunning() -- start() only schedules, and a
     * feedback echo read from isRunning() one tick early says "off" to the
     * LED of a button that just went on.
     */
    int pressButton(EngineHost *engine, const VcWidget &widget, bool on);

    /** A slider's level, 0-255. True when the widget is a fader the level
     *  source has been taught -- false is "this id moves nothing". */
    bool setSliderLevel(EngineHost *engine, quint32 widgetId, uchar value);
}

#endif
