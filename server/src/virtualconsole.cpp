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

    bool isWidgetElement(const QStringView name)
    {
        static const QStringList widgets = {
            QStringLiteral("Frame"),   QStringLiteral("SoloFrame"),
            QStringLiteral("Button"),  QStringLiteral("Slider"),
            QStringLiteral("Label"),   QStringLiteral("SpeedDial"),
            QStringLiteral("XYPad"),   QStringLiteral("CueList"),
            QStringLiteral("Clock"),   QStringLiteral("AudioTriggers"),
            QStringLiteral("Animation"), QStringLiteral("ButtonMatrix"),
        };

        return widgets.contains(name.toString());
    }

    void parseWidget(QXmlStreamReader &reader, VcWidget &widget)
    {
        widget.type = typeForElement(reader.name());
        widget.caption = reader.attributes().value(QStringLiteral("Caption")).toString();
        widget.id = reader.attributes().value(QStringLiteral("ID")).toUInt();

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
                    else
                        reader.skipCurrentElement();
                }
            }
            else if (name == QStringLiteral("Function"))
            {
                /* A button names its function in an ID attribute. Other widgets
                   use <Function> for their own purposes -- a SpeedDial lists
                   several, with the id in the element text -- so only take the
                   attribute form, and only the first one. */
                const QXmlStreamAttributes attributes = reader.attributes();
                const QStringView id = attributes.value(QStringLiteral("ID"));

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
            else if (name == QStringLiteral("Time"))
            {
                widget.speedMs = reader.readElementText().toInt();
            }
            else if (name == QStringLiteral("AbsoluteValue"))
            {
                widget.speedMin = reader.attributes().value(QStringLiteral("Minimum")).toInt();
                widget.speedMax = reader.attributes().value(QStringLiteral("Maximum")).toInt();
                reader.skipCurrentElement();
            }
            else if (name == QStringLiteral("SliderMode"))
            {
                widget.sliderMode = reader.readElementText().trimmed().toLower();
            }
            else if (name == QStringLiteral("Level"))
            {
                const QXmlStreamAttributes attributes = reader.attributes();
                widget.low = attributes.value(QStringLiteral("LowLimit")).toInt();
                widget.high = attributes.value(QStringLiteral("HighLimit")).toInt();
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
