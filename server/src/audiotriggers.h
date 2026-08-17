/*
  OrchidLights
  audiotriggers.h

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

#ifndef AUDIOTRIGGERS_H
#define AUDIOTRIGGERS_H

#include <QSharedPointer>
#include <QObject>
#include <QVector>
#include <QHash>

#include "virtualconsole.h"

class AudioCapture;
class LevelSource;
class Doc;

/**
 * Drives the console from what the microphone hears.
 *
 * An audio triggers widget splits the incoming signal into frequency bands and
 * gives each band a bar. A bar holds DMX channels at its level, or starts a
 * function when it rises past a threshold and stops it when it falls below
 * another, or drives another widget.
 *
 * Two things are deliberately not done here.
 *
 * Nothing writes DMX directly: a bar that holds channels is registered with
 * LevelSource like any other fader, so it goes out on the timer thread, gets a
 * fader of its own, and is scaled by whatever submasters enclose the widget --
 * all of which it would otherwise have to reimplement.
 *
 * And the capture is not started until a widget asks for it. Opening a
 * microphone is not a neutral act: it is a device the operator may be using for
 * something else, and a daemon that grabs it on every project load would be
 * taking it from them.
 */
class AudioTriggers : public QObject
{
    Q_OBJECT

public:
    AudioTriggers(Doc *doc, LevelSource *levels, QObject *parent = nullptr);
    ~AudioTriggers() override;

    /**
     * Read the audio triggers widgets out of the console.
     *
     * Called after every edit, like the rest of the engine's view of the
     * console. Widgets that disappeared stop being driven; the capture stops
     * when the last one goes.
     */
    void learn(const VcWidget &root);

    /** Turn a widget's triggers on or off. False when there is no such widget. */
    bool setEnabled(quint32 widgetId, bool enabled);
    bool isEnabled(quint32 widgetId) const;

    /** Whether the capture came up at all. False on a machine with no input,
     *  which is most servers -- and a reason the interface should show. */
    bool isCapturing() const { return m_capturing; }
    QString unavailableReason() const { return m_reason; }

    /**
     * The audio inputs this machine offers, and the one the capture will use.
     *
     * Worth exposing, because the wrong one is silent rather than broken: on
     * this laptop the system default is a headphones jack with nothing plugged
     * into it, and a widget listening to that looks exactly like a widget that
     * does not work. An operator can only tell the two apart by being shown
     * the list.
     */
    static QStringList availableInputs();
    static QString selectedInput();

    /** Choose the input. Takes effect the next time the capture opens, so a
     *  running one is closed. Returns false when there is no such input. */
    bool selectInput(const QString &name);

    /** The ids of the widgets currently driven, for the API to report. */
    QList<quint32> widgets() const { return m_widgets.keys(); }

    /** The last spectrum seen, 0..255 per band, empty when not capturing. */
    QVector<uchar> spectrum() const { return m_spectrum; }
    uchar volume() const { return m_volume; }

signals:
    /** A new spectrum arrived. The feed forwards it so an interface can draw
     *  the bars; nothing else depends on it. */
    void spectrumChanged();

private slots:
    void onData(double *bands, int size, double maxMagnitude, quint32 power);

private:
    /** One widget's worth of bars, resolved against the project. */
    struct Widget
    {
        int bands = 0;
        bool enabled = false;
        QVector<VcWidget::AudioBar> bars;
    };

    void openCapture(int bands);
    void closeCapture();

    /**
     * The LevelSource id a DMX bar's fader is registered under.
     *
     * Bars are not widgets and have no id of their own, so they borrow a range
     * that a console cannot reach: QLC+ hands out widget ids from zero upwards
     * and treats UINT_MAX as invalid, so the top of the space is free. Keeping
     * them in LevelSource is what gives a bar its own fader and its submaster
     * scaling for nothing.
     */
    static quint32 barSliderId(quint32 widgetId, int barIndex);

    Doc *m_doc = nullptr;
    LevelSource *m_levels = nullptr;

    QSharedPointer<AudioCapture> m_capture;
    bool m_capturing = false;
    int m_registeredBands = 0;
    QString m_reason;

    QHash<quint32, Widget> m_widgets;

    QVector<uchar> m_spectrum;
    uchar m_volume = 0;
};

#endif // AUDIOTRIGGERS_H
