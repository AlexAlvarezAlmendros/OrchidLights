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
class Universe;
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

    /**
     * Tell the source that a slider rides a function's intensity.
     *
     * A playback slider does not write channels. At zero it stops the function;
     * above zero it starts it and holds its intensity at the slider's fraction
     * -- which is why it has to run here, on the timer thread, rather than from
     * an HTTP handler: starting a function and overriding an attribute are both
     * things the engine expects on its own clock.
     */
    void definePlayback(quint32 sliderId, quint32 functionId);

    /**
     * Forget what the console said, keeping where the operator left it.
     *
     * Called after every edit to the Virtual Console, which is why the values
     * survive: a rename should not black out a fader that is holding a look.
     */
    void forgetSliders();

    /** Forget everything, values included. For a different project, where the
     *  ids mean something else entirely. */
    void forgetEverything();

    /** Park a new value for a slider. Applied on the next engine tick. */
    void setValue(quint32 sliderId, uchar value);

    /** Last value set for a slider, for clients joining late. */
    uchar value(quint32 sliderId) const;

    bool knows(quint32 sliderId) const;

    /**
     * One head an XY pad steers, with the slice of travel it may use.
     *
     * Limits are fractions of the head's full range. The reverse flags are the
     * project's, not a rendering choice: a lamp rigged upside down is aimed by
     * inverting an axis, and ignoring that points it at the ceiling.
     */
    struct PadHead
    {
        quint32 fixtureId = 0;
        int head = 0;
        double xMin = 0.0, xMax = 1.0;
        double yMin = 0.0, yMax = 1.0;
        bool xReverse = false;
        bool yReverse = false;
    };

    /** Tell the source which heads a pad steers. */
    void definePad(quint32 padId, const QList<PadHead> &heads);

    /** Park a new position for a pad, 0..1 on each axis. */
    void setPosition(quint32 padId, double x, double y);

    /** Last position set for a pad, for clients joining late. */
    QPair<double, double> position(quint32 padId) const;

    bool knowsPad(quint32 padId) const;

    void writeDMX(MasterTimer *timer, QList<Universe *> universes) override;

private:
    /** Get or make the fader for a universe, replacing one held from before
     *  the universes were rebuilt. Call with the mutex held. */
    QSharedPointer<GenericFader> faderFor(quint32 universeId, Universe *universe);

    /** Aim the heads every dirty pad steers. Call with the mutex held. */
    void writePads(const QList<Universe *> &universes);

    /** Ride the functions the dirty playback sliders drive. Call with the
     *  mutex held. */
    void writePlaybacks(MasterTimer *timer);

    Doc *m_doc = nullptr;

    mutable QMutex m_mutex;
    QHash<quint32, QList<Channel>> m_sliders;
    QHash<quint32, uchar> m_values;
    QHash<quint32, bool> m_dirty;

    /** Sliders that ride a function instead of writing channels, and the
     *  attribute override each one holds on it. */
    QHash<quint32, quint32> m_playbacks;
    QHash<quint32, int> m_overrides;

    QHash<quint32, QList<PadHead>> m_pads;
    QHash<quint32, QPair<double, double>> m_positions;
    QHash<quint32, bool> m_padsDirty;

    /** One fader per universe, kept alive so values hold between ticks rather
     *  than being re-requested and losing their place. */
    QHash<quint32, QSharedPointer<GenericFader>> m_faders;

    /** Which Universe object each cached fader belongs to. Universe ids are
     *  reused when one is added or removed, so the id alone does not say
     *  whether a cached fader is still connected to anything. */
    QHash<quint32, Universe *> m_faderUniverses;

    /**
     * Faders let go of but not yet handed back.
     *
     * A Universe keeps its own reference to every fader it hands out, so
     * dropping ours does not unregister it: it keeps asserting its channels
     * for the life of the document. Dismissing is the universe's business and
     * belongs on the timer thread, so the pairs are parked here and returned
     * in writeDMX.
     */
    QVector<QPair<Universe *, QSharedPointer<GenericFader>>> m_dismissed;
};

#endif // LEVELSOURCE_H
