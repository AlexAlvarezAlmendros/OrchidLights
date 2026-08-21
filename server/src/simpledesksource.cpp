/*
  OrchidLights
  simpledesksource.cpp

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

#include "simpledesksource.h"

#include "doc.h"
#include "fadechannel.h"
#include "fixture.h"
#include "genericfader.h"
#include "qlcchannel.h"
#include "universe.h"

namespace
{
    inline quint32 keyOf(quint32 universe, quint32 channel)
    {
        return (universe << 9) | (channel & 0x01FF);
    }
}

SimpleDeskSource::SimpleDeskSource(Doc *doc)
    : m_doc(doc)
{
}

SimpleDeskSource::~SimpleDeskSource() = default;

void SimpleDeskSource::setChannel(quint32 universe, quint32 channel, uchar value)
{
    QMutexLocker locker(&m_mutex);
    const quint32 key = keyOf(universe, channel);
    m_values[key] = value;
    m_dirty.insert(key);
}

void SimpleDeskSource::resetChannel(quint32 universe, quint32 channel)
{
    QMutexLocker locker(&m_mutex);
    const quint32 key = keyOf(universe, channel);
    m_values.remove(key);
    m_dirty.remove(key);
    m_resetChannels.append(key);
}

void SimpleDeskSource::resetUniverse(quint32 universe)
{
    QMutexLocker locker(&m_mutex);
    for (auto it = m_values.begin(); it != m_values.end();)
    {
        if ((it.key() >> 9) == universe)
            it = m_values.erase(it);
        else
            ++it;
    }
    m_resetUniverses.append(universe);
}

QHash<quint32, uchar> SimpleDeskSource::held(quint32 universe) const
{
    QMutexLocker locker(&m_mutex);
    QHash<quint32, uchar> out;
    for (auto it = m_values.constBegin(); it != m_values.constEnd(); ++it)
    {
        if ((it.key() >> 9) == universe)
            out.insert(it.key() & 0x01FF, it.value());
    }
    return out;
}

QHash<quint32, uchar> SimpleDeskSource::heldEverywhere() const
{
    QMutexLocker locker(&m_mutex);
    return m_values;
}

void SimpleDeskSource::forgetEverything()
{
    QMutexLocker locker(&m_mutex);
    m_values.clear();
    m_dirty.clear();
    m_resetChannels.clear();
    /* The faders are dismissed on the next tick either way; asking for every
       universe is how a full clear says it. */
    for (auto it = m_faders.constBegin(); it != m_faders.constEnd(); ++it)
        m_resetUniverses.append(it.key());
}

QSharedPointer<GenericFader> SimpleDeskSource::faderFor(quint32 universeId, Universe *universe)
{
    QSharedPointer<GenericFader> fader = m_faders.value(universeId);
    if (fader.isNull())
    {
        /* The engine has a priority tier named for exactly this desk, above
           Auto, Override and even a flash: requested at anything lower, a
           held channel loses to whichever scene is running -- the desk would
           be a suggestion. */
        fader = universe->requestFader(Universe::SimpleDesk);
        m_faders.insert(universeId, fader);
    }
    return fader;
}

void SimpleDeskSource::writeDMX(MasterTimer *timer, QList<Universe *> universes)
{
    Q_UNUSED(timer)

    QMutexLocker locker(&m_mutex);

    /* Resets first, so "reset then set" within one tick ends held. */
    for (quint32 universeId : m_resetUniverses)
    {
        if (universeId >= quint32(universes.count()))
            continue;
        Universe *universe = universes.at(int(universeId));

        QSharedPointer<GenericFader> fader = m_faders.take(universeId);
        if (fader.isNull())
            continue;

        /* Every channel the fader held goes back to its own default -- the
           fixture's, or zero where nothing is patched. The reference
           (qmlui/simpledesk.cpp) does exactly this walk. */
        const QHash<quint32, FadeChannel> channels = fader->channels();
        for (auto it = channels.constBegin(); it != channels.constEnd(); ++it)
        {
            const quint32 address = it.value().channel() & 0x01FF;
            Fixture *fixture = m_doc->fixture(it.value().fixture());
            const QLCChannel *qlcChannel =
                fixture != nullptr ? fixture->channel(address - fixture->address()) : nullptr;
            if (qlcChannel != nullptr)
                universe->setChannelDefaultValue(address, qlcChannel->defaultValue());
            else
                universe->reset(int(address), 1);
        }

        universe->dismissFader(fader);
    }
    m_resetUniverses.clear();

    for (quint32 key : m_resetChannels)
    {
        const quint32 universeId = key >> 9;
        const quint32 address = key & 0x01FF;
        if (universeId >= quint32(universes.count()))
            continue;
        Universe *universe = universes.at(int(universeId));

        QSharedPointer<GenericFader> fader = m_faders.value(universeId);
        if (fader.isNull())
            continue;

        const quint32 fixtureId = m_doc->fixtureForAddress((universeId << 9) | address);
        quint32 channel = address;
        if (fixtureId != Fixture::invalidId())
        {
            Fixture *fixture = m_doc->fixture(fixtureId);
            if (fixture != nullptr)
                channel = address - fixture->address();
        }

        FadeChannel searched(m_doc, fixtureId, channel);
        fader->remove(&searched);

        Fixture *fixture = m_doc->fixture(fixtureId);
        const QLCChannel *qlcChannel = fixture != nullptr ? fixture->channel(channel) : nullptr;
        if (qlcChannel != nullptr)
            universe->setChannelDefaultValue(address, qlcChannel->defaultValue());
        else
            universe->reset(int(address), 1);
    }
    m_resetChannels.clear();

    if (m_dirty.isEmpty())
        return;

    for (quint32 key : m_dirty)
    {
        const quint32 universeId = key >> 9;
        const quint32 address = key & 0x01FF;
        if (universeId >= quint32(universes.count()))
            continue;
        Universe *universe = universes.at(int(universeId));

        /* The fader wants (fixture, relative channel) where a fixture sits at
           this address, and (invalid, absolute) where none does -- that pair
           is what lets an unpatched channel be held at all. */
        const quint32 fixtureId = m_doc->fixtureForAddress((universeId << 9) | address);
        quint32 channel = address;
        if (fixtureId != Fixture::invalidId())
        {
            Fixture *fixture = m_doc->fixture(fixtureId);
            if (fixture != nullptr)
                channel = address - fixture->address();
        }

        QSharedPointer<GenericFader> fader = faderFor(universeId, universe);
        FadeChannel *fc = fader->getChannelFader(m_doc, universe, fixtureId, channel);

        /* Override is the desk's whole meaning: grabbing a channel by hand
           mid-chase is "mine now", not a suggestion the chase may outvote. */
        fc->setCurrent(m_values.value(key));
        fc->setTarget(m_values.value(key));
        fc->addFlag(FadeChannel::Override);
    }
    m_dirty.clear();
}
