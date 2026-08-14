/*
  OrchidLights
  levelsource.cpp

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

#include <QMutexLocker>
#include <cmath>

#include "levelsource.h"

#include "functionparent.h"
#include "mastertimer.h"
#include "function.h"
#include "genericfader.h"
#include "fadechannel.h"
#include "qlcchannel.h"
#include "universe.h"
#include "fixture.h"
#include "doc.h"

LevelSource::LevelSource(Doc *doc)
    : m_doc(doc)
{
    Q_ASSERT(doc != nullptr);
}

LevelSource::~LevelSource() = default;

void LevelSource::defineSlider(quint32 sliderId, const QList<Channel> &channels)
{
    QMutexLocker locker(&m_mutex);

    m_sliders.insert(sliderId, channels);
    if (m_values.contains(sliderId) == false)
        m_values.insert(sliderId, 0);
}

void LevelSource::definePlayback(quint32 sliderId, quint32 functionId)
{
    QMutexLocker locker(&m_mutex);

    m_playbacks.insert(sliderId, functionId);
    if (m_values.contains(sliderId) == false)
        m_values.insert(sliderId, 0);
}

void LevelSource::definePad(quint32 padId, const QList<PadHead> &heads)
{
    QMutexLocker locker(&m_mutex);

    m_pads.insert(padId, heads);
    if (m_positions.contains(padId) == false)
        m_positions.insert(padId, qMakePair(0.0, 0.0));
}

void LevelSource::setPosition(quint32 padId, double x, double y)
{
    QMutexLocker locker(&m_mutex);

    if (m_pads.contains(padId) == false)
        return;

    m_positions.insert(padId, qMakePair(qBound(0.0, x, 1.0), qBound(0.0, y, 1.0)));
    m_padsDirty.insert(padId, true);
}

QPair<double, double> LevelSource::position(quint32 padId) const
{
    QMutexLocker locker(&m_mutex);
    return m_positions.value(padId, qMakePair(0.0, 0.0));
}

bool LevelSource::knowsPad(quint32 padId) const
{
    QMutexLocker locker(&m_mutex);
    return m_pads.contains(padId);
}

void LevelSource::forgetSliders()
{
    QMutexLocker locker(&m_mutex);

    m_sliders.clear();
    m_values.clear();
    m_dirty.clear();

    /* The overrides belong to functions in a document that is about to be
       replaced. Dropping the ids here means the next slider asks for its own
       rather than adjusting an attribute that now belongs to somebody else. */
    m_playbacks.clear();
    m_overrides.clear();

    m_pads.clear();
    m_positions.clear();
    m_padsDirty.clear();

    /* The faders belong to universes that are about to be rebuilt. Dropping the
       references here lets them go with the old document instead of writing
       into a universe that no longer means what it did. */
    m_faders.clear();
    m_faderUniverses.clear();
}

void LevelSource::setValue(quint32 sliderId, uchar value)
{
    QMutexLocker locker(&m_mutex);

    if (m_sliders.contains(sliderId) == false && m_playbacks.contains(sliderId) == false)
        return;

    m_values.insert(sliderId, value);
    m_dirty.insert(sliderId, true);
}

uchar LevelSource::value(quint32 sliderId) const
{
    QMutexLocker locker(&m_mutex);
    return m_values.value(sliderId, 0);
}

bool LevelSource::knows(quint32 sliderId) const
{
    QMutexLocker locker(&m_mutex);
    return m_sliders.contains(sliderId) || m_playbacks.contains(sliderId);
}

/**
 * Aim the heads an XY pad steers.
 *
 * The arithmetic is QLC+'s, kept identical on purpose: the position is a
 * fraction of the head's allowed slice of travel, scaled into the 16-bit space
 * the fixture's coarse and fine channels share. A fixture with no fine channel
 * gets the top byte only, which is why the range is computed in 16 bits and
 * then shifted rather than being computed in 8.
 *
 * Called with the mutex held, on the timer thread, with the universes claimed.
 */
void LevelSource::writePads(const QList<Universe *> &universes)
{
    if (m_padsDirty.isEmpty())
        return;

    for (auto it = m_padsDirty.constBegin(); it != m_padsDirty.constEnd(); ++it)
    {
        const QPair<double, double> at = m_positions.value(it.key(), qMakePair(0.0, 0.0));

        for (const PadHead &head : m_pads.value(it.key()))
        {
            Fixture *fixture = m_doc->fixture(head.fixtureId);
            if (fixture == nullptr)
                continue;

            const quint32 universeId = fixture->universe();
            if (universeId >= quint32(universes.count()))
                continue;

            Universe *universe = universes.at(int(universeId));

            const quint32 panMsb =
                fixture->channelNumber(QLCChannel::Pan, QLCChannel::MSB, head.head);
            const quint32 tiltMsb =
                fixture->channelNumber(QLCChannel::Tilt, QLCChannel::MSB, head.head);

            /* A head with no pan or tilt is not steerable, and writing its
               other channels would move something nobody asked to move. */
            if (panMsb == QLCChannel::invalid() || tiltMsb == QLCChannel::invalid())
                continue;

            const auto scaled = [](double fraction, double low, double high, bool reverse) {
                const double offset = (reverse ? high : low) * double(USHRT_MAX);
                const double range = (reverse ? low - high : high - low) * double(USHRT_MAX);
                return ushort(std::floor(range * fraction + offset + 0.5));
            };

            const ushort pan = scaled(at.first, head.xMin, head.xMax, head.xReverse);
            const ushort tilt = scaled(at.second, head.yMin, head.yMax, head.yReverse);

            QSharedPointer<GenericFader> fader = faderFor(universeId, universe);

            const auto aim = [&](quint32 channel, uchar value) {
                if (channel == QLCChannel::invalid())
                    return;

                FadeChannel *fc = fader->getChannelFader(m_doc, universe, head.fixtureId, channel);
                if (fc->universe() == Universe::invalid())
                {
                    fader->remove(fc);
                    return;
                }

                /* Pan and tilt are position channels: latest takes precedence,
                   and they have to hold, so no AutoRemove. A pad that let go
                   of its channels would have the lamp drift back the moment
                   anything else touched the universe. */
                fc->setStart(fc->current());
                fc->setTarget(value);
                fc->setReady(false);
                fc->setElapsed(0);
            };

            aim(panMsb, uchar(pan >> 8));
            aim(tiltMsb, uchar(tilt >> 8));
            aim(fixture->channelNumber(QLCChannel::Pan, QLCChannel::LSB, head.head),
                uchar(pan & 0xFF));
            aim(fixture->channelNumber(QLCChannel::Tilt, QLCChannel::LSB, head.head),
                uchar(tilt & 0xFF));
        }
    }

    m_padsDirty.clear();
}

/**
 * Ride the functions the playback sliders drive.
 *
 * At zero the function stops and the override is given back, so the next move
 * asks for a fresh one -- holding it across a stop is how a slider ends up
 * adjusting an attribute of a function that is no longer running.
 */
void LevelSource::writePlaybacks(MasterTimer *timer)
{
    if (m_dirty.isEmpty())
        return;

    for (auto it = m_dirty.constBegin(); it != m_dirty.constEnd(); ++it)
    {
        if (m_playbacks.contains(it.key()) == false)
            continue;

        Function *function = m_doc->function(m_playbacks.value(it.key()));
        if (function == nullptr)
            continue;

        const uchar level = m_values.value(it.key(), 0);

        if (level == 0)
        {
            if (function->stopped() == false)
                function->stop(FunctionParent::master());

            m_overrides.remove(it.key());
            continue;
        }

        if (function->stopped())
            function->start(timer, FunctionParent::master());

        const qreal intensity = qreal(level) / qreal(UCHAR_MAX);

        if (m_overrides.contains(it.key()) == false)
        {
            m_overrides.insert(it.key(),
                               function->requestAttributeOverride(Function::Intensity, intensity));
        }
        else
        {
            function->adjustAttribute(intensity, m_overrides.value(it.key()));
        }
    }
}

QSharedPointer<GenericFader> LevelSource::faderFor(quint32 universeId, Universe *universe)
{
    /* Cached per universe id, and re-requested whenever the universe object
       behind that id is not the one the fader belongs to. Universes are
       recreated when one is added or removed, so a fader held from before
       points at an object nobody writes any more -- and the symptom is a
       control that moves in the interface while its lamp sits still. */
    QSharedPointer<GenericFader> fader = m_faders.value(universeId);
    if (fader.isNull() || m_faderUniverses.value(universeId) != universe)
    {
        fader = universe->requestFader(Universe::Auto);
        m_faders.insert(universeId, fader);
        m_faderUniverses.insert(universeId, universe);
    }

    return fader;
}

void LevelSource::writeDMX(MasterTimer *timer, QList<Universe *> universes)
{
    QMutexLocker locker(&m_mutex);

    writePads(universes);
    writePlaybacks(timer);

    if (m_dirty.isEmpty())
        return;

    for (auto it = m_dirty.constBegin(); it != m_dirty.constEnd(); ++it)
    {
        if (m_sliders.contains(it.key()) == false)
            continue;

        const quint32 sliderId = it.key();
        const uchar level = m_values.value(sliderId, 0);

        for (const Channel &channel : m_sliders.value(sliderId))
        {
            Fixture *fixture = m_doc->fixture(channel.first);
            if (fixture == nullptr)
                continue;

            const quint32 universeId = fixture->universe();
            if (universeId >= quint32(universes.count()))
                continue;

            Universe *universe = universes.at(int(universeId));

            QSharedPointer<GenericFader> fader = faderFor(universeId, universe);

            FadeChannel *fc = fader->getChannelFader(m_doc, universe,
                                                     channel.first, channel.second);
            if (fc->universe() == Universe::invalid())
            {
                fader->remove(fc);
                continue;
            }

            /* Anything that is not an intensity channel is latest-takes-
               precedence, so it must drop out of the fader once written or it
               would fight whatever sets it next. Intensity channels stay, which
               is what makes a fader hold its level. */
            const QLCChannel *qlcChannel = fixture->channel(channel.second);
            if (qlcChannel != nullptr && qlcChannel->group() != QLCChannel::Intensity)
                fc->addFlag(FadeChannel::AutoRemove);

            fc->setStart(fc->current());
            fc->setTarget(level);
            fc->setReady(false);
            fc->setElapsed(0);
        }
    }

    m_dirty.clear();
}
