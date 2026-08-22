/*
  OrchidLights
  clockscheduler.cpp

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

#include "clockscheduler.h"

#include <QDateTime>

#include "enginehost.h"
#include "widgetactions.h"

ClockScheduler::ClockScheduler(EngineHost *engine, QObject *parent)
    : QObject(parent)
    , m_engine(engine)
{
    connect(engine, &EngineHost::consoleChanged, this, &ClockScheduler::rebuild);
    connect(engine, &EngineHost::projectReplaced, this, &ClockScheduler::rebuild);
    connect(&m_timer, &QTimer::timeout, this, &ClockScheduler::tick);
    m_timer.start(1000);
    rebuild();
}

void ClockScheduler::rebuild()
{
    m_schedules.clear();

    VcWidget root;
    if (VirtualConsole::parse(m_engine->preservedSections(), root) == false)
        return;

    QList<const VcWidget *> stack{&root};
    while (stack.isEmpty() == false)
    {
        const VcWidget *widget = stack.takeLast();
        for (const VcWidget &child : widget->children)
            stack.append(&child);

        if (widget->type != QStringLiteral("clock"))
            continue;
        for (const VcWidget::ClockSchedule &schedule : widget->schedules)
        {
            if (schedule.functionId == UINT_MAX)
                continue;
            m_schedules.append({schedule, true});
        }
    }
}

void ClockScheduler::tick()
{
    if (m_schedules.isEmpty())
        return;

    const QDateTime now = QDateTime::currentDateTime();
    const int currDay = 1 << (now.date().dayOfWeek() - 1);
    const int daySecs = now.time().msecsSinceStartOfDay() / 1000;

    /* The timer may slip past a second under load; everything between the
       last tick and now counts as "now", so a schedule cannot fall into the
       crack between two ticks. */
    const int since = (m_lastTickSecs >= 0 && m_lastTickSecs < daySecs)
        ? m_lastTickSecs + 1
        : daySecs;
    m_lastTickSecs = daySecs;

    const auto within = [since, daySecs](int moment) {
        return moment >= since && moment <= daySecs;
    };

    for (Armed &armed : m_schedules)
    {
        const VcWidget::ClockSchedule &schedule = armed.schedule;

        /* The stop hand: exact, day mask ignored like the reference. */
        if (schedule.stopTime >= 0 && within(schedule.stopTime))
        {
            WidgetActions::stopFunction(m_engine, schedule.functionId);
            continue;
        }

        /* Before the start is where a spent schedule re-arms for the next
           day (or the next lap, with the repeat bit). */
        if (daySecs < schedule.startTime)
        {
            armed.canPlay = true;
            continue;
        }

        if ((schedule.weekFlags & 0x7F) != 0 && (schedule.weekFlags & currDay) == 0)
            continue;

        if (within(schedule.startTime) && armed.canPlay)
        {
            WidgetActions::startFunction(m_engine, schedule.functionId);
            if ((schedule.weekFlags & 0x80) == 0)
                armed.canPlay = false;
        }
    }
}
