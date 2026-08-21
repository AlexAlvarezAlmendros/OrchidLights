/*
  OrchidLights
  vcpatch.cpp

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

#include <QJsonValue>
#include <QJsonArray>
#include <QSet>

#include <QColor>
#include <QFont>

#include "vcpatch.h"
#include "xmltree.h"

namespace
{
    const QString AttrId = QStringLiteral("ID");

    /** The function id that means "nothing". Both readers write it out rather
     *  than leaving the element off. */
    const QString NoFunction = QStringLiteral("4294967295");

    /** Tags that are widgets, matching server/src/virtualconsole.cpp. */
    const QStringList &widgetTags()
    {
        static const QStringList tags = {
            QStringLiteral("Frame"),   QStringLiteral("SoloFrame"),
            QStringLiteral("Button"),  QStringLiteral("Slider"),
            QStringLiteral("Label"),   QStringLiteral("SpeedDial"),
            QStringLiteral("XYPad"),   QStringLiteral("CueList"),
            QStringLiteral("Clock"),   QStringLiteral("AudioTriggers"),
            QStringLiteral("Matrix"),
        };
        return tags;
    }

    bool isWidget(const XmlNode &node)
    {
        return widgetTags().contains(node.name);
    }

    /** Only these can hold other widgets. */
    bool isFrame(const XmlNode &node)
    {
        return node.name == QStringLiteral("Frame")
               || node.name == QStringLiteral("SoloFrame");
    }

    /** The XML tag for a type name as the API spells it. Empty when unknown. */
    QString tagForType(const QString &type)
    {
        for (const QString &tag : widgetTags())
        {
            if (tag.compare(type.trimmed(), Qt::CaseInsensitive) == 0)
                return tag;
        }
        return QString();
    }

    /**
     * Depth-first search for a widget, descending through widgets only.
     *
     * The restriction is the whole point. ID is not a widget's private
     * attribute: an XY pad writes <Fixture ID="5" Head="0">, a button writes
     * <Function ID="5">. A search that matched any element carrying ID would
     * find that <Fixture> first and hand it back as if it were widget 5 -- and
     * a delete would then remove a fixture from an XY pad instead of the widget
     * the operator asked for.
     */
    XmlNode *findWidget(XmlNode &node, const QString &id)
    {
        for (XmlNode &child : node.children)
        {
            if (isWidget(child) == false)
                continue;

            if (child.attribute(AttrId) == id)
                return &child;

            if (XmlNode *found = findWidget(child, id))
                return found;
        }

        return nullptr;
    }

    bool removeWidgetNode(XmlNode &node, const QString &id)
    {
        for (int i = 0; i < node.children.count(); i++)
        {
            const XmlNode &child = node.children.at(i);
            if (isWidget(child) && child.attribute(AttrId) == id)
            {
                node.children.remove(i);
                return true;
            }
        }

        for (XmlNode &child : node.children)
        {
            if (isWidget(child) && removeWidgetNode(child, id))
                return true;
        }

        return false;
    }

    void collectWidgetIds(const XmlNode &node, QStringList &ids)
    {
        for (const XmlNode &child : node.children)
        {
            if (isWidget(child) == false)
                continue;

            if (child.hasAttribute(AttrId))
                ids << child.attribute(AttrId);

            collectWidgetIds(child, ids);
        }
    }

    /**
     * A blank widget of this type, ready to be patched.
     *
     * This is the one place exhaustive field knowledge is needed, so the rules
     * are spelled out rather than assumed:
     *
     *  - All five WindowState attributes, always. Both readers expect them.
     *  - Appearance is omitted entirely. Both readers only apply the properties
     *    the element actually carries, and writing v4's "Default" sentinels
     *    would bake in colour and font choices the operator never made.
     *  - A slider gets InvertedAppearance explicitly, because the reader treats
     *    anything other than the literal "false" as true -- omitting it would
     *    hand the operator an upside-down fader.
     *  - A button gets the no-function sentinel and an action, because a button
     *    with neither is a control that silently does nothing.
     *
     * Everything an operator chooses -- caption, position, what it drives -- is
     * left to applyPatch, so creating a widget and editing one go through the
     * same code and mean the same thing.
     */
    XmlNode buildWidget(const QString &tag, const QString &id)
    {
        XmlNode node;
        node.name = tag;

        node.setAttribute(QStringLiteral("Caption"), QString());
        node.setAttribute(AttrId, id);

        if (tag == QStringLiteral("Slider"))
        {
            node.setAttribute(QStringLiteral("WidgetStyle"), QStringLiteral("Slider"));
            node.setAttribute(QStringLiteral("InvertedAppearance"), QStringLiteral("false"));
        }

        XmlNode window;
        window.name = QStringLiteral("WindowState");
        window.setAttribute(QStringLiteral("Visible"), QStringLiteral("True"));
        window.setAttribute(QStringLiteral("X"), QStringLiteral("0"));
        window.setAttribute(QStringLiteral("Y"), QStringLiteral("0"));
        window.setAttribute(QStringLiteral("Width"), QStringLiteral("100"));
        window.setAttribute(QStringLiteral("Height"), QStringLiteral("50"));
        node.children.append(window);

        if (tag == QStringLiteral("Slider"))
        {
            XmlNode mode;
            mode.name = QStringLiteral("SliderMode");
            mode.setAttribute(QStringLiteral("ValueDisplayStyle"), QStringLiteral("Exact"));
            mode.text = QStringLiteral("Level");
            node.children.append(mode);
        }

        if (tag == QStringLiteral("Button"))
        {
            XmlNode function;
            function.name = QStringLiteral("Function");
            function.setAttribute(AttrId, NoFunction);
            node.children.append(function);

            XmlNode action;
            action.name = QStringLiteral("Action");
            action.text = QStringLiteral("Toggle");
            node.children.append(action);
        }

        return node;
    }

    /**
     * Drop every reference to a fixture, wherever in the console it sits.
     *
     * Two shapes carry one: a slider's level channels,
     * <Channel Fixture="7">5</Channel>, and an XY pad's heads,
     * <Fixture ID="7" Head="0">. Matched by shape rather than by which widget
     * they sit under, so a widget type this code has never heard of still gets
     * cleaned out.
     *
     * The removals happen before the descent, not during it: taking children
     * out of a vector while holding pointers into it is how you end up
     * recursing into the wrong node.
     */
    int purgeFixture(XmlNode &node, const QString &fixtureId)
    {
        int removed = 0;

        for (int i = node.children.count() - 1; i >= 0; i--)
        {
            const XmlNode &child = node.children.at(i);

            const bool levelChannel = child.name == QStringLiteral("Channel")
                                      && child.attribute(QStringLiteral("Fixture")) == fixtureId;
            const bool padHead = child.name == QStringLiteral("Fixture")
                                 && child.attribute(AttrId) == fixtureId;

            if (levelChannel || padHead)
            {
                node.children.remove(i);
                removed++;
            }
        }

        for (XmlNode &child : node.children)
            removed += purgeFixture(child, fixtureId);

        return removed;
    }

    QString functionIdFrom(const QJsonValue &value)
    {
        if (value.isNull())
            return NoFunction;

        return QString::number(quint32(value.toDouble()));
    }

    /**
     * Point a widget at a function.
     *
     * Three widgets can hold one and all three spell it differently: a button
     * puts the id in an attribute, a playback slider in element text one level
     * down, a cue list in element text of its own. Getting this wrong does not
     * break the file -- it produces a control that looks right and does
     * nothing, which is worse.
     */
    VcPatch::Result bindFunction(XmlNode &widget, const QJsonValue &value)
    {
        const QString id = functionIdFrom(value);

        if (widget.name == QStringLiteral("Button"))
        {
            widget.childOrCreate(QStringLiteral("Function")).setAttribute(AttrId, id);
            return VcPatch::Result::success();
        }

        if (widget.name == QStringLiteral("Slider"))
        {
            widget.childOrCreate(QStringLiteral("Playback"))
                .childOrCreate(QStringLiteral("Function")).text = id;
            return VcPatch::Result::success();
        }

        if (widget.name == QStringLiteral("CueList"))
        {
            widget.childOrCreate(QStringLiteral("Chaser")).text = id;
            return VcPatch::Result::success();
        }

        return VcPatch::Result::failure(
            QStringLiteral("A %1 cannot be pointed at a function")
                .arg(widget.name.toLower()));
    }

    VcPatch::Result setButtonAction(XmlNode &widget, const QString &action)
    {
        if (widget.name != QStringLiteral("Button"))
            return VcPatch::Result::failure(QStringLiteral("Only a button has an action"));

        static const QStringList actions = {
            QStringLiteral("Toggle"), QStringLiteral("Flash"),
            QStringLiteral("Blackout"), QStringLiteral("StopAll"),
        };

        for (const QString &candidate : actions)
        {
            if (candidate.compare(action, Qt::CaseInsensitive) == 0)
            {
                widget.childOrCreate(QStringLiteral("Action")).text = candidate;
                return VcPatch::Result::success();
            }
        }

        return VcPatch::Result::failure(QStringLiteral("No button action \"%1\". Known: %2")
                                            .arg(action, actions.join(QStringLiteral(", "))));
    }

    VcPatch::Result setSliderMode(XmlNode &widget, const QString &mode)
    {
        if (widget.name != QStringLiteral("Slider"))
            return VcPatch::Result::failure(QStringLiteral("Only a slider has a mode"));

        static const QStringList modes = {
            QStringLiteral("Level"), QStringLiteral("Playback"),
            QStringLiteral("Submaster"),
        };

        for (const QString &candidate : modes)
        {
            if (candidate.compare(mode, Qt::CaseInsensitive) == 0)
            {
                XmlNode &node = widget.childOrCreate(QStringLiteral("SliderMode"));

                /* The reader takes anything it does not recognise as
                   Submaster, so an unknown mode would not be reported, it
                   would silently become a grand master over the whole show. */
                node.text = candidate;

                if (node.hasAttribute(QStringLiteral("ValueDisplayStyle")) == false)
                {
                    node.setAttribute(QStringLiteral("ValueDisplayStyle"),
                                      QStringLiteral("Exact"));
                }

                return VcPatch::Result::success();
            }
        }

        return VcPatch::Result::failure(QStringLiteral("No slider mode \"%1\". Known: %2")
                                            .arg(mode, modes.join(QStringLiteral(", "))));
    }

    /**
     * Replace a level slider's channel list.
     *
     * The <Level> element's own attributes stay: they carry the limits and the
     * last value, which are the operator's, not the channel list's.
     */
    VcPatch::Result setLevelChannels(XmlNode &widget, const QJsonArray &channels)
    {
        if (widget.name != QStringLiteral("Slider"))
            return VcPatch::Result::failure(QStringLiteral("Only a slider has level channels"));

        XmlNode &level = widget.childOrCreate(QStringLiteral("Level"));

        QVector<XmlNode> kept;
        for (const XmlNode &child : level.children)
        {
            if (child.name != QStringLiteral("Channel"))
                kept.append(child);
        }

        for (const QJsonValue &entry : channels)
        {
            const QJsonObject channel = entry.toObject();
            if (channel.value(QStringLiteral("fixture")).isDouble() == false
                || channel.value(QStringLiteral("channel")).isDouble() == false)
            {
                return VcPatch::Result::failure(
                    QStringLiteral("Every level channel needs a numeric \"fixture\" "
                                   "and \"channel\""));
            }

            XmlNode node;
            node.name = QStringLiteral("Channel");
            node.setAttribute(
                QStringLiteral("Fixture"),
                QString::number(quint32(channel.value(QStringLiteral("fixture")).toDouble())));
            node.text = QString::number(channel.value(QStringLiteral("channel")).toInt());
            kept.append(node);
        }

        level.children = kept;
        return VcPatch::Result::success();
    }

    VcPatch::Result setClockType(XmlNode &widget, const QString &type)
    {
        if (widget.name != QStringLiteral("Clock"))
            return VcPatch::Result::failure(QStringLiteral("Only a clock has a clock type"));

        static const QStringList types = {
            QStringLiteral("Clock"), QStringLiteral("Stopwatch"),
            QStringLiteral("Countdown"),
        };

        for (const QString &candidate : types)
        {
            if (candidate.compare(type, Qt::CaseInsensitive) == 0)
            {
                widget.setAttribute(QStringLiteral("Type"), candidate);
                return VcPatch::Result::success();
            }
        }

        return VcPatch::Result::failure(QStringLiteral("No clock type \"%1\". Known: %2")
                                            .arg(type, types.join(QStringLiteral(", "))));
    }

    /** The countdown target, in seconds, split back into the three attributes
     *  the file stores it in. */
    VcPatch::Result setClockTime(XmlNode &widget, const QJsonValue &value)
    {
        if (widget.name != QStringLiteral("Clock"))
            return VcPatch::Result::failure(QStringLiteral("Only a clock has a clock time"));

        const int seconds = value.isDouble() ? value.toInt(-1) : -1;
        if (seconds < 0 || seconds > 23 * 3600 + 59 * 60 + 59)
        {
            return VcPatch::Result::failure(
                QStringLiteral("Clock time must be a number of seconds, up to 86399"));
        }

        widget.setAttribute(QStringLiteral("Hours"), QString::number(seconds / 3600));
        widget.setAttribute(QStringLiteral("Minutes"), QString::number(seconds / 60 % 60));
        widget.setAttribute(QStringLiteral("Seconds"), QString::number(seconds % 60));

        return VcPatch::Result::success();
    }

    /** Every child with this name, gone. */
    void removeChildren(XmlNode &node, const QString &name)
    {
        for (int i = node.children.count() - 1; i >= 0; i--)
        {
            if (node.children.at(i).name == name)
                node.children.removeAt(i);
        }
    }

    /**
     * QLC+ stores a colour as a decimal ARGB integer, which is QRgb printed
     * with QString::number. Anything else in that element and the desktop reads
     * black.
     */
    QString argbFromColour(const QColor &colour)
    {
        return QString::number(quint32(colour.rgb()));
    }

    /**
     * How a widget looks: two colours, a font and a frame.
     *
     * "Default" rather than a removed element is what QLC+ writes for "no
     * choice", and it is not the same as absent -- the desktop's own writer
     * always emits all four. Following it keeps a project that goes through
     * here byte-comparable with one that did not.
     */
    VcPatch::Result setAppearance(XmlNode &widget, const QJsonObject &patch)
    {
        using Result = VcPatch::Result;

        const auto colour = [&](const char *key, const char *element) -> Result {
            const QJsonValue value = patch.value(QLatin1String(key));
            if (value.isUndefined())
                return Result::success();

            XmlNode &appearance = widget.childOrCreate(QStringLiteral("Appearance"));

            /* null is "back to the default", which is a thing an operator asks
               for and which an empty string does not say.
             *
               Written as the word "Default", which is exactly what the desktop
               writes and reads (vcwidget.cpp:872 applies anything that is not
               Default and ignores Default itself). Removing the element
               instead would mean the same thing to every reader -- but it would
               also mean this daemon deletes nodes on a project it barely
               models, to save four lines of XML that QLC+ puts back the next
               time it saves. */
            if (value.isNull())
            {
                appearance.childOrCreate(QString::fromLatin1(element)).text =
                    QStringLiteral("Default");
                return Result::success();
            }

            const QColor parsed(value.toString());
            if (parsed.isValid() == false)
            {
                return Result::failure(QStringLiteral("\"%1\" is not a colour")
                                           .arg(value.toString()));
            }

            appearance.childOrCreate(QString::fromLatin1(element)).text = argbFromColour(parsed);
            return Result::success();
        };

        Result result = colour("background", "BackgroundColor");
        if (result.ok == false)
            return result;

        result = colour("foreground", "ForegroundColor");
        if (result.ok == false)
            return result;

        if (patch.contains(QStringLiteral("font")))
        {
            const QJsonValue value = patch.value(QStringLiteral("font"));
            XmlNode &appearance = widget.childOrCreate(QStringLiteral("Appearance"));

            if (value.isNull())
            {
                appearance.childOrCreate(QStringLiteral("Font")).text = QStringLiteral("Default");
            }
            else
            {
                /* Round-tripped through QFont rather than stored as typed. The
                   file holds QFont::toString(), sixteen comma-separated fields,
                   and the desktop reads it with fromString(): a family name
                   written straight in would read as a font with no size, no
                   weight and no style, which renders as something nobody
                   chose. */
                QFont font;
                if (font.fromString(value.toString()) == false)
                {
                    return Result::failure(
                        QStringLiteral("\"%1\" is not a font. Send what QFont::toString() "
                                       "produces, or a family and a size like \"Arial,14\".")
                            .arg(value.toString()));
                }

                appearance.childOrCreate(QStringLiteral("Font")).text = font.toString();
            }
        }

        if (patch.contains(QStringLiteral("frameStyle")))
        {
            const QString style = patch.value(QStringLiteral("frameStyle")).toString();
            static const QStringList allowed = {QStringLiteral("None"), QStringLiteral("Sunken"),
                                                QStringLiteral("Raised")};

            if (allowed.contains(style) == false)
            {
                return Result::failure(QStringLiteral("A frame style is None, Sunken or Raised, "
                                                      "not \"%1\"").arg(style));
            }

            widget.childOrCreate(QStringLiteral("Appearance"))
                .childOrCreate(QStringLiteral("FrameStyle"))
                .text = style;
        }

        return Result::success();
    }

    /**
     * The external control bound to a widget: a MIDI note, an OSC message, a
     * fader on a wing.
     *
     * null unbinds it. The universe is an *input* universe, which is a
     * different numbering from the DMX universes the fixtures live in -- same
     * word, and confusing the two puts a widget on a control nobody can find.
     */
    VcPatch::Result setInput(XmlNode &widget, const QJsonValue &value)
    {
        using Result = VcPatch::Result;

        if (value.isNull())
        {
            /* Removed, not blanked: an <Input> with no attributes is read by
               QLC+ as universe 0, channel 0 -- a binding to something real. */
            removeChildren(widget, QStringLiteral("Input"));
            return Result::success();
        }

        if (value.isObject() == false)
        {
            return Result::failure(QStringLiteral("An input is {\"universe\": n, \"channel\": n}, "
                                                  "or null to unbind it"));
        }

        const QJsonObject input = value.toObject();
        const QJsonValue universe = input.value(QStringLiteral("universe"));
        const QJsonValue channel = input.value(QStringLiteral("channel"));

        if (universe.isDouble() == false || channel.isDouble() == false
            || universe.toInt(-1) < 0 || channel.toInt(-1) < 0)
        {
            return Result::failure(
                QStringLiteral("An input needs a non-negative \"universe\" and \"channel\""));
        }

        XmlNode &node = widget.childOrCreate(QStringLiteral("Input"));
        node.setAttribute(QStringLiteral("Universe"), QString::number(universe.toInt()));
        node.setAttribute(QStringLiteral("Channel"), QString::number(channel.toInt()));

        return Result::success();
    }

    /**
     * Apply a patch to one widget.
     *
     * Every key is optional and only what is present is touched -- that is what
     * makes this safe to run over a console we model a quarter of. Creating a
     * widget runs the same function over a blank one, so "what you can set" and
     * "what you can change" are the same list by construction.
     */
    VcPatch::Result applyPatch(XmlNode &widget, const QJsonObject &patch)
    {
        using Result = VcPatch::Result;

        if (patch.contains(QStringLiteral("caption")))
        {
            widget.setAttribute(QStringLiteral("Caption"),
                                patch.value(QStringLiteral("caption")).toString());
        }

        if (patch.contains(QStringLiteral("page")))
        {
            const int page = patch.value(QStringLiteral("page")).toInt(-1);
            if (page < 0)
                return Result::failure(QStringLiteral("Page must be a number, zero or above"));

            /* Page zero is written by leaving the attribute out, which is what
               QLC+ does; writing Page="0" onto every widget would be a diff
               that says nothing. */
            if (page == 0)
                widget.removeAttribute(QStringLiteral("Page"));
            else
                widget.setAttribute(QStringLiteral("Page"), QString::number(page));
        }

        if (patch.contains(QStringLiteral("geometry")))
        {
            const QJsonObject geometry = patch.value(QStringLiteral("geometry")).toObject();
            XmlNode &window = widget.childOrCreate(QStringLiteral("WindowState"));

            /* Only the fields that were asked for. @Visible, and v5's @Z, stay
               as they are: they were not part of the request. */
            struct Field { const char *key; const char *attribute; };
            static const Field fields[] = {
                {"x", "X"}, {"y", "Y"}, {"width", "Width"}, {"height", "Height"},
            };

            for (const Field &field : fields)
            {
                const QJsonValue value = geometry.value(QLatin1String(field.key));
                if (value.isUndefined())
                    continue;

                if (value.isDouble() == false)
                {
                    return Result::failure(
                        QStringLiteral("Geometry field \"%1\" must be a number").arg(field.key));
                }

                const int pixels = value.toInt();
                if (pixels < 0 || pixels > 100000)
                {
                    return Result::failure(
                        QStringLiteral("Geometry field \"%1\" must be between 0 and 100000")
                            .arg(field.key));
                }

                window.setAttribute(QLatin1String(field.attribute), QString::number(pixels));
            }
        }

        /* How it looks. Cosmetic on a desk is not decoration: a colour bank
           where every button is grey is a colour bank nobody can use in the
           dark, and the operator chose those colours for a reason. */
        if (patch.contains(QStringLiteral("background"))
            || patch.contains(QStringLiteral("foreground"))
            || patch.contains(QStringLiteral("font"))
            || patch.contains(QStringLiteral("frameStyle")))
        {
            const Result result = setAppearance(widget, patch);
            if (result.ok == false)
                return result;
        }

        /* What moves it from outside. */
        if (patch.contains(QStringLiteral("input")))
        {
            const Result result = setInput(widget, patch.value(QStringLiteral("input")));
            if (result.ok == false)
                return result;
        }

        /* What the widget does, as opposed to where it sits. Each of these
           refuses on a widget type that has no such setting, rather than
           writing an element the reader will ignore and leaving the operator
           to wonder why nothing happens. */
        /* The keys are the ones GET /vc answers with, so a client can read a
           widget, change a field and send it back without translating. */
        if (patch.contains(QStringLiteral("functionId")))
        {
            const Result result = bindFunction(widget, patch.value(QStringLiteral("functionId")));
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("chaserId")))
        {
            const Result result = bindFunction(widget, patch.value(QStringLiteral("chaserId")));
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("action")))
        {
            const Result result =
                setButtonAction(widget, patch.value(QStringLiteral("action")).toString());
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("sliderMode")))
        {
            const Result result =
                setSliderMode(widget, patch.value(QStringLiteral("sliderMode")).toString());
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("levelChannels")))
        {
            const Result result =
                setLevelChannels(widget, patch.value(QStringLiteral("levelChannels")).toArray());
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("clockType")))
        {
            const Result result =
                setClockType(widget, patch.value(QStringLiteral("clockType")).toString());
            if (result.ok == false)
                return result;
        }

        if (patch.contains(QStringLiteral("clockTime")))
        {
            const Result result =
                setClockTime(widget, patch.value(QStringLiteral("clockTime")));
            if (result.ok == false)
                return result;
        }

        return Result::success();
    }

    /** Load the console, or say why not. */
    VcPatch::Result openConsole(const QStringList &sections, int &index, XmlNode &console)
    {
        index = VcPatch::sectionIndex(sections);
        if (index < 0)
            return VcPatch::Result::failure(QStringLiteral("This project has no Virtual Console"));

        if (XmlTree::parse(sections.at(index), console) == false)
            return VcPatch::Result::failure(QStringLiteral("The Virtual Console could not be read"));

        return VcPatch::Result::success();
    }
}

int VcPatch::sectionIndex(const QStringList &sections)
{
    for (int i = 0; i < sections.count(); i++)
    {
        XmlNode node;
        if (XmlTree::parse(sections.at(i), node) && node.name == QStringLiteral("VirtualConsole"))
            return i;
    }
    return -1;
}

QString VcPatch::nextFreeId(const XmlNode &console)
{
    QStringList ids;
    collectWidgetIds(console, ids);

    QSet<quint32> used;
    for (const QString &id : ids)
    {
        bool ok = false;
        const quint32 value = id.toUInt(&ok);
        if (ok)
            used.insert(value);
    }

    /* UINT_MAX is the invalid-widget sentinel, so it is never handed out. The
       loop cannot run away: it stops at the first gap, and a console with four
       billion widgets is not a thing that exists. */
    quint32 candidate = 0;
    while (used.contains(candidate) && candidate < UINT_MAX - 1)
        candidate++;

    return QString::number(candidate);
}

VcPatch::Result VcPatch::assignIds(QStringList &sections, int &assigned)
{
    assigned = 0;

    int index = -1;
    XmlNode console;

    const Result opened = openConsole(sections, index, console);
    if (opened.ok == false)
        return opened;

    QStringList existing;
    collectWidgetIds(console, existing);

    QSet<quint32> used;
    for (const QString &id : existing)
    {
        bool ok = false;
        const quint32 value = id.toUInt(&ok);
        if (ok)
            used.insert(value);
    }

    /* In document order, so the ids read the way the console is laid out
       rather than in whatever order a traversal happens to reach them. */
    quint32 candidate = 0;
    QVector<XmlNode *> pending;
    pending.append(&console);

    while (pending.isEmpty() == false)
    {
        XmlNode *node = pending.takeFirst();

        for (int i = 0; i < node->children.count(); i++)
        {
            XmlNode &child = node->children[i];
            if (isWidget(child) == false)
                continue;

            if (child.hasAttribute(AttrId) == false)
            {
                while (used.contains(candidate) && candidate < UINT_MAX - 1)
                    candidate++;

                used.insert(candidate);
                child.setAttribute(AttrId, QString::number(candidate));
                assigned++;
            }

            pending.append(&child);
        }
    }

    if (assigned > 0)
        sections[index] = XmlTree::toXml(console);

    return Result::success();
}

VcPatch::Result VcPatch::editWidget(QStringList &sections, const QString &widgetId,
                                    const QJsonObject &patch)
{
    int index = -1;
    XmlNode console;

    const Result opened = openConsole(sections, index, console);
    if (opened.ok == false)
        return opened;

    XmlNode *widget = findWidget(console, widgetId);
    if (widget == nullptr)
        return Result::failure(QStringLiteral("No widget with id %1").arg(widgetId));

    const Result applied = applyPatch(*widget, patch);
    if (applied.ok == false)
        return applied;

    sections[index] = XmlTree::toXml(console);
    return Result::success();
}

VcPatch::Result VcPatch::addWidget(QStringList &sections, const QString &type,
                                   const QString &parentId, const QJsonObject &properties,
                                   QString &newId)
{
    const QString tag = tagForType(type);
    if (tag.isEmpty())
    {
        QStringList known;
        for (const QString &candidate : widgetTags())
            known << candidate.toLower();

        return Result::failure(QStringLiteral("No widget type \"%1\". Known types: %2")
                                   .arg(type, known.join(QStringLiteral(", "))));
    }

    int index = -1;
    XmlNode console;

    const Result opened = openConsole(sections, index, console);
    if (opened.ok == false)
        return opened;

    XmlNode *parent = nullptr;
    if (parentId.isEmpty())
    {
        /* No parent named: the top frame, which is the one the console itself
           holds. Every project has exactly one. */
        for (XmlNode &child : console.children)
        {
            if (isFrame(child))
            {
                parent = &child;
                break;
            }
        }

        if (parent == nullptr)
            return Result::failure(QStringLiteral("This console has no frame to add a widget to"));
    }
    else
    {
        parent = findWidget(console, parentId);
        if (parent == nullptr)
            return Result::failure(QStringLiteral("No widget with id %1").arg(parentId));

        if (isFrame(*parent) == false)
        {
            return Result::failure(
                QStringLiteral("Widget %1 is a %2, and only frames can hold widgets")
                    .arg(parentId, parent->name.toLower()));
        }
    }

    newId = nextFreeId(console);

    XmlNode widget = buildWidget(tag, newId);

    /* The same patch path an edit takes, so a widget cannot be created in a
       state that an edit would have refused. */
    const Result applied = applyPatch(widget, properties);
    if (applied.ok == false)
        return applied;

    /* Appended, which is where the frame writer puts its children. Inserting
       anywhere else would make QLC+'s next save reshuffle the file for no
       reason, and the point of this whole layer is diffs that mean something. */
    parent->children.append(widget);

    sections[index] = XmlTree::toXml(console);
    return Result::success();
}

VcPatch::Result VcPatch::removeWidget(QStringList &sections, const QString &widgetId,
                                      QStringList &removedIds)
{
    removedIds.clear();

    int index = -1;
    XmlNode console;

    const Result opened = openConsole(sections, index, console);
    if (opened.ok == false)
        return opened;

    const XmlNode *widget = findWidget(console, widgetId);
    if (widget == nullptr)
        return Result::failure(QStringLiteral("No widget with id %1").arg(widgetId));

    /* Collected before the removal, because a frame takes its children with it
       and the caller has cleanup of its own to do for every one of them. */
    removedIds << widgetId;
    collectWidgetIds(*widget, removedIds);

    if (removeWidgetNode(console, widgetId) == false)
        return Result::failure(QStringLiteral("Widget %1 could not be removed").arg(widgetId));

    sections[index] = XmlTree::toXml(console);
    return Result::success();
}

int VcPatch::forgetFixture(QStringList &sections, quint32 fixtureId)
{
    int index = -1;
    XmlNode console;

    if (openConsole(sections, index, console).ok == false)
        return 0;

    const int removed = purgeFixture(console, QString::number(fixtureId));

    if (removed > 0)
        sections[index] = XmlTree::toXml(console);

    return removed;
}

VcPatch::GrandMasterSettings VcPatch::readGrandMaster(const QStringList &sections)
{
    GrandMasterSettings settings;

    int index = -1;
    XmlNode console;
    if (openConsole(sections, index, console).ok == false)
        return settings;

    for (const XmlNode &child : console.children)
    {
        if (child.name != QStringLiteral("Properties"))
            continue;

        for (const XmlNode &property : child.children)
        {
            if (property.name != QStringLiteral("GrandMaster"))
                continue;

            settings.channelMode =
                property.attribute(QStringLiteral("ChannelMode"), settings.channelMode);
            settings.valueMode =
                property.attribute(QStringLiteral("ValueMode"), settings.valueMode);
            if (property.hasAttribute(QStringLiteral("Visible")))
                settings.visible = property.attribute(QStringLiteral("Visible")) != QStringLiteral("0");
        }
    }

    return settings;
}

VcPatch::Result VcPatch::writeGrandMaster(QStringList &sections,
                                          const GrandMasterSettings &settings)
{
    int index = -1;
    XmlNode console;

    const Result opened = openConsole(sections, index, console);
    if (opened.ok == false)
        return opened;

    /* Find or create <Properties>, then <GrandMaster> inside it. Created at
       the end of their parents, which is where QLC+ writes them, so its next
       save does not reshuffle the file. */
    XmlNode *properties = nullptr;
    for (XmlNode &child : console.children)
    {
        if (child.name == QStringLiteral("Properties"))
        {
            properties = &child;
            break;
        }
    }
    if (properties == nullptr)
    {
        XmlNode created;
        created.name = QStringLiteral("Properties");
        console.children.append(created);
        properties = &console.children.last();
    }

    XmlNode *master = nullptr;
    for (XmlNode &property : properties->children)
    {
        if (property.name == QStringLiteral("GrandMaster"))
        {
            master = &property;
            break;
        }
    }
    if (master == nullptr)
    {
        XmlNode created;
        created.name = QStringLiteral("GrandMaster");
        properties->children.append(created);
        master = &properties->children.last();
    }

    /* Only these three; whatever else QLC+ put on the node -- the input
       binding, the slider mode -- is not ours to rewrite. */
    master->setAttribute(QStringLiteral("ChannelMode"), settings.channelMode);
    master->setAttribute(QStringLiteral("ValueMode"), settings.valueMode);
    master->setAttribute(QStringLiteral("Visible"),
                         settings.visible ? QStringLiteral("1") : QStringLiteral("0"));

    sections[index] = XmlTree::toXml(console);
    return Result::success();
}
