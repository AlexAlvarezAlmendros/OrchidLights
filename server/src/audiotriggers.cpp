/*
  OrchidLights
  audiotriggers.cpp

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

#include <QMediaDevices>
#include <QAudioDevice>
#include <QSettings>
#include <QtGlobal>

#include "audiotriggers.h"
#include "levelsource.h"

#include "audiocapture.h"
#include "functionparent.h"
#include "mastertimer.h"
#include "function.h"
#include "doc.h"

AudioTriggers::AudioTriggers(Doc *doc, LevelSource *levels, QObject *parent)
    : QObject(parent)
    , m_doc(doc)
    , m_levels(levels)
{
    Q_ASSERT(doc != nullptr);
    Q_ASSERT(levels != nullptr);
}

AudioTriggers::~AudioTriggers()
{
    closeCapture();
}

quint32 AudioTriggers::barSliderId(quint32 widgetId, int barIndex)
{
    /* The top of the id space, which a console cannot reach: QLC+ hands out
       widget ids from zero and treats UINT_MAX as invalid. 0xFF000000 leaves
       room for 65536 widgets and 256 bars each, which is more of both than a
       console has ever had. */
    return 0xFF000000u | ((widgetId & 0xFFFFu) << 8) | quint32(barIndex & 0xFF);
}

void AudioTriggers::learn(const VcWidget &root)
{
    const QHash<quint32, Widget> previous = m_widgets;
    m_widgets.clear();

    int bands = 0;

    QVector<const VcWidget *> pending;
    pending.append(&root);

    while (pending.isEmpty() == false)
    {
        const VcWidget *widget = pending.takeLast();

        if (widget->type == QStringLiteral("audiotriggers") && widget->hasId
            && widget->audioBars.isEmpty() == false)
        {
            Widget entry;
            entry.bands = widget->audioBands;

            for (const VcWidget::AudioBar &bar : widget->audioBars)
            {
                if (bar.type != 0)
                    entry.bars.append(bar);
            }

            if (entry.bars.isEmpty() == false)
            {
                /* Whether it was running survives an edit to the console. A
                   rename should not silently switch the triggers off in the
                   middle of a set. */
                entry.enabled = previous.value(widget->id).enabled;

                m_widgets.insert(widget->id, entry);
                bands = qMax(bands, entry.bands);
            }
        }

        for (const VcWidget &child : widget->children)
            pending.append(&child);
    }

    /* A bar that holds DMX channels is a fader like any other, so it is
       registered as one: that gives it a fader of its own, and the submasters
       enclosing its widget scale it without this class knowing they exist. */
    for (auto it = m_widgets.constBegin(); it != m_widgets.constEnd(); ++it)
    {
        for (int i = 0; i < it.value().bars.count(); i++)
        {
            const VcWidget::AudioBar &bar = it.value().bars.at(i);
            if (bar.type != 1 || bar.dmxChannels.isEmpty())
                continue;

            QList<LevelSource::Channel> channels;
            for (const auto &channel : bar.dmxChannels)
                channels.append(channel);

            m_levels->defineSlider(barSliderId(it.key(), i), channels);
        }
    }

    if (m_widgets.isEmpty())
    {
        closeCapture();
        return;
    }

    if (m_capturing && bands != m_registeredBands)
        closeCapture();

    if (m_capturing == false)
    {
        /* Only once something is actually switched on. Opening a microphone is
           not a neutral act: it is a device the operator may be using for
           something else. */
        for (auto it = m_widgets.constBegin(); it != m_widgets.constEnd(); ++it)
        {
            if (it.value().enabled)
            {
                openCapture(bands);
                break;
            }
        }
    }
}

bool AudioTriggers::setEnabled(quint32 widgetId, bool enabled)
{
    auto it = m_widgets.find(widgetId);
    if (it == m_widgets.end())
        return false;

    it->enabled = enabled;

    if (enabled)
    {
        if (m_capturing == false)
            openCapture(it->bands);
        return true;
    }

    /* The last one off closes the microphone again. */
    for (auto other = m_widgets.constBegin(); other != m_widgets.constEnd(); ++other)
    {
        if (other.value().enabled)
            return true;
    }

    closeCapture();
    return true;
}

bool AudioTriggers::isEnabled(quint32 widgetId) const
{
    return m_widgets.value(widgetId).enabled;
}

QStringList AudioTriggers::availableInputs()
{
    QStringList names;
    for (const QAudioDevice &device : QMediaDevices::audioInputs())
        names << device.description();

    return names;
}

QString AudioTriggers::selectedInput()
{
    /* The engine's own key: AudioCaptureQt6 reads it at open time and matches
       by description (audiocapture_qt6.cpp:47-58). Writing it here is what
       makes the choice reachable without touching the engine. */
    const QSettings settings;
    const QVariant stored = settings.value(QStringLiteral(SETTINGS_AUDIO_INPUT_DEVICE));

    if (stored.isValid() && stored.toString().isEmpty() == false)
        return stored.toString();

    return QMediaDevices::defaultAudioInput().description();
}

bool AudioTriggers::selectInput(const QString &name)
{
    if (availableInputs().contains(name) == false)
        return false;

    QSettings settings;
    settings.setValue(QStringLiteral(SETTINGS_AUDIO_INPUT_DEVICE), name);
    settings.sync();

    /* Reopened rather than switched: the capture reads the setting when it
       opens the device, so a running one would carry on with the old one. */
    if (m_capturing)
    {
        const int bands = m_registeredBands;
        closeCapture();
        openCapture(bands);
    }

    return true;
}

void AudioTriggers::openCapture(int bands)
{
    if (bands <= 0)
        bands = 16;

    m_capture = m_doc->audioInputCapture();
    if (m_capture.isNull())
    {
        m_reason = QStringLiteral("This machine has no audio capture");
        return;
    }

    connect(m_capture.data(), &AudioCapture::dataProcessed, this, &AudioTriggers::onData);

    /* Registering is what opens the microphone: the capture starts its thread
       on the first band registered and stops on the last unregistered, so the
       device is held exactly as long as something is listening. initialize()
       and stop() are the engine's own business and not ours to call. */
    m_capture->registerBandsNumber(bands);
    m_registeredBands = bands;

    m_capturing = true;
    m_reason.clear();
}

void AudioTriggers::closeCapture()
{
    if (m_capture.isNull() == false)
    {
        disconnect(m_capture.data(), &AudioCapture::dataProcessed, this, &AudioTriggers::onData);

        if (m_registeredBands > 0)
            m_capture->unregisterBandsNumber(m_registeredBands);

        m_capture.clear();
        m_doc->destroyAudioCapture();
    }

    m_capturing = false;
    m_registeredBands = 0;
    m_spectrum.clear();
    m_volume = 0;
}

void AudioTriggers::onData(double *bands, int size, double maxMagnitude, quint32 power)
{
    if (bands == nullptr || size <= 0)
        return;

    /* QLC+'s own arithmetic, and not an obvious one.
     *
     * The volume is the signal power out of 0x7FFF, and a band is that volume
     * shared out by the band's magnitude -- so a band is loud only when the
     * signal is loud AND that band carries it. Normalising each band against
     * the loudest instead, which is the tempting reading, gives the top band
     * 255 in a silent room and turns every trigger into a coin flip.
     *
     * A magnitude of zero is silence, not a division to attempt. */
    const double volume = double(power) * 255.0 / double(0x7FFF);
    m_volume = uchar(qBound(0.0, volume, 255.0));

    m_spectrum.resize(size);
    for (int i = 0; i < size; i++)
    {
        const double band = maxMagnitude > 0.0 ? volume * bands[i] / maxMagnitude : 0.0;
        m_spectrum[i] = uchar(qBound(0.0, band, 255.0));
    }

    for (auto it = m_widgets.begin(); it != m_widgets.end(); ++it)
    {
        if (it->enabled == false)
            continue;

        for (int i = 0; i < it->bars.count(); i++)
        {
            const VcWidget::AudioBar &bar = it->bars.at(i);

            /* A volume bar follows the signal as a whole; a spectrum bar
               follows its own band. A band index past the end is a widget built
               for a different number of bars, which is worth ignoring rather
               than guessing at. */
            uchar value = 0;
            if (bar.isVolume)
                value = m_volume;
            else if (bar.index >= 0 && bar.index < size)
                value = m_spectrum.at(bar.index);
            else
                continue;

            switch (bar.type)
            {
            case 1:
                m_levels->setValue(barSliderId(it.key(), i), value);
                break;

            case 2:
            {
                /* Two thresholds, not one: a single crossing point makes a
                   function stutter on and off around it, which on a lamp is a
                   strobe nobody asked for. */
                Function *function = m_doc->function(bar.functionId);
                if (function == nullptr)
                    break;

                if (value >= bar.maxThreshold && function->stopped())
                    function->start(m_doc->masterTimer(), FunctionParent::master());
                else if (value < bar.minThreshold && function->stopped() == false)
                    function->stop(FunctionParent::master());
                break;
            }

            case 3:
                /* Driving another widget: only a fader is something to drive,
                   and LevelSource refuses an id it does not know, so a bar
                   pointed at a label simply does nothing rather than
                   misbehaving. */
                m_levels->setValue(bar.targetWidgetId, value);
                break;

            default:
                break;
            }
        }
    }

    emit spectrumChanged();
}
