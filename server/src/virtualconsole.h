/*
  OrchidLights
  virtualconsole.h

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

#ifndef VIRTUALCONSOLE_H
#define VIRTUALCONSOLE_H

#include <QStringList>
#include <QString>
#include <QVector>
#include <QPair>
#include <QRect>

/**
 * A read-only view of the Virtual Console stored in a project.
 *
 * QLC+ keeps the Virtual Console outside Doc, and this daemon preserves that
 * section of the file verbatim rather than modelling it. This parses the very
 * same preserved XML into something the web interface can render -- reading
 * only, so the file still goes back out exactly as it came in.
 *
 * Note what the geometry means: QLC+ lays widgets out in absolute pixels on the
 * canvas the show was designed on, typically 1920x1080. Scaling that down to a
 * phone produces buttons nobody can hit in the dark. The coordinates are
 * carried through so the interface can group widgets into rows and reflow them,
 * which is the whole point of the exercise.
 */
struct VcWidget
{
    QString type;        //!< frame, button, slider, label, speeddial, ...

    /** QLC+ omits the ID attribute entirely rather than writing a sentinel, so
     *  "absent" and "zero" are different things and zero is a real id. */
    bool hasId = false;
    quint32 id = 0;

    QString caption;
    QRect geometry;

    /** Which page of a multipage frame this widget belongs to. Written only
     *  when non-zero; ignoring it draws every page superimposed. */
    int page = 0;

    QString background;  //!< "#rrggbb", empty when the widget has no colour set
    QString foreground;

    /** Function a button drives, or the one a playback slider rides. */
    bool hasFunction = false;
    quint32 functionId = 0;

    /** What a button does when pressed: Toggle, Flash, Blackout or StopAll.
     *  Empty for everything else. */
    QString action;

    /* Sliders. QLC+ has three kinds and they do entirely different things:
       Level drives fixture channels directly, Playback rides a function's
       intensity, and Submaster scales other widgets. */
    QString sliderMode;          //!< "level", "playback", "submaster", empty otherwise
    int low = 0;                 //!< bottom of the slider's range
    int high = 255;
    int value = 0;               //!< the value stored in the project

    /** Fixture and channel pairs a level slider writes to. */
    QVector<QPair<quint32, quint32>> levelChannels;

    /** Cue list: the chaser it steps through. A cue list is a chaser plus
     *  next/previous, which is how a show is actually run. */
    bool hasChaser = false;
    quint32 chaserId = 0;

    /**
     * XY pad: the heads it steers, and how much of their travel it may use.
     *
     * The limits are fractions of each head's full range and they are not
     * decoration -- a pad set to the front half of the stage must not swing a
     * lamp into the audience because a phone screen is a different shape.
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
    QVector<PadHead> padHeads;

    /** Where the pad was left, 0..1 on each axis. */
    double padX = 0.0;
    double padY = 0.0;

    /** Clock: "stopwatch", "countdown" or "clock", and its target time. */
    QString clockType;
    int clockTime = 0;

    /* Speed dials. Each entry names a function and, for each of its three
       speeds, a multiplier index into QLC+'s table. Index 0 is None, meaning
       "leave that speed alone" -- which is why a dial that looks like it should
       change a fade often only changes a duration. */
    struct SpeedTarget
    {
        quint32 functionId = 0;
        int fadeIn = 0;
        int fadeOut = 0;
        int duration = 0;
    };
    QVector<SpeedTarget> speedTargets;
    int speedMs = 0;       //!< the dial's stored position, in milliseconds
    int speedMin = 0;
    int speedMax = 10000;

    QVector<VcWidget> children;
};

namespace VirtualConsole
{
    /**
     * Parse the Virtual Console out of the preserved project sections.
     *
     * Returns false when the project has no Virtual Console at all, which is
     * perfectly normal -- plenty of shows are driven from the function list.
     */
    bool parse(const QStringList &preservedSections, VcWidget &root);

    /** The widget carrying this id, anywhere in the tree, or nullptr. */
    const VcWidget *find(const VcWidget &root, quint32 id);
}

#endif // VIRTUALCONSOLE_H
