/*
  OrchidLights
  clockscheduler.h

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

#ifndef CLOCKSCHEDULER_H
#define CLOCKSCHEDULER_H

#include <QObject>
#include <QTimer>
#include <QVector>

#include "virtualconsole.h"

class EngineHost;

/**
 * The clock widgets' weekly agenda, running in the daemon.
 *
 * A schedule that only fires while a browser happens to be open is an alarm
 * clock that only rings when somebody is already awake. This ticks once a
 * second against the schedules preserved in the console XML and starts and
 * stops functions through the same WidgetActions everything else uses --
 * semantics ported from qmlui/virtualconsole/vcclock.cpp: day mask (bit 0 =
 * Monday, 0 = every day), stop time, and the repeat bit (0x80) that re-arms
 * a schedule instead of firing it once per day.
 */
class ClockScheduler final : public QObject
{
    Q_OBJECT

public:
    explicit ClockScheduler(EngineHost *engine, QObject *parent = nullptr);

    /** How many schedules are armed, for whoever needs to ask. */
    int scheduleCount() const { return m_schedules.count(); }

public slots:
    void rebuild();

private slots:
    void tick();

private:
    struct Armed
    {
        VcWidget::ClockSchedule schedule;
        bool canPlay = true;
    };

    EngineHost *m_engine;
    QTimer m_timer;
    QVector<Armed> m_schedules;
    int m_lastTickSecs = -1;
};

#endif
