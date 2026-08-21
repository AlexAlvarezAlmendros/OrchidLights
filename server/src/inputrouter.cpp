/*
  OrchidLights
  inputrouter.cpp

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

#include "inputrouter.h"

#include <QDebug>

#include "doc.h"
#include "enginehost.h"
#include "function.h"
#include "inputoutputmap.h"
#include "vcpatch.h"
#include "widgetactions.h"

InputRouter::InputRouter(EngineHost *engine, QObject *parent)
    : QObject(parent)
    , m_engine(engine)
{
    connect(engine, &EngineHost::inputSeen, this, &InputRouter::onInput);
    connect(engine, &EngineHost::consoleChanged, this, &InputRouter::rebuild);
    connect(engine, &EngineHost::projectReplaced, this, &InputRouter::rebuild);
    rebuild();
}

quint64 InputRouter::keyOf(quint32 universe, quint32 channel)
{
    return (quint64(universe) << 32) | channel;
}

int InputRouter::bindingCount() const
{
    int count = m_gmBound ? 1 : 0;
    for (auto it = m_table.constBegin(); it != m_table.constEnd(); ++it)
        count += it.value().count();
    return count;
}

void InputRouter::rebuild()
{
    m_table.clear();
    m_gmBound = false;

    const VcPatch::GrandMasterSettings master =
        VcPatch::readGrandMaster(m_engine->preservedSections());
    if (master.hasInput)
    {
        m_gmBound = true;
        m_gmUniverse = master.inputUniverse;
        m_gmChannel = master.inputChannel;
    }

    VcWidget root;
    if (VirtualConsole::parse(m_engine->preservedSections(), root) == false)
        return;

    /* Walk the whole tree: bindings live on leaves, but frames nest. */
    QList<const VcWidget *> stack{&root};
    while (stack.isEmpty() == false)
    {
        const VcWidget *widget = stack.takeLast();
        for (const VcWidget &child : widget->children)
            stack.append(&child);

        if (widget->hasInput == false)
            continue;

        if (widget->type == QStringLiteral("button")
            || widget->type == QStringLiteral("slider"))
        {
            m_table[keyOf(widget->inputUniverse, widget->inputChannel)].append(*widget);
        }
        else
        {
            /* Preserved untouched, routed not yet. Said out loud, because a
               binding that exists in the file and does nothing when the
               control moves is the kind of silence that gets a show rehearsed
               on a lie. */
            qWarning() << "input binding on unrouted widget type"
                       << widget->type << "id" << (widget->hasId ? int(widget->id) : -1)
                       << "(universe" << widget->inputUniverse << "channel"
                       << widget->inputChannel << ")";
        }
    }
}

void InputRouter::onInput(quint32 universe, quint32 channel, uchar value)
{
    const quint64 key = keyOf(universe, channel);
    const uchar last = m_lastValue.value(key, 0);
    m_lastValue.insert(key, value);
    const bool rising = value > 0 && last == 0;
    const bool falling = value == 0 && last > 0;

    if (m_gmBound && universe == m_gmUniverse && channel == m_gmChannel)
    {
        /* Value only: the modes stay whatever the console says, and the value
           is live state that never marks the project dirty. */
        QString ignored;
        m_engine->setGrandMaster(int(value), QString(), QString(), -1, ignored);
    }

    const auto found = m_table.constFind(key);
    if (found == m_table.constEnd())
        return;

    for (const VcWidget &widget : found.value())
    {
        if (widget.type == QStringLiteral("slider"))
        {
            /* An absolute control: every value counts, edges do not. No echo
               either -- feeding a control back the value it just sent says
               nothing, and on a looped line it says it forever. */
            WidgetActions::setSliderLevel(m_engine, widget.id, value);
            continue;
        }

        /* A button. Transitions only: a fader sweeping 10..200 across its
           travel is one press, not two hundred. */
        if (rising == false && falling == false)
            continue;
        const int result = WidgetActions::pressButton(m_engine, widget, rising);
        if (result < 0)
            continue;

        /* Feedback reflects the RESULTING state the press itself reports: a
           Toggle that just stopped its function must turn the LED off. Sent
           only when the press actually did something, and never as a bare
           echo of the value that just arrived -- both rules exist because a
           feedback line looped back into the input must not become a
           conversation. */
        const bool on = result == 1;
        const uchar echo = on ? widget.feedbackUpper : widget.feedbackLower;
        if (echo != value)
            sendFeedback(widget, on);
    }
}

void InputRouter::sendFeedback(const VcWidget &widget, bool on) const
{
    m_engine->doc()->inputOutputMap()->sendFeedBack(
        widget.inputUniverse, widget.inputChannel,
        on ? widget.feedbackUpper : widget.feedbackLower, QVariant());
}
