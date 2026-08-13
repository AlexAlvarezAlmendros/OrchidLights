/*
  OrchidLights
  levelsource.h

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

#ifndef LEVELSOURCE_H
#define LEVELSOURCE_H

#include <QSharedPointer>
#include <QMutex>
#include <QHash>
#include <QPair>
#include <QList>

#include "dmxsource.h"

class GenericFader;
class Doc;

/**
 * Writes the values of the Virtual Console's level sliders to the universes.
 *
 * Registered with the MasterTimer as a DMXSource, which is the only sanctioned
 * way to put values on a universe from outside a Function: writeDMX() runs on
 * the timer thread with the universes already claimed. Setting a value from an
 * HTTP or WebSocket handler therefore does not touch a universe at all -- it
 * parks the value under a mutex and the next tick, at most 20 ms later, applies
 * it.
 *
 * The channels a slider owns come from the project, so this holds no opinion
 * about what a slider means; it only moves the numbers the show already
 * described.
 */
class LevelSource : public DMXSource
{
public:
    /** A fixture and one of its channels. */
    using Channel = QPair<quint32, quint32>;

    explicit LevelSource(Doc *doc);
    ~LevelSource() override;

    /** Tell the source which channels a slider owns. Replaces any previous
     *  definition for that slider, and forgets everything when the project
     *  changes. */
    void defineSlider(quint32 sliderId, const QList<Channel> &channels);
    void forgetSliders();

    /** Park a new value for a slider. Applied on the next engine tick. */
    void setValue(quint32 sliderId, uchar value);

    /** Last value set for a slider, for clients joining late. */
    uchar value(quint32 sliderId) const;

    bool knows(quint32 sliderId) const;

    void writeDMX(MasterTimer *timer, QList<Universe *> universes) override;

private:
    Doc *m_doc = nullptr;

    mutable QMutex m_mutex;
    QHash<quint32, QList<Channel>> m_sliders;
    QHash<quint32, uchar> m_values;
    QHash<quint32, bool> m_dirty;

    /** One fader per universe, kept alive so values hold between ticks rather
     *  than being re-requested and losing their place. */
    QHash<quint32, QSharedPointer<GenericFader>> m_faders;
};

#endif // LEVELSOURCE_H
