/*
  OrchidLights
  inputrouter.h

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

#ifndef INPUTROUTER_H
#define INPUTROUTER_H

#include <QHash>
#include <QObject>

#include "virtualconsole.h"

class EngineHost;

/**
 * External input made to ACT.
 *
 * The bindings have always been in the file -- every widget may carry an
 * <Input Universe Channel> naming the control that moves it, and the Grand
 * Master carries one in the console's <Properties>. Until now the daemon
 * preserved and reported them and did exactly nothing when the control moved:
 * a MIDI wing plugged into a patched universe was furniture.
 *
 * This routes them: a table (input universe, channel) -> widgets, rebuilt from
 * the preserved console XML whenever it changes, dispatched through the same
 * WidgetActions every other transport uses -- so a fader on a wing and a
 * finger on a phone are indistinguishable on the wire. Feedback goes back out
 * through the universe's feedback patch, honouring the widget's custom
 * lower/upper values (the MIDI LED's two states).
 *
 * What is routed today: buttons (Toggle/Flash/Blackout/StopAll), sliders, and
 * the Grand Master. A binding on any other widget type is preserved untouched
 * but not yet routed, and the daemon says so on stderr rather than swallowing
 * it -- a binding that exists in the file and does nothing must at least
 * confess.
 */
class InputRouter final : public QObject
{
    Q_OBJECT

public:
    explicit InputRouter(EngineHost *engine, QObject *parent = nullptr);

    /** How many controls are currently routed (widgets + the GM if bound). */
    int bindingCount() const;

public slots:
    /** Re-read the console and rebuild the table. Cheap enough to run on
     *  every console edit: it is the same parse GET /vc does. */
    void rebuild();

private slots:
    void onInput(quint32 universe, quint32 channel, uchar value);

private:
    static quint64 keyOf(quint32 universe, quint32 channel);
    void sendFeedback(const VcWidget &widget, bool on) const;

    EngineHost *m_engine;

    /** One routed control: the widget plus WHICH of its hands the wire is
     *  holding -- the main one, or a frame's page turners. */
    struct Routed
    {
        VcWidget widget;
        enum Control { Main, NextPage, PrevPage } control = Main;
    };

    /** (input universe << 32 | channel) -> the controls that input moves. */
    QHash<quint64, QList<Routed>> m_table;

    /** Last value seen per control, for edge detection. Buttons act on
     *  transitions (0 -> pressed, pressed -> 0), never on a fader sweeping
     *  through its travel -- and never on their own feedback echoing back
     *  through a looped line. Deliberately NOT cleared on rebuild: this is
     *  wire state, not console state. */
    QHash<quint64, uchar> m_lastValue;

    bool m_gmBound = false;
    quint32 m_gmUniverse = 0;
    quint32 m_gmChannel = 0;
};

#endif
