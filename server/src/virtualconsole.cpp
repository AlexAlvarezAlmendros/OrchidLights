/*
  OrchidLights
  virtualconsole.cpp

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

#include <QXmlStreamReader>

#include <QTime>

#include "virtualconsole.h"

namespace
{
    /** QLC+ stores colours as a decimal ARGB uint32. */
    QString colourFromArgb(const QString &text)
    {
        bool ok = false;
        const quint32 argb = text.trimmed().toUInt(&ok);
        if (ok == false)
            return QString();

        return QStringLiteral("#%1")
            .arg(argb & 0x00FFFFFFu, 6, 16, QLatin1Char('0'));
    }

    QString typeForElement(const QStringView name)
    {
        /* Lower-cased so the wire format does not leak QLC+'s capitalisation
           into the interface, where these become CSS classes. */
        return name.toString().toLower();
    }

    /**
     * The widget tags that actually appear in a .qxw.
     *
     * Taken from the writers rather than from the menu labels: the RGB matrix
     * widget is shown as "Animation" in both UIs but writes <Matrix> in v4 and
     * v5 alike (ui/src/virtualconsole/vcmatrix.h:43,
     * qmlui/virtualconsole/vcanimation.h:28). The earlier list here had
     * "Animation" and "ButtonMatrix", neither of which is a tag anywhere in the
     * tree, and lacked "Matrix" -- so a Matrix widget was simply invisible to
     * the interface.
     */
    bool isWidgetElement(const QStringView name)
    {
        static const QStringList widgets = {
            QStringLiteral("Frame"),   QStringLiteral("SoloFrame"),
            QStringLiteral("Button"),  QStringLiteral("Slider"),
            QStringLiteral("Label"),   QStringLiteral("SpeedDial"),
            QStringLiteral("XYPad"),   QStringLiteral("CueList"),
            QStringLiteral("Clock"),   QStringLiteral("AudioTriggers"),
            QStringLiteral("Matrix"),
        };

        return widgets.contains(name.toString());
    }

    void parseWidget(QXmlStreamReader &reader, VcWidget &widget)
    {
        widget.type = typeForElement(reader.name());

        /* qmlui's slider style: "Knob" draws round. Read here because it is
           an attribute of the widget element itself. */
        if (reader.attributes().hasAttribute(QStringLiteral("WidgetStyle")))
            widget.sliderStyle =
                reader.attributes().value(QStringLiteral("WidgetStyle")).toString();

        const QXmlStreamAttributes widgetAttributes = reader.attributes();
        widget.caption = widgetAttributes.value(QStringLiteral("Caption")).toString();

        /* ID is omitted entirely when a widget has none -- QLC+ never writes
           the invalidId sentinel (ui/src/virtualconsole/vcwidget.cpp:1022).
           Defaulting the absent case to 0 made every such widget claim to be
           widget zero, which is a real id belonging to something else. */
        widget.hasId = widgetAttributes.hasAttribute(QStringLiteral("ID"));
        if (widget.hasId)
            widget.id = widgetAttributes.value(QStringLiteral("ID")).toUInt();

        /* Written only when non-zero, and it decides which page of a multipage
           frame a widget belongs to. Ignoring it drew every page at once. */
        widget.page = widgetAttributes.value(QStringLiteral("Page")).toInt();

        /* A clock keeps everything on the element itself: the type always, and
           for a countdown the target as three attributes. It never writes a
           <Time> element -- that belongs to the speed dial, and reading a
           clock's time from there meant it was always zero. */
        if (widget.type == QStringLiteral("audiotriggers"))
        {
            widget.audioBands = widgetAttributes.value(QStringLiteral("BarsNumber")).toInt();
        }

        if (widget.type == QStringLiteral("clock"))
        {
            widget.clockType = widgetAttributes.value(QStringLiteral("Type")).toString().toLower();

            widget.clockTime = widgetAttributes.value(QStringLiteral("Hours")).toInt() * 3600
                             + widgetAttributes.value(QStringLiteral("Minutes")).toInt() * 60
                             + widgetAttributes.value(QStringLiteral("Seconds")).toInt();
        }

        while (reader.readNextStartElement())
        {
            const QStringView name = reader.name();

            if (name == QStringLiteral("WindowState"))
            {
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.geometry = QRect(attributes.value(QStringLiteral("X")).toInt(),
                                        attributes.value(QStringLiteral("Y")).toInt(),
                                        attributes.value(QStringLiteral("Width")).toInt(),
                                        attributes.value(QStringLiteral("Height")).toInt());
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Appearance"))
            {
                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("BackgroundColor"))
                        widget.background = colourFromArgb(reader.readElementText());
                    else if (reader.name() == QStringLiteral("ForegroundColor"))
                        widget.foreground = colourFromArgb(reader.readElementText());
                    else if (reader.name() == QStringLiteral("Font"))
                    {
                        /* QFont::toString(), which is a comma-separated list
                           starting with the family and the point size. Reported
                           as those two rather than as the whole string: the
                           other fourteen fields are QFont internals that mean
                           nothing to an operator and less to a browser. */
                        const QString font = reader.readElementText().trimmed();
                        if (font.isEmpty() == false && font != QStringLiteral("Default"))
                            widget.font = font;
                    }
                    else if (reader.name() == QStringLiteral("FrameStyle"))
                    {
                        const QString style = reader.readElementText().trimmed();
                        if (style.isEmpty() == false)
                            widget.frameStyle = style;
                    }
                    else
                        reader.skipCurrentElement();
                }
            }
            else if (name == QStringLiteral("Input"))
            {
                /* What moves this widget from outside: a MIDI note, an OSC
                   message, a fader on a wing. The universe here is an *input*
                   universe, which has nothing to do with the DMX universes the
                   fixtures live in -- same word, different numbering, and
                   confusing them puts a widget on a control nobody can find. */
                const QXmlStreamAttributes attributes = reader.attributes();
                bool universeOk = false, channelOk = false;
                const uint universe =
                    attributes.value(QStringLiteral("Universe")).toUInt(&universeOk);
                const uint channel =
                    attributes.value(QStringLiteral("Channel")).toUInt(&channelOk);

                if (universeOk && channelOk)
                {
                    widget.hasInput = true;
                    widget.inputUniverse = quint32(universe);
                    widget.inputChannel = quint32(channel);

                    /* Custom feedback: what to send back to the control when
                       the widget turns off (Lower) and on (Upper) -- the MIDI
                       LED's two states. Absent means the plain 0/255. */
                    bool ok = false;
                    const uint lower =
                        attributes.value(QStringLiteral("LowerValue")).toUInt(&ok);
                    if (ok)
                        widget.feedbackLower = uchar(lower);
                    const uint upper =
                        attributes.value(QStringLiteral("UpperValue")).toUInt(&ok);
                    if (ok)
                        widget.feedbackUpper = uchar(upper);
                }
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Schedule"))
            {
                /* The clock's agenda, in either spelling: qmlui writes
                   StartTime/StopTime/WeekFlags, QLC+ 4 wrote a bare Time. */
                const QXmlStreamAttributes attributes = reader.attributes();
                VcWidget::ClockSchedule entry;
                entry.functionId =
                    attributes.value(QStringLiteral("Function")).toUInt();

                const auto seconds = [&attributes](const QString &key) {
                    const QTime time = QTime::fromString(
                        attributes.value(key).toString(), QStringLiteral("HH:mm:ss"));
                    return time.isValid() ? time.msecsSinceStartOfDay() / 1000 : -1;
                };
                int start = seconds(QStringLiteral("StartTime"));
                if (start < 0)
                    start = seconds(QStringLiteral("Time"));
                entry.startTime = qMax(0, start);
                entry.stopTime = seconds(QStringLiteral("StopTime"));
                entry.weekFlags =
                    attributes.value(QStringLiteral("WeekFlags")).toInt();

                widget.schedules.append(entry);
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Intensity"))
            {
                /* A button's startup intensity: <Intensity Adjust="True">75.
                   Only meaningful on buttons; harmless to carry elsewhere. */
                widget.startupIntensityEnabled =
                    reader.attributes().value(QStringLiteral("Adjust"))
                        .compare(QStringLiteral("True"), Qt::CaseInsensitive) == 0;
                widget.startupIntensity = reader.readElementText().trimmed().toInt();
            }
            else if (name == QStringLiteral("Key"))
            {
                /* The keyboard shortcut, as QKeySequence writes it
                   ("Ctrl+F1"). An empty element means none was bound. */
                widget.key = reader.readElementText().trimmed();
            }
            else if (name == QStringLiteral("Function"))
            {
                /* A button names its function in an ID attribute. Other widgets
                   use <Function> for their own purposes -- a SpeedDial lists
                   several, with the id in the element text -- so only take the
                   attribute form, and only the first one. */
                const QXmlStreamAttributes attributes = reader.attributes();
                const QStringView id = attributes.value(QStringLiteral("ID"));

                if (attributes.hasAttribute(QStringLiteral("InstantApply")))
                    widget.instantApply = true;

                if (id.isEmpty() == false)
                {
                    if (widget.hasFunction == false)
                    {
                        widget.hasFunction = true;
                        widget.functionId = id.toUInt();
                    }
                    reader.skipCurrentElement();
                }
                else
                {
                    /* The speed dial form: multipliers in the attributes, the
                       function id in the element text. */
                    VcWidget::SpeedTarget target;
                    target.fadeIn = attributes.value(QStringLiteral("FadeIn")).toInt();
                    target.fadeOut = attributes.value(QStringLiteral("FadeOut")).toInt();
                    target.duration = attributes.value(QStringLiteral("Duration")).toInt();
                    target.functionId = reader.readElementText().toUInt();

                    widget.speedTargets.append(target);
                }
            }
            else if (name == QStringLiteral("Chaser"))
            {
                /* A cue list names the chaser it steps through in the element
                   text. Without it the widget is decoration. */
                bool ok = false;
                const quint32 id = reader.readElementText().toUInt(&ok);
                if (ok)
                {
                    widget.hasChaser = true;
                    widget.chaserId = id;
                }
            }
            else if (name == QStringLiteral("Time"))
            {
                /* A speed dial's stored position. A clock does NOT use this
                   element -- see the Clock attributes read below. */
                widget.speedMs = reader.readElementText().toInt();
            }
            else if (name == QStringLiteral("Playback"))
            {
                /* A playback slider names its function here, as element text
                   inside <Playback> (ui/src/virtualconsole/vcslider.cpp:1921),
                   not as an attribute on <Function> the way a button does. Only
                   handling the button form meant a playback slider never
                   reported a function at all. */
                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Function"))
                    {
                        bool ok = false;
                        const quint32 id = reader.readElementText().toUInt(&ok);
                        if (ok && widget.hasFunction == false)
                        {
                            widget.hasFunction = true;
                            widget.functionId = id;
                        }
                    }
                    else
                    {
                        reader.skipCurrentElement();
                    }
                }
            }
            else if (name == QStringLiteral("AbsoluteValue"))
            {
                widget.speedMin = reader.attributes().value(QStringLiteral("Minimum")).toInt();
                widget.speedMax = reader.attributes().value(QStringLiteral("Maximum")).toInt();
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Adjust"))
            {
                /* qmlui's adjust-mode target: the function whose attribute
                   the fader turns. */
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.adjustFunction =
                    attributes.value(QStringLiteral("Function")).toUInt();
                widget.adjustAttribute =
                    attributes.value(QStringLiteral("Attribute")).toInt();
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("SliderMode"))
            {
                widget.sliderMode = reader.readElementText().trimmed().toLower();
            }
            else if (name == QStringLiteral("Action"))
            {
                /* What a button does when pressed. Without this an editor can
                   only ever show it as a toggle -- and a button captioned
                   BLACKOUT that has been quietly turned into a toggle is a
                   discovery nobody wants to make from the desk. */
                {
                    const QXmlStreamAttributes attributes = reader.attributes();
                    widget.flashOverride =
                        attributes.value(QStringLiteral("Override")).toInt() != 0;
                    widget.flashForceLTP =
                        attributes.value(QStringLiteral("ForceLTP")).toInt() != 0;
                }
                widget.action = reader.readElementText().trimmed();
            }
            else if (name == QStringLiteral("Level"))
            {
                /* Only what is actually written. toInt() on a missing attribute
                   is 0, and a HighLimit of 0 means a fader that can never rise
                   -- or, for a submaster, a rig that is black with nothing to
                   show why. The defaults on VcWidget are the honest fallback. */
                const QXmlStreamAttributes attributes = reader.attributes();

                if (attributes.hasAttribute(QStringLiteral("LowLimit")))
                    widget.low = attributes.value(QStringLiteral("LowLimit")).toInt();
                if (attributes.hasAttribute(QStringLiteral("HighLimit")))
                    widget.high = attributes.value(QStringLiteral("HighLimit")).toInt();
                if (attributes.hasAttribute(QStringLiteral("Value")))
                    widget.value = attributes.value(QStringLiteral("Value")).toInt();

                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Channel"))
                    {
                        const quint32 fixture =
                            reader.attributes().value(QStringLiteral("Fixture")).toUInt();
                        const quint32 channel = reader.readElementText().toUInt();
                        widget.levelChannels.append(qMakePair(fixture, channel));
                    }
                    else
                    {
                        reader.skipCurrentElement();
                    }
                }
            }
            else if (name == QStringLiteral("Fixture") && widget.type == QStringLiteral("xypad"))
            {
                /* A head of an XY pad, with the slice of pan and tilt travel it
                   is allowed. The limits are fractions of the head's full
                   range, and they are not decoration: a pad set to the front
                   half of the stage must not swing a lamp into the audience. */
                VcWidget::PadHead head;
                head.fixtureId = reader.attributes().value(QStringLiteral("ID")).toUInt();
                head.head = reader.attributes().value(QStringLiteral("Head")).toInt();

                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Axis"))
                    {
                        const QXmlStreamAttributes axis = reader.attributes();
                        const bool isX =
                            axis.value(QStringLiteral("ID")) == QStringLiteral("X");

                        const double low = axis.value(QStringLiteral("LowLimit")).toDouble();
                        const double high = axis.value(QStringLiteral("HighLimit")).toDouble();
                        /* QLC+ writes "True"/"False" here, and reads anything
                           that is not "False" as reversed. */
                        const bool reverse =
                            axis.value(QStringLiteral("Reverse")).toString().compare(
                                QStringLiteral("false"), Qt::CaseInsensitive) != 0;

                        if (isX)
                        {
                            head.xMin = low;
                            head.xMax = high;
                            head.xReverse = reverse;
                        }
                        else
                        {
                            head.yMin = low;
                            head.yMax = high;
                            head.yReverse = reverse;
                        }
                    }
                    reader.skipCurrentElement();
                }

                widget.padHeads.append(head);
            }
            else if (name == QStringLiteral("Control")
                     && widget.type == QStringLiteral("matrix"))
            {
                VcWidget::MatrixPreset preset;
                preset.id = reader.attributes().value(QStringLiteral("ID")).toInt();

                while (reader.readNextStartElement())
                {
                    const QStringView field = reader.name();

                    if (field == QStringLiteral("Type"))
                        preset.type = reader.readElementText().trimmed();
                    else if (field == QStringLiteral("Color"))
                        preset.color = reader.readElementText().trimmed();
                    else if (field == QStringLiteral("Resource"))
                        preset.resource = reader.readElementText().trimmed();
                    else if (field == QStringLiteral("Property"))
                    {
                        /* An animation preset carries the script properties it
                           was stored with, and applying it without them gives a
                           different animation. */
                        const QString key =
                            reader.attributes().value(QStringLiteral("Name")).toString();
                        preset.properties.append(qMakePair(key, reader.readElementText()));
                    }
                    else
                    {
                        reader.skipCurrentElement();
                    }
                }

                widget.matrixPresets.append(preset);
            }
            else if ((name == QStringLiteral("VolumeBar")
                      || name == QStringLiteral("SpectrumBar"))
                     && widget.type == QStringLiteral("audiotriggers"))
            {
                const QXmlStreamAttributes bar = reader.attributes();

                VcWidget::AudioBar entry;
                entry.isVolume = (name == QStringLiteral("VolumeBar"));
                entry.name = bar.value(QStringLiteral("Name")).toString();
                entry.type = bar.value(QStringLiteral("Type")).toInt();
                entry.index = bar.value(QStringLiteral("Index")).toInt();

                if (bar.hasAttribute(QStringLiteral("MinThreshold")))
                    entry.minThreshold = bar.value(QStringLiteral("MinThreshold")).toInt();
                if (bar.hasAttribute(QStringLiteral("MaxThreshold")))
                    entry.maxThreshold = bar.value(QStringLiteral("MaxThreshold")).toInt();
                if (bar.hasAttribute(QStringLiteral("Divisor")))
                    entry.divisor = bar.value(QStringLiteral("Divisor")).toInt();

                entry.functionId = bar.value(QStringLiteral("FunctionID")).toUInt();
                entry.targetWidgetId = bar.value(QStringLiteral("WidgetID")).toUInt();

                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("DMXChannels"))
                    {
                        /* "fixture,channel,fixture,channel,..." in one string.
                           An odd count means a truncated pair, and taking the
                           lone value as a fixture with channel zero would hold
                           a channel nobody asked for. */
                        const QStringList parts =
                            reader.readElementText().split(QChar(','), Qt::SkipEmptyParts);

                        for (int i = 0; i + 1 < parts.count(); i += 2)
                        {
                            entry.dmxChannels.append(
                                qMakePair(parts.at(i).toUInt(), parts.at(i + 1).toUInt()));
                        }
                    }
                    else
                    {
                        reader.skipCurrentElement();
                    }
                }

                widget.audioBars.append(entry);
            }
            else if (name == QStringLiteral("Multipage"))
            {
                /* A frame that carries pages. Its children each name theirs in
                   @Page, so without this every page is drawn on top of the
                   others. */
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.pages = attributes.value(QStringLiteral("PagesNum")).toInt();
                widget.currentPage = attributes.value(QStringLiteral("CurrentPage")).toInt();
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("PagesLoop"))
            {
                widget.pagesLoop =
                    reader.readElementText().trimmed().compare(QStringLiteral("True"),
                                                               Qt::CaseInsensitive) == 0;
            }
            else if (name == QStringLiteral("Next") || name == QStringLiteral("Previous"))
            {
                /* The external controls that turn a frame's pages: an <Input>
                   inside <Next> / <Previous>. */
                const bool forward = name == QStringLiteral("Next");
                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Input"))
                    {
                        const QXmlStreamAttributes attributes = reader.attributes();
                        bool universeOk = false, channelOk = false;
                        const uint universe =
                            attributes.value(QStringLiteral("Universe")).toUInt(&universeOk);
                        const uint channel =
                            attributes.value(QStringLiteral("Channel")).toUInt(&channelOk);
                        if (universeOk && channelOk)
                        {
                            if (forward)
                            {
                                widget.hasNextPageInput = true;
                                widget.nextPageUniverse = quint32(universe);
                                widget.nextPageChannel = quint32(channel);
                            }
                            else
                            {
                                widget.hasPrevPageInput = true;
                                widget.prevPageUniverse = quint32(universe);
                                widget.prevPageChannel = quint32(channel);
                            }
                        }
                        reader.skipCurrentElement();
                    }
                    else
                        reader.skipCurrentElement();
                }
            }
            else if (name == QStringLiteral("PageShortcut"))
            {
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.pageShortcuts.append(
                    qMakePair(attributes.value(QStringLiteral("Page")).toInt(),
                              attributes.value(QStringLiteral("Name")).toString()));
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Preset"))
            {
                /* An XY pad preset: a stored position, or a function the pad
                   can fire. Positions live in the pad's 0..256 canvas, like
                   Pan/Tilt above. */
                VcWidget::PadPreset preset;
                preset.id = reader.attributes().value(QStringLiteral("ID")).toInt();
                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Type"))
                        preset.type = reader.readElementText().trimmed();
                    else if (reader.name() == QStringLiteral("Name"))
                        preset.name = reader.readElementText();
                    else if (reader.name() == QStringLiteral("FuncID"))
                        preset.functionId = reader.readElementText().toUInt();
                    else if (reader.name() == QStringLiteral("XPos"))
                        preset.x = reader.readElementText().toDouble() / 256.0;
                    else if (reader.name() == QStringLiteral("YPos"))
                        preset.y = reader.readElementText().toDouble() / 256.0;
                    else
                        reader.skipCurrentElement();
                }
                widget.padPresets.append(preset);
            }
            else if (name == QStringLiteral("SlidersMode"))
            {
                widget.sideFaderMode = reader.readElementText().trimmed();
            }
            else if (name == QStringLiteral("ShowHeader"))
            {
                /* A frame without a header is a grouping the designer wanted
                   invisible, so drawing a titled box around it would be adding
                   furniture nobody asked for. */
                widget.showHeader =
                    reader.readElementText().trimmed().compare(QStringLiteral("0")) != 0;
            }
            else if (name == QStringLiteral("Collapsed"))
            {
                widget.collapsed =
                    reader.readElementText().trimmed().compare(QStringLiteral("0")) != 0;
            }
            else if (name == QStringLiteral("Pan") || name == QStringLiteral("Tilt"))
            {
                /* Stored in a 0..256 space, which is what the desktop pad's
                   canvas uses. Normalised here so nothing downstream has to
                   know that number. */
                const double position =
                    reader.attributes().value(QStringLiteral("Position")).toDouble() / 256.0;

                if (name == QStringLiteral("Pan"))
                    widget.padX = position;
                else
                    widget.padY = position;

                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("Position"))
            {
                /* The pre-5.0 shape, which carried both axes on one element. */
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.padX = attributes.value(QStringLiteral("X")).toDouble() / 256.0;
                widget.padY = attributes.value(QStringLiteral("Y")).toDouble() / 256.0;
                reader.skipCurrentElement();
            }
            else if (isWidgetElement(name))
            {
                VcWidget child;
                parseWidget(reader, child);
                widget.children.append(child);
            }
            else
            {
                reader.skipCurrentElement();
            }
        }
    }
}

bool VirtualConsole::parse(const QStringList &preservedSections, VcWidget &root)
{
    for (const QString &section : preservedSections)
    {
        QXmlStreamReader reader(section);

        if (reader.readNextStartElement() == false)
            continue;
        if (reader.name() != QStringLiteral("VirtualConsole"))
            continue;

        root = VcWidget();
        root.type = QStringLiteral("virtualconsole");

        while (reader.readNextStartElement())
        {
            if (isWidgetElement(reader.name()))
            {
                VcWidget child;
                parseWidget(reader, child);
                root.children.append(child);
            }
            else
            {
                reader.skipCurrentElement();
            }
        }

        return reader.hasError() == false;
    }

    return false;
}

const VcWidget *VirtualConsole::find(const VcWidget &root, quint32 id)
{
    if (root.hasId && root.id == id)
        return &root;

    for (const VcWidget &child : root.children)
    {
        if (const VcWidget *found = find(child, id))
            return found;
    }

    return nullptr;
}
