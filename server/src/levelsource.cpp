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

#include "levelsource.h"

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

void LevelSource::forgetSliders()
{
    QMutexLocker locker(&m_mutex);

    m_sliders.clear();
    m_values.clear();
    m_dirty.clear();

    /* The faders belong to universes that are about to be rebuilt. Dropping the
       references here lets them go with the old document instead of writing
       into a universe that no longer means what it did. */
    m_faders.clear();
    m_faderUniverses.clear();
}

void LevelSource::setValue(quint32 sliderId, uchar value)
{
    QMutexLocker locker(&m_mutex);

    if (m_sliders.contains(sliderId) == false)
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
    return m_sliders.contains(sliderId);
}

void LevelSource::writeDMX(MasterTimer *timer, QList<Universe *> universes)
{
    Q_UNUSED(timer)

    QMutexLocker locker(&m_mutex);

    if (m_dirty.isEmpty())
        return;

    for (auto it = m_dirty.constBegin(); it != m_dirty.constEnd(); ++it)
    {
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

            /* Cached per universe id, and re-requested whenever the universe
               object behind that id is not the one the fader belongs to.
               Universes are recreated when one is added or removed, so a fader
               held from before points at an object nobody writes any more --
               and the symptom is a slider that moves in the interface while its
               lamp sits still. */
            QSharedPointer<GenericFader> fader = m_faders.value(universeId);
            if (fader.isNull() || m_faderUniverses.value(universeId) != universe)
            {
                fader = universe->requestFader(Universe::Auto);
                m_faders.insert(universeId, fader);
                m_faderUniverses.insert(universeId, universe);
            }

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
