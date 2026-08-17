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
class Function;
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
    /**
     * The submasters enclosing a widget, outermost first.
     *
     * A submaster scales the widgets in its frame and everything below it, so
     * what any one widget ends up at is the product of the whole chain above
     * it. Resolved by EngineHost, which owns the tree; this class never learns
     * what a frame is.
     */
    using Scope = QList<quint32>;

    void defineSlider(quint32 sliderId, const QList<Channel> &channels,
                      const Scope &submasters = Scope());

    /**
     * Tell the source that a slider rides a function's intensity.
     *
     * A playback slider does not write channels. At zero it stops the function;
     * above zero it starts it and holds its intensity at the slider's fraction
     * -- which is why it has to run here, on the timer thread, rather than from
     * an HTTP handler: starting a function and overriding an attribute are both
     * things the engine expects on its own clock.
     */
    void definePlayback(quint32 sliderId, quint32 functionId,
                        const Scope &submasters = Scope());

    /**
     * A slider that scales the widgets around it instead of writing anything.
     *
     * It is not a DMX source at all -- QLC+ actively unregisters one from the
     * timer when it enters this mode. Its whole effect is on other widgets.
     *
     * low and high are the Level limits, which submaster mode shares with level
     * mode, and initial is the position the show was saved at.
     */
    void defineSubmaster(quint32 sliderId, int low, int high, uchar initial);

    /**
     * A channels group, held at a level exactly as a level slider is.
     *
     * Groups belong to the document rather than to the console: they exist
     * whether or not any widget mentions them, and QLC+ drives them from the
     * Simple Desk. So they carry no submaster scope -- there is no frame above
     * a thing that is not in the console at all.
     *
     * Registered through a separate id because group ids come from Doc and
     * widget ids come from the console, and both start at 0: without this, a
     * group with id 3 would drive widget 3's channels.
     */
    void defineChannelGroup(quint32 groupId, const QList<Channel> &channels);

    /** The slider id a channels group is held under. */
    static quint32 channelGroupSlider(quint32 groupId) { return 0xFE000000u | (groupId & 0xFFFFFFu); }

    /** A button, so a function it starts can be scaled by the submasters above
     *  it in the same way a fader is. */
    void defineButton(quint32 widgetId, quint32 functionId, const Scope &submasters);

    /** A cue list, for the same reason. */
    void defineCueList(quint32 widgetId, quint32 chaserId, const Scope &submasters);

    /**
     * The product of every submaster enclosing this widget, 1.0 when there are
     * none. Public because the API has to be able to tell a client why a fader
     * at full is dark.
     */
    qreal submasterFactor(quint32 widgetId) const;

    /** True when this widget's output is something a submaster actually
     *  scales -- which is not every widget. See writePads. */
    bool isScalable(quint32 widgetId) const;

    /** How many widgets this submaster actually scales, and whether that is
     *  more than none. A submaster enclosing only labels and XY pads scales
     *  nothing, and has to say so. */
    int scaledCount(quint32 submasterId) const;
    bool scales(quint32 submasterId) const { return scaledCount(submasterId) > 0; }

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

    /** Park a new value for a slider or a submaster. Applied on the next
     *  engine tick. */
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
    QSharedPointer<GenericFader> faderFor(quint32 ownerId, quint32 universeId,
                                          Universe *universe);

    /** Call with the mutex held. */
    qreal factorFor(quint32 widgetId) const;

    /** Hold a function's intensity at a value, through an override slot this
     *  widget keeps. Call with the mutex held. */
    void ride(quint32 widgetId, Function *function, qreal intensity);

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

    /** Widgets that start a function rather than holding one: buttons and cue
     *  lists. A submaster scales what they start, so their functions are
     *  ridden with an override too -- but never started or stopped from here. */
    QHash<quint32, quint32> m_functionWidgets;

    /** Submaster limits. The position lives in m_values with everything else,
     *  so read-back and the WebSocket echo need no special case. */
    struct Submaster
    {
        int low = 0;
        int high = 255;
    };
    QHash<quint32, Submaster> m_submasters;

    /** Which submasters enclose each widget. */
    QHash<quint32, Scope> m_scopes;
    bool m_submastersDirty = false;

    QHash<quint32, QList<PadHead>> m_pads;
    QHash<quint32, QPair<double, double>> m_positions;
    QHash<quint32, bool> m_padsDirty;

    /**
     * One fader per widget per universe.
     *
     * Per widget, not per universe, because a submaster scales through
     * GenericFader::adjustIntensity -- which applies only to channels flagged
     * Intensity, exactly as QLC+ does. A shared fader could not carry two
     * sliders' different factors, and multiplying into the target instead
     * would scale gobo and colour-wheel channels that a submaster must never
     * touch.
     */
    using FaderKey = QPair<quint32, quint32>;
    QHash<FaderKey, QSharedPointer<GenericFader>> m_faders;

    /** Which Universe object each cached fader belongs to. Universe ids are
     *  reused when one is added or removed, so the id alone does not say
     *  whether a cached fader is still connected to anything. */
    QHash<FaderKey, Universe *> m_faderUniverses;

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
