/*
  OrchidLights
  simpledesksource.h

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

#ifndef SIMPLEDESKSOURCE_H
#define SIMPLEDESKSOURCE_H

#include <QHash>
#include <QMutex>
#include <QSet>
#include <QVector>
#include <QSharedPointer>

#include "dmxsource.h"

class Doc;
class GenericFader;
class Universe;

/**
 * The Simple Desk: raw channels of a universe, held by hand.
 *
 * Not the live desk in LevelSource. That one addresses (fixture, channel) and
 * exists for the plan; this one addresses (universe, absolute address) and
 * exists for the desk QLC+ 5 has: any of the 512 channels, WHETHER OR NOT a
 * fixture is patched there -- the house light on channel 500 nobody bothered
 * to patch is exactly what a Simple Desk is for.
 *
 * Semantics match qmlui/simpledesk.cpp, which is the reference:
 *
 *  - a held channel carries FadeChannel::Override, so the desk BEATS running
 *    functions on that channel -- grabbing a channel by hand mid-chase means
 *    "mine now", or the desk would be a suggestion;
 *  - resetting a channel lets the function underneath show through again, and
 *    restores the channel's own default when nothing drives it;
 *  - resetting a universe drops the whole fader and every default at once.
 *
 * Same threading rules as every DMXSource here: setters park values under the
 * mutex from the HTTP thread; writeDMX() applies them on the engine's tick.
 */
class SimpleDeskSource final : public DMXSource
{
public:
    explicit SimpleDeskSource(Doc *doc);
    ~SimpleDeskSource() override;

    /** Hold one channel (0-based absolute address) of a universe at a value. */
    void setChannel(quint32 universe, quint32 channel, uchar value);

    /** Let one channel go: the desk stops asserting it. */
    void resetChannel(quint32 universe, quint32 channel);

    /** Let a whole universe go. */
    void resetUniverse(quint32 universe);

    /** What the desk is holding on a universe: address -> value. */
    QHash<quint32, uchar> held(quint32 universe) const;

    /** Everything, for the dump: (universe << 9 | address) -> value. */
    QHash<quint32, uchar> heldEverywhere() const;

    /** A different project entirely: nothing held survives it. */
    void forgetEverything();

    /** DMXSource: runs on the master timer's tick. */
    void writeDMX(MasterTimer *timer, QList<Universe *> universes) override;

private:
    /** Call with the mutex held. */
    QSharedPointer<GenericFader> faderFor(quint32 universeId, Universe *universe);

    Doc *m_doc;
    mutable QMutex m_mutex;

    /** (universe << 9 | address) -> value. The parked truth. */
    QHash<quint32, uchar> m_values;
    /** Addresses touched since the last tick. */
    QSet<quint32> m_dirty;
    /** Channel resets waiting for the tick. */
    QVector<quint32> m_resetChannels;
    /** Universe resets waiting for the tick. */
    QVector<quint32> m_resetUniverses;

    QHash<quint32, QSharedPointer<GenericFader>> m_faders;
};

#endif // SIMPLEDESKSOURCE_H
