/*
  OrchidLights
  docwriter.cpp

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

#include <QFileInfo>
#include <QJsonArray>
#include <QColor>
#include <QSet>
#include <functional>

#include "docwriter.h"

#include "rgbalgorithm.h"
#include "rgbtext.h"
#include "rgbimage.h"
#include "grouphead.h"
#include "qlcpoint.h"
#include "fixtureremapper.h"
#include "efxfixture.h"
#include "grouphead.h"
#include "collection.h"
#include "rgbmatrix.h"
#include "sequence.h"
#include "chaser.h"
#include "script.h"
#include "scene.h"
#include "show.h"
#include "showfunction.h"
#include "track.h"
#include "audio.h"
#include "video.h"
#include "efx.h"
#include "chaserstep.h"
#include "qlcfixturedefcache.h"
#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "fixturegroup.h"
#include "channelsgroup.h"
#include "monitorproperties.h"
#include "channelmodifier.h"
#include "qlcmodifierscache.h"
#include "grouphead.h"
#include "qlcpoint.h"
#include "fixture.h"
#include "inputoutputmap.h"
#include "outputpatch.h"
#include "universe.h"
#include "audioplugincache.h"
#include "audiorenderer.h"
#include "doc.h"

namespace
{
    /** Universes are 1-based on the wire and 0-based in the engine, and the
        conversion has exactly one place to live. Returns -1 when out of range,
        with a message that says what the range actually is. */
    int engineIndex(Doc *doc, int wireIndex, QString &error)
    {
        const int count = int(doc->inputOutputMap()->universesCount());

        if (wireIndex < 1 || wireIndex > count)
        {
            error = QStringLiteral("Universe %1 does not exist; this project has %2")
                        .arg(wireIndex)
                        .arg(count);
            return -1;
        }

        return wireIndex - 1;
    }

    /** Confirm a plugin actually offers the line being asked for, so a typo is
        refused here rather than becoming a universe that silently outputs to
        nowhere. */
    /**
     * Find a plugin line by name.
     *
     * Exact match first. A substring is accepted only when it matches exactly
     * one line: matching loosely meant an empty name hit line 0 and an
     * ambiguous one hit whichever came first, so a universe could be patched to
     * a different physical output than the one asked for and reported as
     * success. On a rig that is a wrong room going dark.
     */
    bool lineExists(const QStringList &lines, const QString &name, quint32 &index)
    {
        if (name.isEmpty())
            return false;

        for (int i = 0; i < lines.count(); i++)
        {
            if (lines.at(i) == name)
            {
                index = quint32(i);
                return true;
            }
        }

        int found = -1;
        for (int i = 0; i < lines.count(); i++)
        {
            if (lines.at(i).contains(name) == false)
                continue;
            if (found >= 0)
                return false;   // ambiguous: refuse rather than guess
            found = i;
        }

        if (found < 0)
            return false;

        index = quint32(found);
        return true;
    }
}

DocWriter::Result DocWriter::addUniverse(Doc *doc)
{
    if (doc->inputOutputMap()->addUniverse() == false)
        return Result::failure(QStringLiteral("The engine refused to add a universe"));

    doc->inputOutputMap()->startUniverses();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeUniverse(Doc *doc, int index)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    /* A fixture patched into a universe that stops existing is a fixture
       pointing at nothing. Refusing is better than leaving the project in a
       state whose only symptom is lights that do not respond. */
    for (const Fixture *fixture : doc->fixtures())
    {
        if (int(fixture->universe()) == engine)
        {
            return Result::failure(
                QStringLiteral("Universe %1 still has fixtures patched into it, starting with \"%2\"")
                    .arg(index)
                    .arg(fixture->name()));
        }
    }

    if (doc->inputOutputMap()->removeUniverse(engine) == false)
        return Result::failure(QStringLiteral("The engine refused to remove universe %1").arg(index));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::renameUniverse(Doc *doc, int index, const QString &name)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    if (name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A universe needs a name"));

    doc->inputOutputMap()->setUniverseName(engine, name);
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setPassthrough(Doc *doc, int index, bool enabled)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    doc->inputOutputMap()->setUniversePassthrough(engine, enabled);
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setOutputPatch(Doc *doc, int index, const QString &pluginName,
                                            const QString &outputName)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    InputOutputMap *map = doc->inputOutputMap();

    if (pluginName.isEmpty())
    {
        /* Clearing means clearing all of them. A universe can carry several
           output patches, and clearing only the first left the rest live --
           "unpatched" in the interface while still driving lamps. */
        for (int i = map->outputPatchesCount(quint32(engine)) - 1; i >= 0; i--)
            map->setOutputPatch(quint32(engine), QString(), QString(), QString(), 0, false, i);

        doc->setModified();
        return Result::success();
    }

    if (map->outputPluginNames().contains(pluginName) == false)
    {
        return Result::failure(QStringLiteral("No output plugin named \"%1\". Available: %2")
                                   .arg(pluginName, map->outputPluginNames().join(QStringLiteral(", "))));
    }

    const QStringList lines = map->pluginOutputs(pluginName);
    quint32 line = 0;
    if (lineExists(lines, outputName, line) == false)
    {
        return Result::failure(QStringLiteral("Plugin \"%1\" has no output \"%2\". Available: %3")
                                   .arg(pluginName, outputName, lines.join(QStringLiteral(" | "))));
    }

    if (map->setOutputPatch(quint32(engine), pluginName, QString(), lines.at(int(line)), line) == false)
        return Result::failure(QStringLiteral("The engine refused the output patch"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFeedbackPatch(Doc *doc, int index, const QString &pluginName,
                                              const QString &outputName)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    InputOutputMap *map = doc->inputOutputMap();

    if (pluginName.isEmpty())
    {
        map->setOutputPatch(quint32(engine), QString(), QString(), QString(), 0, true);
        doc->setModified();
        return Result::success();
    }

    if (map->outputPluginNames().contains(pluginName) == false)
    {
        return Result::failure(QStringLiteral("No output plugin named \"%1\". Available: %2")
                                   .arg(pluginName, map->outputPluginNames().join(QStringLiteral(", "))));
    }

    const QStringList lines = map->pluginOutputs(pluginName);
    quint32 line = 0;
    if (lineExists(lines, outputName, line) == false)
    {
        return Result::failure(QStringLiteral("Plugin \"%1\" has no output \"%2\". Available: %3")
                                   .arg(pluginName, outputName, lines.join(QStringLiteral(" | "))));
    }

    if (map->setOutputPatch(quint32(engine), pluginName, QString(), lines.at(int(line)), line,
                            true) == false)
        return Result::failure(QStringLiteral("The engine refused the feedback patch"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setInputPatch(Doc *doc, int index, const QString &pluginName,
                                           const QString &inputName, const QString &profileName)
{
    QString error;
    const int engine = engineIndex(doc, index, error);
    if (engine < 0)
        return Result::failure(error);

    InputOutputMap *map = doc->inputOutputMap();

    if (pluginName.isEmpty())
    {
        map->setInputPatch(quint32(engine), QString(), QString(), QString(), 0, profileName);
        doc->setModified();
        return Result::success();
    }

    if (map->inputPluginNames().contains(pluginName) == false)
    {
        return Result::failure(QStringLiteral("No input plugin named \"%1\". Available: %2")
                                   .arg(pluginName, map->inputPluginNames().join(QStringLiteral(", "))));
    }

    const QStringList lines = map->pluginInputs(pluginName);
    quint32 line = 0;
    if (lineExists(lines, inputName, line) == false)
    {
        return Result::failure(QStringLiteral("Plugin \"%1\" has no input \"%2\". Available: %3")
                                   .arg(pluginName, inputName, lines.join(QStringLiteral(" | "))));
    }

    if (profileName.isEmpty() == false
        && map->profileNames().contains(profileName) == false)
    {
        return Result::failure(QStringLiteral("No input profile named \"%1\"").arg(profileName));
    }

    if (map->setInputPatch(quint32(engine), pluginName, QString(), lines.at(int(line)), line,
                           profileName) == false)
    {
        return Result::failure(QStringLiteral("The engine refused the input patch"));
    }

    doc->setModified();
    return Result::success();
}


/*****************************************************************************
 * Fixtures
 *****************************************************************************/

namespace
{
    /** Channels already taken in a universe, ignoring one fixture so that
        moving a fixture does not collide with where it currently is. */
    QSet<int> occupiedChannels(Doc *doc, int universe, quint32 ignoreFixture)
    {
        QSet<int> taken;

        for (const Fixture *fixture : doc->fixtures())
        {
            if (fixture->id() == ignoreFixture)
                continue;
            if (int(fixture->universe()) != universe)
                continue;

            for (quint32 i = 0; i < fixture->channels(); i++)
                taken.insert(int(fixture->address() + i));
        }

        return taken;
    }

    /** Name of whatever occupies a channel, for an error worth reading. */
    QString occupantAt(Doc *doc, int universe, int channel, quint32 ignoreFixture)
    {
        for (const Fixture *fixture : doc->fixtures())
        {
            if (fixture->id() == ignoreFixture || int(fixture->universe()) != universe)
                continue;

            const int start = int(fixture->address());
            if (channel >= start && channel < start + int(fixture->channels()))
                return fixture->name();
        }

        return QString();
    }
}

DocWriter::Result DocWriter::addFixtures(Doc *doc, const FixturePlacement &placement,
                                         QList<quint32> &ids)
{
    ids.clear();

    QString error;
    const int universe = engineIndex(doc, placement.universe, error);
    if (universe < 0)
        return Result::failure(error);

    if (placement.quantity < 1 || placement.quantity > 512)
        return Result::failure(QStringLiteral("Quantity must be between 1 and 512"));
    if (placement.address < 1 || placement.address > 512)
        return Result::failure(QStringLiteral("Address must be between 1 and 512"));
    if (placement.gap < 0 || placement.gap > 512)
        return Result::failure(QStringLiteral("Gap must be between 0 and 512"));

    QLCFixtureDef *definition =
        doc->fixtureDefCache()->fixtureDef(placement.manufacturer, placement.model);
    if (definition == nullptr)
    {
        return Result::failure(QStringLiteral("No fixture definition for \"%1 %2\"")
                                   .arg(placement.manufacturer, placement.model));
    }

    QLCFixtureMode *mode = definition->mode(placement.mode);
    if (mode == nullptr)
    {
        QStringList available;
        for (const QLCFixtureMode *candidate : definition->modes())
            available << candidate->name();

        return Result::failure(QStringLiteral("\"%1 %2\" has no mode \"%3\". Available: %4")
                                   .arg(placement.manufacturer, placement.model, placement.mode,
                                        available.join(QStringLiteral(", "))));
    }

    const int channels = mode->channels().count();
    if (channels <= 0)
        return Result::failure(QStringLiteral("That mode has no channels"));

    /* Check the whole batch before placing any of it. A half-applied patch
       leaves the operator with some fixtures placed and no clear idea which. */
    const QSet<int> taken = occupiedChannels(doc, universe, Fixture::invalidId());
    const int stride = channels + placement.gap;

    for (int i = 0; i < placement.quantity; i++)
    {
        const int start = (placement.address - 1) + (i * stride);

        if (start + channels > 512)
        {
            return Result::failure(
                QStringLiteral("Fixture %1 of %2 would end at channel %3, past the end of the universe")
                    .arg(i + 1).arg(placement.quantity).arg(start + channels));
        }

        for (int c = start; c < start + channels; c++)
        {
            if (taken.contains(c))
            {
                const QString occupant = occupantAt(doc, universe, c, Fixture::invalidId());
                return Result::failure(
                    QStringLiteral("Channel %1 of universe %2 is already used by \"%3\"")
                        .arg(c + 1).arg(placement.universe).arg(occupant));
            }
        }
    }

    for (int i = 0; i < placement.quantity; i++)
    {
        Fixture *fixture = new Fixture(doc);
        fixture->setFixtureDefinition(definition, mode);
        fixture->setUniverse(quint32(universe));
        fixture->setAddress(quint32((placement.address - 1) + (i * stride)));

        const QString base = placement.name.isEmpty() ? placement.model : placement.name;
        fixture->setName(placement.quantity > 1 ? QStringLiteral("%1 #%2").arg(base).arg(i + 1)
                                                : base);

        if (doc->addFixture(fixture) == false)
        {
            delete fixture;
            return Result::failure(
                QStringLiteral("The engine refused fixture %1 of %2").arg(i + 1).arg(placement.quantity));
        }

        ids.append(fixture->id());
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::cloneFixtures(Doc *doc, quint32 sourceId, int quantity, int gap,
                                           QList<quint32> &ids)
{
    ids.clear();

    Fixture *source = doc->fixture(sourceId);
    if (source == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(sourceId));

    QLCFixtureDef *definition = source->fixtureDef();
    QLCFixtureMode *mode = source->fixtureMode();
    if (definition == nullptr || mode == nullptr)
    {
        return Result::failure(
            QStringLiteral("\"%1\" has no resolved definition; a copy of a placeholder "
                           "would only be a second placeholder").arg(source->name()));
    }

    if (quantity < 1 || quantity > 512)
        return Result::failure(QStringLiteral("Quantity must be between 1 and 512"));
    if (gap < 0 || gap > 512)
        return Result::failure(QStringLiteral("Gap must be between 0 and 512"));

    const int channels = int(source->channels());
    const int stride = channels + gap;
    const int universe = int(source->universe());

    /* The first run of channels that holds the whole batch, searched from right
       after the original and wrapping to the top of the universe. Chosen here
       rather than asked for: the point of duplicating is not having to work an
       address out. */
    const QSet<int> taken = occupiedChannels(doc, universe, Fixture::invalidId());

    const auto fits = [&](int start) {
        const int span = quantity * stride - gap;
        if (start < 0 || start + span > 512)
            return false;
        for (int i = 0; i < quantity; i++)
            for (int c = start + i * stride; c < start + i * stride + channels; c++)
                if (taken.contains(c))
                    return false;
        return true;
    };

    int start = -1;
    const int preferred = int(source->address()) + channels;
    for (int candidate = preferred; candidate <= 512 - channels; candidate++)
    {
        if (fits(candidate))
        {
            start = candidate;
            break;
        }
    }
    for (int candidate = 0; start < 0 && candidate < preferred; candidate++)
    {
        if (fits(candidate))
            start = candidate;
    }

    if (start < 0)
    {
        return Result::failure(
            QStringLiteral("Universe %1 has no run of %2 free channels for %3 %4")
                .arg(universe + 1).arg(quantity * stride - gap).arg(quantity)
                .arg(quantity == 1 ? QStringLiteral("copy") : QStringLiteral("copies")));
    }

    for (int i = 0; i < quantity; i++)
    {
        Fixture *fixture = new Fixture(doc);
        fixture->setFixtureDefinition(definition, mode);
        fixture->setUniverse(quint32(universe));
        fixture->setAddress(quint32(start + i * stride));
        fixture->setName(quantity > 1
                             ? QStringLiteral("%1 (copia %2)").arg(source->name()).arg(i + 1)
                             : QStringLiteral("%1 (copia)").arg(source->name()));

        /* The modifiers belong to the patch: a duplicate whose dimmer bends
           differently from the original is not a duplicate. */
        for (quint32 c = 0; c < source->channels(); c++)
        {
            ChannelModifier *modifier = source->channelModifier(c);
            if (modifier != nullptr)
                fixture->setChannelModifier(c, modifier);
        }

        if (doc->addFixture(fixture) == false)
        {
            delete fixture;
            return Result::failure(
                QStringLiteral("The engine refused copy %1 of %2").arg(i + 1).arg(quantity));
        }

        ids.append(fixture->id());
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::addRgbPanel(Doc *doc, const PanelSpec &spec, quint32 &groupId,
                                         QList<quint32> &ids)
{
    ids.clear();

    if (spec.name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A panel needs a name"));
    if (spec.rows < 1 || spec.columns < 1 || spec.rows > 64 || spec.columns > 64)
        return Result::failure(QStringLiteral("Rows and columns must be between 1 and 64"));
    if (spec.address < 1 || spec.address > 512)
        return Result::failure(QStringLiteral("Address must be between 1 and 512"));

    QString error;
    int uniIndex = engineIndex(doc, spec.universe, error);
    if (uniIndex < 0)
        return Result::failure(error);

    const QStringList corners{QStringLiteral("topleft"), QStringLiteral("topright"),
                              QStringLiteral("bottomleft"), QStringLiteral("bottomright")};
    if (corners.contains(spec.startCorner) == false)
        return Result::failure(QStringLiteral("startCorner is topleft, topright, bottomleft or bottomright"));
    if (spec.displacement != QStringLiteral("snake") && spec.displacement != QStringLiteral("zigzag"))
        return Result::failure(QStringLiteral("displacement is snake or zigzag"));
    if (spec.direction != QStringLiteral("horizontal") && spec.direction != QStringLiteral("vertical"))
        return Result::failure(QStringLiteral("direction is horizontal or vertical"));

    const bool sixteenBit = spec.sixteenBit;
    const QMap<QString, Fixture::Components> componentNames{
        {QStringLiteral("RGB"), Fixture::RGB},   {QStringLiteral("BGR"), Fixture::BGR},
        {QStringLiteral("BRG"), Fixture::BRG},   {QStringLiteral("GBR"), Fixture::GBR},
        {QStringLiteral("GRB"), Fixture::GRB},   {QStringLiteral("RBG"), Fixture::RBG},
        {QStringLiteral("RGBW"), Fixture::RGBW},
    };
    if (componentNames.contains(spec.components) == false)
    {
        return Result::failure(QStringLiteral("components is one of %1")
                                   .arg(componentNames.keys().join(QStringLiteral(", "))));
    }
    const Fixture::Components components = componentNames.value(spec.components);

    /* The reference's walk, verbatim (qmlui/fixturemanager.cpp:1563): vertical
       panels transpose the grid, the start corner decides where row zero and
       cell zero sit, snake rows double back. */
    int rows = spec.rows;
    int columns = spec.columns;
    const bool transpose = spec.direction == QStringLiteral("vertical");
    if (transpose)
        qSwap(rows, columns);

    const bool fromRight = transpose
        ? (spec.startCorner == QStringLiteral("bottomright")
           || spec.startCorner == QStringLiteral("bottomleft"))
        : (spec.startCorner == QStringLiteral("topright")
           || spec.startCorner == QStringLiteral("bottomright"));
    const bool fromBottom = transpose
        ? (spec.startCorner == QStringLiteral("topright")
           || spec.startCorner == QStringLiteral("bottomright"))
        : (spec.startCorner == QStringLiteral("bottomleft")
           || spec.startCorner == QStringLiteral("bottomright"));

    int currRow = fromBottom ? rows - 1 : 0;
    const int rowInc = fromBottom ? -1 : 1;
    const int xPosStart = fromRight ? columns - 1 : 0;
    const int xPosEnd = fromRight ? 0 : columns - 1;
    const int xPosInc = fromRight ? -1 : 1;

    FixtureGroup *group = new FixtureGroup(doc);
    group->setName(spec.name.trimmed());
    group->setSize(QSize(spec.columns, spec.rows));
    if (doc->addFixtureGroup(group) == false)
    {
        delete group;
        return Result::failure(QStringLiteral("The engine refused the panel's group"));
    }
    groupId = group->id();

    QLCFixtureDef *rowDef = nullptr;
    QLCFixtureMode *rowMode = nullptr;
    int address = spec.address;

    for (int i = 0; i < rows; i++)
    {
        Fixture *fixture = new Fixture(doc);
        fixture->setName(QStringLiteral("%1 - Fila %2").arg(spec.name.trimmed()).arg(i + 1));
        if (rowDef == nullptr)
            rowDef = fixture->genericRGBPanelDef(columns, components, sixteenBit);
        if (rowMode == nullptr)
        {
            rowMode = fixture->genericRGBPanelMode(rowDef, components, sixteenBit,
                                                   spec.physicalWidth,
                                                   spec.physicalHeight / qreal(spec.rows));
        }
        fixture->setFixtureDefinition(rowDef, rowMode);

        /* A row that will not fit spills into the next universe, adding one if
           the project runs out -- the reference does exactly this, and a 30x30
           panel genuinely needs it. */
        if (address - 1 + int(fixture->channels()) > 512)
        {
            uniIndex++;
            if (doc->inputOutputMap()->getUniverseID(uniIndex)
                == doc->inputOutputMap()->invalidUniverse())
            {
                doc->inputOutputMap()->addUniverse();
                doc->inputOutputMap()->startUniverses();
            }
            address = 1;
        }

        fixture->setUniverse(doc->inputOutputMap()->getUniverseID(uniIndex));
        fixture->setAddress(quint32(address - 1));
        address += int(fixture->channels());

        if (doc->addFixture(fixture) == false)
        {
            delete fixture;
            return Result::failure(
                QStringLiteral("Row %1 would not patch (address %2 of universe %3 is taken)")
                    .arg(i + 1).arg(address).arg(uniIndex + 1));
        }
        ids.append(fixture->id());

        const bool doubledBack = spec.displacement == QStringLiteral("snake") && (i % 2) == 1;
        int xPos = doubledBack ? xPosEnd : xPosStart;
        const int step = doubledBack ? -xPosInc : xPosInc;
        for (int h = 0; h < fixture->heads(); h++)
        {
            if (transpose)
                group->assignHead(QLCPoint(currRow, xPos), GroupHead(fixture->id(), h));
            else
                group->assignHead(QLCPoint(xPos, currRow), GroupHead(fixture->id(), h));
            xPos += step;
        }

        currRow += rowInc;
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::remapFixture(Doc *doc, quint32 sourceId, const RemapSpec &spec,
                                          QList<SceneValue> &fromChannels,
                                          QList<SceneValue> &toChannels)
{
    fromChannels.clear();
    toChannels.clear();

    Fixture *source = doc->fixture(sourceId);
    if (source == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(sourceId));

    QLCFixtureDef *definition =
        doc->fixtureDefCache()->fixtureDef(spec.manufacturer, spec.model);
    if (definition == nullptr)
    {
        return Result::failure(QStringLiteral("No fixture definition for \"%1 %2\"")
                                   .arg(spec.manufacturer, spec.model));
    }
    QLCFixtureMode *mode = definition->mode(spec.mode);
    if (mode == nullptr)
    {
        QStringList available;
        for (const QLCFixtureMode *candidate : definition->modes())
            available << candidate->name();
        return Result::failure(QStringLiteral("\"%1 %2\" has no mode \"%3\". Available: %4")
                                   .arg(spec.manufacturer, spec.model, spec.mode,
                                        available.join(QStringLiteral(", "))));
    }

    QString error;
    const int universe = spec.universe > 0 ? engineIndex(doc, spec.universe, error)
                                           : int(source->universe());
    if (universe < 0)
        return Result::failure(error);
    const int address = spec.address > 0 ? spec.address - 1 : int(source->address());
    const int channels = mode->channels().count();

    if (address < 0 || address + channels > 512)
    {
        return Result::failure(QStringLiteral("\"%1\" needs %2 channels and would end at %3")
                                   .arg(spec.model).arg(channels).arg(address + channels));
    }

    /* Overlap against everyone but the fixture being replaced. */
    const QSet<int> taken = occupiedChannels(doc, universe, sourceId);
    for (int c = address; c < address + channels; c++)
    {
        if (taken.contains(c))
        {
            return Result::failure(
                QStringLiteral("Channel %1 of universe %2 is already used by \"%3\"")
                    .arg(c + 1).arg(universe + 1)
                    .arg(occupantAt(doc, universe, c, sourceId)));
        }
    }

    /* One target per existing fixture, every one KEEPING ITS ID.
     *
     * remapSceneValues drops any value it has no mapping for, so the untouched
     * fixtures need identity maps or a remap of one lamp would silently strip
     * every other lamp out of every scene. */
    FixtureRemapper remapper;
    QList<Fixture *> targets;
    bool connected = true;

    for (Fixture *original : doc->fixtures())
    {
        Fixture *target = new Fixture(doc);
        target->setID(original->id());

        if (original->id() == sourceId)
        {
            target->setName(spec.name.isEmpty() ? original->name() : spec.name);
            target->setUniverse(quint32(universe));
            target->setAddress(quint32(address));
            target->setFixtureDefinition(definition, mode);
        }
        else
        {
            target->setName(original->name());
            target->setUniverse(original->universe());
            target->setAddress(original->address());
            if (original->fixtureDef() == nullptr || original->fixtureMode() == nullptr)
                target->setChannels(original->channels());
            else
                target->setFixtureDefinition(original->fixtureDef(), original->fixtureMode());
        }

        if (remapper.autoConnectFixtures(original, target).isEmpty() && original->id() == sourceId)
            connected = false;

        targets.append(target);
    }

    if (connected == false)
    {
        qDeleteAll(targets);
        return Result::failure(
            QStringLiteral("No channel of \"%1 %2\" matches anything \"%3\" controls; a remap "
                           "that carries nothing across is a delete wearing a different name")
                .arg(spec.manufacturer, spec.model, source->name()));
    }

    remapper.applyRemap(doc, targets);

    fromChannels = remapper.sourceList();
    toChannels = remapper.targetList();

    /* replaceFixtures copied them into the document; these were the blueprint. */
    qDeleteAll(targets);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeFixture(Doc *doc, quint32 fixtureId)
{
    const Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    const QString name = fixture->name();

    /* Zero the channels first. A fixture removed while its lamps are lit leaves
       the last values latched in the universe buffer with nothing left to
       change them: the light stays on and no control in the show can turn it
       off. */
    const quint32 universe = fixture->universe();
    const quint32 address = fixture->address();
    const quint32 channels = fixture->channels();

    QList<Universe *> universes = doc->inputOutputMap()->claimUniverses();
    if (int(universe) < universes.count())
    {
        Universe *target = universes.at(int(universe));
        for (quint32 i = 0; i < channels; i++)
            target->write(int(address + i), 0, true);
    }
    doc->inputOutputMap()->releaseUniverses(true);

    if (doc->deleteFixture(fixtureId) == false)
        return Result::failure(QStringLiteral("The engine refused to delete \"%1\"").arg(name));

    /* The console may still name this fixture, in a slider's channel list or an
       XY pad's heads. That is not cleaned up here, because this writer only
       knows about Doc -- the caller does it, with VcPatch::forgetFixture, over
       the preserved XML.
     *
     * It does have to happen, though. QLC+ tolerates the dangling reference and
       drops the channel on load, but Doc hands out the lowest free id: a later
       fixture inherits this one's id, and with it whatever the console still
       had pointed at it. */

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::updateFixture(Doc *doc, quint32 fixtureId, const QString &name,
                                           int universe, int address)
{
    Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    int targetUniverse = int(fixture->universe());
    if (universe > 0)
    {
        QString error;
        targetUniverse = engineIndex(doc, universe, error);
        if (targetUniverse < 0)
            return Result::failure(error);
    }

    const int targetAddress = address > 0 ? address - 1 : int(fixture->address());
    const int channels = int(fixture->channels());

    if (targetAddress + channels > 512)
    {
        return Result::failure(QStringLiteral("\"%1\" needs %2 channels and would end at %3")
                                   .arg(fixture->name()).arg(channels).arg(targetAddress + channels));
    }

    /* Ignoring itself, so nudging a fixture does not collide with where it
       already is. */
    const QSet<int> taken = occupiedChannels(doc, targetUniverse, fixtureId);
    for (int c = targetAddress; c < targetAddress + channels; c++)
    {
        if (taken.contains(c))
        {
            return Result::failure(QStringLiteral("Channel %1 of universe %2 is already used by \"%3\"")
                                       .arg(c + 1)
                                       .arg(targetUniverse + 1)
                                       .arg(occupantAt(doc, targetUniverse, c, fixtureId)));
        }
    }

    /* Signals blocked across the move, exactly as QLC+ does it
       (qmlui/fixturemanager.cpp:1889, ui/src/fixturemanager.cpp:1608).
     *
     * setUniverse() and setAddress() each emit Fixture::changed(), and
     * Doc::slotFixtureChanged() rebuilds its address book from whatever state
     * it finds. Between the two calls the fixture sits at the NEW universe and
     * the OLD address -- a position nothing validated. Doc asserts on the
     * collision in a debug build and takes the daemon down; in release it
     * silently reassigns the victim's channels and then unregisters it, so the
     * overlap check stops seeing a fixture that is still there.
     *
     * One setID() at the end publishes the finished position, once. */
    fixture->blockSignals(true);
    if (name.isEmpty() == false)
        fixture->setName(name);
    fixture->setUniverse(quint32(targetUniverse));
    fixture->setAddress(quint32(targetAddress));
    fixture->blockSignals(false);

    fixture->setID(fixture->id());

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * Fixture groups
 *****************************************************************************/

DocWriter::Result DocWriter::addFixtureGroup(Doc *doc, const QString &name,
                                             const QList<quint32> &fixtureIds, quint32 &groupId)
{
    if (name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A group needs a name"));

    for (quint32 id : fixtureIds)
    {
        if (doc->fixture(id) == nullptr)
            return Result::failure(QStringLiteral("No fixture with id %1").arg(id));
    }

    FixtureGroup *group = new FixtureGroup(doc);
    group->setName(name);

    if (doc->addFixtureGroup(group) == false)
    {
        delete group;
        return Result::failure(QStringLiteral("The engine refused the group"));
    }

    /* Size before placement: assignFixture() drops heads that fall outside the
       grid, so a group left at its default size kept only the first one and
       saved as 1x1 with everything else gone. */
    group->setSize(QSize(qMax(1, fixtureIds.count()), 1));

    int x = 0;
    for (quint32 id : fixtureIds)
        group->assignFixture(id, QLCPoint(x++, 0));

    groupId = group->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::renameFixtureGroup(Doc *doc, quint32 groupId, const QString &name)
{
    FixtureGroup *group = doc->fixtureGroup(groupId);
    if (group == nullptr)
        return Result::failure(QStringLiteral("No fixture group with id %1").arg(groupId));
    if (name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A group needs a name"));

    group->setName(name.trimmed());
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFixtureGroupGrid(Doc *doc, quint32 groupId, int width, int height,
                                                 const QList<GroupCell> &cells)
{
    FixtureGroup *group = doc->fixtureGroup(groupId);
    if (group == nullptr)
        return Result::failure(QStringLiteral("No fixture group with id %1").arg(groupId));

    if (width < 1 || height < 1 || width > 64 || height > 64)
        return Result::failure(QStringLiteral("The grid must be between 1x1 and 64x64"));

    /* Check the whole layout before touching the group: cells in bounds, every
       fixture real, every head real, no two heads in one cell and no head in
       two cells. A half-applied grid is a matrix that snakes wrong with no way
       to see why. */
    QSet<QPair<int, int>> seenCells;
    QSet<QPair<quint32, int>> seenHeads;
    for (const GroupCell &cell : cells)
    {
        if (cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= height)
        {
            return Result::failure(QStringLiteral("Cell (%1,%2) falls outside a %3x%4 grid")
                                       .arg(cell.x).arg(cell.y).arg(width).arg(height));
        }

        const Fixture *fixture = doc->fixture(cell.fixture);
        if (fixture == nullptr)
            return Result::failure(QStringLiteral("No fixture with id %1").arg(cell.fixture));
        if (cell.head < 0 || cell.head >= fixture->heads())
        {
            return Result::failure(QStringLiteral("\"%1\" has no head %2")
                                       .arg(fixture->name()).arg(cell.head));
        }

        if (seenCells.contains({cell.x, cell.y}))
            return Result::failure(QStringLiteral("Cell (%1,%2) is named twice")
                                       .arg(cell.x).arg(cell.y));
        seenCells.insert({cell.x, cell.y});

        if (seenHeads.contains({cell.fixture, cell.head}))
        {
            return Result::failure(QStringLiteral("Head %1 of fixture %2 is placed twice")
                                       .arg(cell.head).arg(cell.fixture));
        }
        seenHeads.insert({cell.fixture, cell.head});
    }

    const QList<QLCPoint> occupied = group->headsMap().keys();
    for (const QLCPoint &point : occupied)
        group->resignHead(point);

    group->setSize(QSize(width, height));
    for (const GroupCell &cell : cells)
        group->assignHead(QLCPoint(cell.x, cell.y), GroupHead(cell.fixture, cell.head));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::transformFixtureGroup(Doc *doc, quint32 groupId, const QString &op)
{
    FixtureGroup *group = doc->fixtureGroup(groupId);
    if (group == nullptr)
        return Result::failure(QStringLiteral("No fixture group with id %1").arg(groupId));

    const int w = group->size().width();
    const int h = group->size().height();
    const QMap<QLCPoint, GroupHead> heads = group->headsMap();

    QSize size(w, h);
    std::function<QLCPoint(const QLCPoint &)> map;

    if (op == QStringLiteral("rotate90"))
    {
        size = QSize(h, w);
        map = [h](const QLCPoint &p) { return QLCPoint(h - 1 - p.y(), p.x()); };
    }
    else if (op == QStringLiteral("rotate180"))
    {
        map = [w, h](const QLCPoint &p) { return QLCPoint(w - 1 - p.x(), h - 1 - p.y()); };
    }
    else if (op == QStringLiteral("rotate270"))
    {
        size = QSize(h, w);
        map = [w](const QLCPoint &p) { return QLCPoint(p.y(), w - 1 - p.x()); };
    }
    else if (op == QStringLiteral("flipH"))
    {
        map = [w](const QLCPoint &p) { return QLCPoint(w - 1 - p.x(), p.y()); };
    }
    else if (op == QStringLiteral("flipV"))
    {
        map = [h](const QLCPoint &p) { return QLCPoint(p.x(), h - 1 - p.y()); };
    }
    else
    {
        return Result::failure(QStringLiteral(
            "\"%1\" is not a transformation. Use rotate90, rotate180, rotate270, flipH or flipV")
                                   .arg(op));
    }

    for (auto it = heads.constBegin(); it != heads.constEnd(); ++it)
        group->resignHead(it.key());

    group->setSize(size);
    for (auto it = heads.constBegin(); it != heads.constEnd(); ++it)
        group->assignHead(map(it.key()), it.value());

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeFixtureGroup(Doc *doc, quint32 groupId)
{
    if (doc->fixtureGroup(groupId) == nullptr)
        return Result::failure(QStringLiteral("No fixture group with id %1").arg(groupId));

    if (doc->deleteFixtureGroup(groupId) == false)
        return Result::failure(QStringLiteral("The engine refused to delete the group"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFixtureGroupMembers(Doc *doc, quint32 groupId,
                                                    const QList<quint32> &fixtureIds)
{
    FixtureGroup *group = doc->fixtureGroup(groupId);
    if (group == nullptr)
        return Result::failure(QStringLiteral("No fixture group with id %1").arg(groupId));

    for (quint32 id : fixtureIds)
    {
        if (doc->fixture(id) == nullptr)
            return Result::failure(QStringLiteral("No fixture with id %1").arg(id));
    }

    /* Keep whatever grid the group already had, and keep every fixture that is
       staying exactly where the operator put it.
     *
     * Re-laying the whole group as one row destroyed the 2D arrangement of a
     * group built in QLC+ -- and for a matrix of pixel bars that arrangement is
     * not decoration, it is what makes an RGB matrix run across the right
     * fixtures in the right order. */
    const QSet<quint32> wanted(fixtureIds.begin(), fixtureIds.end());
    const QList<quint32> existing = group->fixtureList();

    for (quint32 id : existing)
    {
        if (wanted.contains(id) == false)
            group->resignFixture(id);
    }

    QList<quint32> added;
    for (quint32 id : fixtureIds)
    {
        if (existing.contains(id) == false)
            added.append(id);
    }

    if (added.isEmpty() == false)
    {
        /* New members go after the existing grid rather than into it. */
        const QSize size = group->size();
        group->setSize(QSize(qMax(1, size.width()), size.height() + 1));

        int x = 0;
        const int row = size.height();
        for (quint32 id : added)
            group->assignFixture(id, QLCPoint(x++, row));
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setChannelModifiers(Doc *doc, quint32 fixtureId,
                                                 const QMap<quint32, QString> &byChannel)
{
    Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    /* Everything resolved before anything is attached: half a map applied is a
       patch nobody asked for and nobody can see. */
    QMap<quint32, ChannelModifier *> resolved;

    for (auto it = byChannel.constBegin(); it != byChannel.constEnd(); ++it)
    {
        if (it.key() >= fixture->channels())
        {
            return Result::failure(QStringLiteral("\"%1\" has %2 channels, so it has no channel %3")
                                       .arg(fixture->name())
                                       .arg(fixture->channels())
                                       .arg(it.key()));
        }

        if (it.value().isEmpty())
            continue;

        ChannelModifier *modifier = doc->modifiersCache()->modifier(it.value());
        if (modifier == nullptr)
        {
            return Result::failure(QStringLiteral("No channel modifier named \"%1\"")
                                       .arg(it.value()));
        }

        resolved.insert(it.key(), modifier);
    }

    const QList<Universe *> universes = doc->inputOutputMap()->universes();
    if (int(fixture->universe()) >= universes.count())
    {
        return Result::failure(QStringLiteral("\"%1\" is patched to universe %2, which no longer "
                                              "exists")
                                   .arg(fixture->name())
                                   .arg(fixture->universe() + 1));
    }

    /* Attached here rather than through Doc::updateFixtureChannelCapabilities,
       which is what the desktop calls and which does far more than this asks
       for: it re-applies every channel's *default* value on the way past. Using
       it would drop the rest of the fixture to its defaults because one channel
       got a curve, and on a rig holding a look that is a lamp going out for no
       reason the operator can see. */
    QList<Universe *> claimed = doc->inputOutputMap()->claimUniverses();
    Universe *universe = claimed.at(int(fixture->universe()));
    const quint32 address = fixture->address();

    for (quint32 i = 0; i < fixture->channels(); i++)
    {
        ChannelModifier *modifier = resolved.value(i, nullptr);

        /* Both halves. The fixture keeps it because that is what gets saved;
           the universe gets it because that is what applies it. One without the
           other works until the project is reloaded, or only until it is.

           Universe::setChannelModifier recomputes the channel on its way out,
           which is what makes a curve reach a latched value straight away: a
           channel a fader or a running function holds is written every tick and
           would pick it up anyway, but one left sitting at a value is written
           by nobody, and would stay uncurved for as long as the look was up. */
        fixture->setChannelModifier(i, modifier);
        universe->setChannelModifier(ushort(address + i), modifier);
    }

    doc->inputOutputMap()->releaseUniverses(true);

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * The plan
 *****************************************************************************/

DocWriter::Result DocWriter::setPlanItem(Doc *doc, quint32 fixtureId, int head, int linked,
                                         const PlanItemPatch &patch)
{
    const Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    if (head < 0 || head >= fixture->heads())
    {
        return Result::failure(QStringLiteral("\"%1\" has %2 %3; there is no head %4")
                                   .arg(fixture->name()).arg(fixture->heads())
                                   .arg(fixture->heads() == 1 ? QStringLiteral("head")
                                                              : QStringLiteral("heads"))
                                   .arg(head));
    }
    if (linked < 0)
        return Result::failure(QStringLiteral("A linked index cannot be negative"));

    MonitorProperties *monitor = doc->monitorProperties();
    const quint16 h = quint16(head);
    const quint16 l = quint16(linked);

    QColor colour;
    if (patch.gel != nullptr && patch.gel->isEmpty() == false)
    {
        colour = QColor(*patch.gel);
        if (colour.isValid() == false)
            return Result::failure(QStringLiteral("\"%1\" is not a colour").arg(*patch.gel));
    }

    if (patch.zoom != nullptr && (*patch.zoom < 0 || *patch.zoom > 180))
        return Result::failure(QStringLiteral("Zoom is a beam width in degrees, 0 to 180"));

    /* Whatever it had, so a request that moves a lamp does not also throw away
       the gel somebody set on it. */
    const QVector3D was = monitor->fixturePosition(fixtureId, h, l);
    const QVector3D turned = monitor->fixtureRotation(fixtureId, h, l);

    const QVector3D position(patch.x != nullptr ? float(*patch.x) : was.x(),
                             patch.y != nullptr ? float(*patch.y) : was.y(),
                             was.z());

    monitor->setFixturePosition(fixtureId, h, l, position);

    if (patch.rotation != nullptr)
        monitor->setFixtureRotation(fixtureId, h, l,
                                    QVector3D(turned.x(), float(*patch.rotation), turned.z()));

    if (patch.gel != nullptr)
        monitor->setFixtureGelColor(fixtureId, h, l, colour);

    if (patch.zoom != nullptr)
        monitor->setFixtureFixedZoom(fixtureId, h, l, *patch.zoom);

    /* The four flags QLC+ hangs off a plan item, read-modify-write so setting
       one never clears another. */
    quint32 flags = monitor->fixtureFlags(fixtureId, h, l);
    const auto apply = [&flags](const bool *value, quint32 bit) {
        if (value == nullptr)
            return;
        if (*value)
            flags |= bit;
        else
            flags &= ~bit;
    };
    apply(patch.hidden, MonitorProperties::HiddenFlag);
    apply(patch.locked, MonitorProperties::LockedFlag);
    apply(patch.invertPan, MonitorProperties::InvertedPanFlag);
    apply(patch.invertTilt, MonitorProperties::InvertedTiltFlag);
    monitor->setFixtureFlags(fixtureId, h, l, flags);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::addLinkedFixture(Doc *doc, quint32 fixtureId, int head,
                                              const QString &name, double x, double y,
                                              int &linkedIndex)
{
    const Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));
    if (head < 0 || head >= fixture->heads())
        return Result::failure(QStringLiteral("\"%1\" has no head %2").arg(fixture->name()).arg(head));

    MonitorProperties *monitor = doc->monitorProperties();

    /* The original must stand somewhere first: a link to a lamp that is not
       on the plan would be a copy of nowhere. */
    if (monitor->containsFixture(fixtureId) == false)
        return Result::failure(QStringLiteral("Place \"%1\" on the plan first").arg(fixture->name()));

    int next = 1;
    for (quint32 subID : monitor->fixtureIDList(fixtureId))
    {
        if (monitor->fixtureHeadIndex(subID) != quint16(head))
            continue;
        next = qMax(next, int(monitor->fixtureLinkedIndex(subID)) + 1);
    }

    const QString label = name.trimmed().isEmpty()
        ? QStringLiteral("%1 (enlazada %2)").arg(fixture->name()).arg(next)
        : name.trimmed();

    monitor->setFixtureName(fixtureId, quint16(head), quint16(next), label);
    monitor->setFixturePosition(fixtureId, quint16(head), quint16(next),
                                QVector3D(float(x), float(y), 0));

    linkedIndex = next;
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeLinkedFixture(Doc *doc, quint32 fixtureId, int head, int linked)
{
    if (doc->fixture(fixtureId) == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));
    if (linked < 1)
    {
        return Result::failure(QStringLiteral(
            "Linked index 0 is the fixture itself; taking it off the plan is DELETE without \"linked\""));
    }

    MonitorProperties *monitor = doc->monitorProperties();
    bool found = false;
    for (quint32 subID : monitor->fixtureIDList(fixtureId))
    {
        if (monitor->fixtureHeadIndex(subID) == quint16(head)
            && monitor->fixtureLinkedIndex(subID) == quint16(linked))
        {
            found = true;
            break;
        }
    }
    if (found == false)
        return Result::failure(QStringLiteral("No linked item %1 on head %2").arg(linked).arg(head));

    monitor->removeFixture(fixtureId, quint16(head), quint16(linked));
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::clearPlanPosition(Doc *doc, quint32 fixtureId)
{
    if (doc->fixture(fixtureId) == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    MonitorProperties *monitor = doc->monitorProperties();
    if (monitor->containsFixture(fixtureId) == false)
        return Result::failure(QStringLiteral("That fixture is not on the plan"));

    monitor->removeFixture(fixtureId, 0, 0);

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * Shows: the multi-track timeline
 *****************************************************************************/

namespace
{
    /** The show with this id, or nullptr with a reason set. */
    Show *showById(Doc *doc, quint32 showId, QString &error)
    {
        Function *function = doc->function(showId);
        if (function == nullptr || function->type() != Function::ShowType)
        {
            error = QStringLiteral("No show with id %1").arg(showId);
            return nullptr;
        }

        return qobject_cast<Show *>(function);
    }

    /**
     * What a track will accept.
     *
     * The desktop's own filter (ui/src/showmanager/showmanager.cpp:610): scenes,
     * chasers, sequences, audio, video, matrices and EFX in; shows, scripts and
     * collections out. The reasons differ and both matter -- a show inside a
     * show is a loop the runner walks into, while a script or a collection has
     * no duration at all, so there is no bar to draw and no end to stop it at.
     */
    bool placeable(Function::Type type)
    {
        switch (type)
        {
        case Function::SceneType:
        case Function::ChaserType:
        case Function::SequenceType:
        case Function::AudioType:
        case Function::VideoType:
        case Function::RGBMatrixType:
        case Function::EFXType:
            return true;
        default:
            return false;
        }
    }

    /** The track carrying this item, or nullptr. */
    Track *trackOf(Show *show, quint32 itemId)
    {
        return show->getTrackFromShowFunctionID(itemId);
    }
}

DocWriter::Result DocWriter::addShowTrack(Doc *doc, quint32 showId, const QString &name,
                                          quint32 sceneId, quint32 &trackId)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    if (sceneId != Function::invalidId())
    {
        const Function *scene = doc->function(sceneId);
        if (scene == nullptr || scene->type() != Function::SceneType)
            return Result::failure(QStringLiteral("No scene with id %1").arg(sceneId));
    }

    /* The show is the track's QObject parent, and that is not decoration:
       Track::createShowFunction reads it to get the next item id, and a track
       without one hands every item the id 0 -- so the second item on a track
       cannot be told from the first, and editing one edits both. The v4 desktop
       has exactly that bug (ui/src/showmanager/showmanager.cpp:752). */
    Track *track = new Track(sceneId, show);
    track->setName(name.trimmed().isEmpty() ? QStringLiteral("Pista %1").arg(show->getTracksCount() + 1)
                                            : name.trimmed());

    if (show->addTrack(track) == false)
    {
        delete track;
        return Result::failure(QStringLiteral("The engine refused the track"));
    }

    trackId = track->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeShowTrack(Doc *doc, quint32 showId, quint32 trackId)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    if (show->track(trackId) == nullptr)
        return Result::failure(QStringLiteral("No track with id %1 in \"%2\"")
                                   .arg(trackId).arg(show->name()));

    /* Not while it plays. The runner holds pointers into the tracks it is
       stepping through, and freeing one underneath it is a crash rather than a
       wrong cue. */
    if (show->isRunning() && show->stopAndWait() == false)
    {
        return Result::failure(QStringLiteral("\"%1\" did not stop in time; refusing to change "
                                              "its tracks while it runs").arg(show->name()));
    }

    if (show->removeTrack(trackId) == false)
        return Result::failure(QStringLiteral("The engine refused to remove the track"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setShowTrack(Doc *doc, quint32 showId, quint32 trackId,
                                          const QString *name, const bool *mute,
                                          const quint32 *sceneId)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    Track *track = show->track(trackId);
    if (track == nullptr)
    {
        return Result::failure(QStringLiteral("No track with id %1 in \"%2\"")
                                   .arg(trackId).arg(show->name()));
    }

    if (name != nullptr && name->trimmed().isEmpty())
        return Result::failure(QStringLiteral("A track needs a name"));

    if (sceneId != nullptr && *sceneId != Function::invalidId())
    {
        const Function *scene = doc->function(*sceneId);
        if (scene == nullptr || scene->type() != Function::SceneType)
            return Result::failure(QStringLiteral("No scene with id %1").arg(*sceneId));
    }

    if (name != nullptr)
        track->setName(name->trimmed());
    if (mute != nullptr)
        track->setMute(*mute);
    if (sceneId != nullptr)
        track->setSceneID(*sceneId);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::addShowItem(Doc *doc, quint32 showId, quint32 trackId,
                                         quint32 functionId, quint32 start, quint32 duration,
                                         quint32 &itemId)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    Track *track = show->track(trackId);
    if (track == nullptr)
    {
        return Result::failure(QStringLiteral("No track with id %1 in \"%2\"")
                                   .arg(trackId).arg(show->name()));
    }

    Function *placed = doc->function(functionId);
    if (placed == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(functionId));

    if (placed->id() == showId)
        return Result::failure(QStringLiteral("A show cannot be placed inside itself"));

    if (placeable(placed->type()) == false)
    {
        return Result::failure(
            QStringLiteral("A %1 cannot go on a timeline: it has no duration to draw or to stop "
                           "it at")
                .arg(Function::typeToString(placed->type()).toLower()));
    }

    /* Overlaps are refused rather than drawn on top of each other. Two things
       on one track at the same time both play, and what the rig does is
       whichever wrote last -- which is not something an operator can read off
       a timeline that shows them stacked. */
    const quint32 length = duration > 0 ? duration : placed->totalDuration();
    const quint32 end = start + length;

    for (const ShowFunction *existing : track->showFunctions())
    {
        const quint32 otherStart = existing->startTime();
        const quint32 otherEnd = otherStart + existing->duration(doc);

        if (start < otherEnd && otherStart < end)
        {
            const Function *other = doc->function(existing->functionID());
            return Result::failure(
                QStringLiteral("That overlaps \"%1\", which runs from %2 to %3 ms on this track")
                    .arg(other != nullptr ? other->name() : QStringLiteral("(borrada)"))
                    .arg(otherStart).arg(otherEnd));
        }
    }

    ShowFunction *item = track->createShowFunction(functionId);
    item->setStartTime(start);
    item->setDuration(duration);

    itemId = item->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setShowItem(Doc *doc, quint32 showId, quint32 itemId,
                                         const quint32 *start, const quint32 *duration,
                                         const QString *color, const bool *locked)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    ShowFunction *item = show->showFunction(itemId);
    Track *track = trackOf(show, itemId);
    if (item == nullptr || track == nullptr)
    {
        return Result::failure(QStringLiteral("No item with id %1 in \"%2\"")
                                   .arg(itemId).arg(show->name()));
    }

    if (item->isLocked() && (start != nullptr || duration != nullptr))
    {
        return Result::failure(QStringLiteral("That item is locked; unlock it before moving it"));
    }

    const quint32 newStart = start != nullptr ? *start : item->startTime();
    const quint32 stored = duration != nullptr ? *duration : item->duration();
    Function *placed = doc->function(item->functionID());
    const quint32 length = stored > 0 ? stored
                                      : (placed != nullptr ? placed->totalDuration() : 0);

    for (const ShowFunction *existing : track->showFunctions())
    {
        if (existing == item)
            continue;

        const quint32 otherStart = existing->startTime();
        const quint32 otherEnd = otherStart + existing->duration(doc);

        if (newStart < otherEnd && otherStart < newStart + length)
        {
            const Function *other = doc->function(existing->functionID());
            return Result::failure(
                QStringLiteral("That would overlap \"%1\", which runs from %2 to %3 ms on this "
                               "track")
                    .arg(other != nullptr ? other->name() : QStringLiteral("(borrada)"))
                    .arg(otherStart).arg(otherEnd));
        }
    }

    QColor parsed;
    if (color != nullptr)
    {
        parsed = QColor(*color);
        if (parsed.isValid() == false)
            return Result::failure(QStringLiteral("\"%1\" is not a colour").arg(*color));
    }

    if (start != nullptr)
        item->setStartTime(*start);
    if (duration != nullptr)
        item->setDuration(*duration);
    if (color != nullptr)
        item->setColor(parsed);
    if (locked != nullptr)
        item->setLocked(*locked);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeShowItem(Doc *doc, quint32 showId, quint32 itemId)
{
    QString error;
    Show *show = showById(doc, showId, error);
    if (show == nullptr)
        return Result::failure(error);

    ShowFunction *item = show->showFunction(itemId);
    Track *track = trackOf(show, itemId);
    if (item == nullptr || track == nullptr)
    {
        return Result::failure(QStringLiteral("No item with id %1 in \"%2\"")
                                   .arg(itemId).arg(show->name()));
    }

    /* Same reason as removing a track: the runner is holding this. */
    if (show->isRunning() && show->stopAndWait() == false)
    {
        return Result::failure(QStringLiteral("\"%1\" did not stop in time; refusing to change "
                                              "it while it runs").arg(show->name()));
    }

    if (track->removeShowFunction(item) == false)
        return Result::failure(QStringLiteral("The engine refused to remove the item"));

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * Channels groups
 *****************************************************************************/

namespace
{
    /**
     * Check a list of channels before it reaches the engine.
     *
     * ChannelsGroup::addChannel takes any channel number at all and stores it,
     * and the desk then writes it at the fixture's address plus that offset --
     * so channel 8 of a 4-channel dimmer is the second channel of whatever is
     * patched next to it. A fader that moves a lamp nobody named is worse than
     * one that refuses to be built.
     */
    DocWriter::Result checkChannels(Doc *doc, const QList<QPair<quint32, quint32>> &channels)
    {
        if (channels.isEmpty())
        {
            return DocWriter::Result::failure(
                QStringLiteral("A channels group with no channels is a fader that does nothing"));
        }

        QSet<QPair<quint32, quint32>> seen;

        for (const auto &entry : channels)
        {
            Fixture *fixture = doc->fixture(entry.first);
            if (fixture == nullptr)
            {
                return DocWriter::Result::failure(
                    QStringLiteral("No fixture with id %1").arg(entry.first));
            }

            if (entry.second >= fixture->channels())
            {
                return DocWriter::Result::failure(
                    QStringLiteral("\"%1\" has %2 channels, so it has no channel %3")
                        .arg(fixture->name()).arg(fixture->channels()).arg(entry.second));
            }

            if (seen.contains(entry))
            {
                return DocWriter::Result::failure(
                    QStringLiteral("Channel %1 of \"%2\" is in the group twice")
                        .arg(entry.second).arg(fixture->name()));
            }
            seen.insert(entry);
        }

        return DocWriter::Result::success();
    }
}

DocWriter::Result DocWriter::addChannelsGroup(Doc *doc, const QString &name,
                                              const QList<QPair<quint32, quint32>> &channels,
                                              quint32 &groupId)
{
    if (name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A channels group needs a name"));

    const Result checked = checkChannels(doc, channels);
    if (checked.ok == false)
        return checked;

    ChannelsGroup *group = new ChannelsGroup(doc);
    group->setName(name.trimmed());
    for (const auto &entry : channels)
        group->addChannel(entry.first, entry.second);

    if (doc->addChannelsGroup(group) == false)
    {
        delete group;
        return Result::failure(QStringLiteral("The engine refused the group"));
    }

    groupId = group->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeChannelsGroup(Doc *doc, quint32 groupId)
{
    if (doc->channelsGroup(groupId) == nullptr)
        return Result::failure(QStringLiteral("No channels group with id %1").arg(groupId));

    if (doc->deleteChannelsGroup(groupId) == false)
        return Result::failure(QStringLiteral("The engine refused to delete the group"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setChannelsGroup(Doc *doc, quint32 groupId, const QString *name,
                                              const QList<QPair<quint32, quint32>> *channels)
{
    ChannelsGroup *group = doc->channelsGroup(groupId);
    if (group == nullptr)
        return Result::failure(QStringLiteral("No channels group with id %1").arg(groupId));

    if (name != nullptr && name->trimmed().isEmpty())
        return Result::failure(QStringLiteral("A channels group needs a name"));

    /* Everything validated before anything is touched: resetChannels() throws
       the old list away, and a group left empty by a rejected edit is a fader
       the operator did not ask to lose. */
    if (channels != nullptr)
    {
        const Result checked = checkChannels(doc, *channels);
        if (checked.ok == false)
            return checked;
    }

    if (name != nullptr)
        group->setName(name->trimmed());

    if (channels != nullptr)
    {
        group->resetChannels();
        for (const auto &entry : *channels)
            group->addChannel(entry.first, entry.second);
    }

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * Functions
 *****************************************************************************/

namespace
{
    /** Allocate an empty function of the named type, or nullptr. */
    Function *makeFunction(Doc *doc, const QString &type)
    {
        const QString wanted = type.trimmed().toLower();

        if (wanted == QStringLiteral("scene"))      return new Scene(doc);
        if (wanted == QStringLiteral("chaser"))     return new Chaser(doc);
        if (wanted == QStringLiteral("efx"))        return new EFX(doc);
        if (wanted == QStringLiteral("collection")) return new Collection(doc);
        if (wanted == QStringLiteral("script"))     return new Script(doc);
        if (wanted == QStringLiteral("rgbmatrix"))  return new RGBMatrix(doc);
        if (wanted == QStringLiteral("show"))       return new Show(doc);
        if (wanted == QStringLiteral("sequence"))   return new Sequence(doc);
        if (wanted == QStringLiteral("audio"))      return new Audio(doc);
        if (wanted == QStringLiteral("video"))      return new Video(doc);

        return nullptr;
    }

    QString knownFunctionTypes()
    {
        return QStringLiteral("scene, chaser, efx, collection, script, rgbmatrix, "
                              "show, sequence, audio, video");
    }
}

DocWriter::Result DocWriter::createFunction(Doc *doc, const QString &type, const QString &name,
                                            quint32 &id)
{
    Function *function = makeFunction(doc, type);
    if (function == nullptr)
    {
        return Result::failure(QStringLiteral("No function type \"%1\". Known types: %2")
                                   .arg(type, knownFunctionTypes()));
    }

    /* Register first. Doc::addFunction wires the signals, assigns the id and
       emits functionAdded; nothing hand-rolled substitutes for it. On failure
       the object is still ours to delete. */
    if (doc->addFunction(function) == false)
    {
        delete function;
        return Result::failure(QStringLiteral("The engine refused to add the function"));
    }

    id = function->id();

    /* Named afterwards, so nameChanged carries the real id to a Doc that is
       already listening. */
    function->setName(name.trimmed().isEmpty()
                          ? QStringLiteral("New %1 %2").arg(type, QString::number(id))
                          : name);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::renameFunction(Doc *doc, quint32 id, const QString &name)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    if (name.trimmed().isEmpty())
        return Result::failure(QStringLiteral("A function needs a name"));

    function->setName(name);
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFunctionSpeeds(Doc *doc, quint32 id, int fadeIn, int fadeOut,
                                               int duration)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    if (fadeIn >= 0)
        function->setFadeInSpeed(uint(fadeIn));
    if (fadeOut >= 0)
        function->setFadeOutSpeed(uint(fadeOut));
    if (duration >= 0)
        function->setDuration(uint(duration));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFunctionRun(Doc *doc, quint32 id, const QString &runOrder,
                                            const QString &direction)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    if (runOrder.isEmpty() == false)
    {
        const QString wanted = runOrder.toLower();
        if (wanted == QStringLiteral("loop"))            function->setRunOrder(Function::Loop);
        else if (wanted == QStringLiteral("singleshot")) function->setRunOrder(Function::SingleShot);
        else if (wanted == QStringLiteral("pingpong"))   function->setRunOrder(Function::PingPong);
        else if (wanted == QStringLiteral("random"))     function->setRunOrder(Function::Random);
        else
        {
            return Result::failure(
                QStringLiteral("Run order must be loop, singleshot, pingpong or random"));
        }
    }

    if (direction.isEmpty() == false)
    {
        const QString wanted = direction.toLower();
        if (wanted == QStringLiteral("forward"))       function->setDirection(Function::Forward);
        else if (wanted == QStringLiteral("backward")) function->setDirection(Function::Backward);
        else
            return Result::failure(QStringLiteral("Direction must be forward or backward"));
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::deleteFunction(Doc *doc, quint32 id, bool force)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    /* Doc::deleteFunction does not check references, so a chaser step or a
       collection would be left pointing at nothing. Name the holders instead
       of failing vaguely. */
    const QList<quint32> usage = doc->getUsage(id);
    if (usage.isEmpty() == false && force == false)
    {
        QStringList holders;
        for (quint32 holderId : usage)
        {
            const Function *holder = doc->function(holderId);
            if (holder != nullptr && holders.contains(holder->name()) == false)
                holders << holder->name();
        }

        return Result::failure(
            QStringLiteral("\"%1\" is still used by: %2. Pass force=true to delete it anyway.")
                .arg(function->name(), holders.join(QStringLiteral(", "))));
    }

    /* Stopped first and waited for: deleting a running function frees an object
       the MasterTimer is still stepping through. */
    if (function->isRunning())
    {
        if (function->stopAndWait() == false)
        {
            return Result::failure(
                QStringLiteral("\"%1\" did not stop in time; refusing to delete it while it runs")
                    .arg(function->name()));
        }
    }

    if (doc->deleteFunction(id) == false)
        return Result::failure(QStringLiteral("The engine refused to delete the function"));

    doc->setModified();
    return Result::success();
}

/*****************************************************************************
 * Function bodies
 *****************************************************************************/

DocWriter::Result DocWriter::setSceneValue(Doc *doc, quint32 sceneId, quint32 fixtureId,
                                           quint32 channel, int value)
{
    Function *function = doc->function(sceneId);
    if (function == nullptr || function->type() != Function::SceneType)
        return Result::failure(QStringLiteral("No scene with id %1").arg(sceneId));

    const Fixture *fixture = doc->fixture(fixtureId);
    if (fixture == nullptr)
        return Result::failure(QStringLiteral("No fixture with id %1").arg(fixtureId));

    /* Scene::setValue validates nothing: an unknown fixture is warned about and
       stored anyway, and the channel is never checked against the fixture. The
       junk then survives until a project reload prunes it. */
    if (channel >= fixture->channels())
    {
        return Result::failure(QStringLiteral("\"%1\" has %2 channels, so channel %3 does not exist")
                                   .arg(fixture->name()).arg(fixture->channels()).arg(channel + 1));
    }

    Scene *scene = qobject_cast<Scene *>(function);

    if (value < 0)
    {
        scene->unsetValue(fixtureId, channel);
    }
    else if (value > 255)
    {
        return Result::failure(QStringLiteral("A channel value must be between 0 and 255"));
    }
    else
    {
        scene->addFixture(fixtureId);
        scene->setValue(fixtureId, channel, uchar(value));
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::addChaserStep(Doc *doc, quint32 chaserId, quint32 functionId,
                                           int index, int fadeIn, int hold, int fadeOut)
{
    Function *function = doc->function(chaserId);
    if (function == nullptr
        || (function->type() != Function::ChaserType
            && function->type() != Function::SequenceType))
        return Result::failure(QStringLiteral("No chaser with id %1").arg(chaserId));

    if (functionId == chaserId)
        return Result::failure(QStringLiteral("A chaser cannot step through itself"));

    const Function *member = doc->function(functionId);
    if (member == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(functionId));

    Chaser *chaser = qobject_cast<Chaser *>(function);

    ChaserStep step(functionId, uint(qMax(0, fadeIn)), uint(qMax(0, hold)), uint(qMax(0, fadeOut)));
    if (chaser->addStep(step, index) == false)
        return Result::failure(QStringLiteral("The engine refused the step"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removeChaserStep(Doc *doc, quint32 chaserId, int index)
{
    Function *function = doc->function(chaserId);
    if (function == nullptr
        || (function->type() != Function::ChaserType
            && function->type() != Function::SequenceType))
        return Result::failure(QStringLiteral("No chaser with id %1").arg(chaserId));

    Chaser *chaser = qobject_cast<Chaser *>(function);

    if (index < 0 || index >= chaser->stepsCount())
    {
        return Result::failure(QStringLiteral("Step %1 does not exist; this chaser has %2")
                                   .arg(index).arg(chaser->stepsCount()));
    }

    if (chaser->removeStep(index) == false)
        return Result::failure(QStringLiteral("The engine refused to remove the step"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setCollectionMembers(Doc *doc, quint32 collectionId,
                                                  const QList<quint32> &functionIds)
{
    Function *function = doc->function(collectionId);
    if (function == nullptr || function->type() != Function::CollectionType)
        return Result::failure(QStringLiteral("No collection with id %1").arg(collectionId));

    for (quint32 id : functionIds)
    {
        if (id == collectionId)
            return Result::failure(QStringLiteral("A collection cannot contain itself"));
        if (doc->function(id) == nullptr)
            return Result::failure(QStringLiteral("No function with id %1").arg(id));
    }

    Collection *collection = qobject_cast<Collection *>(function);

    for (quint32 id : collection->functions())
        collection->removeFunction(id);

    for (quint32 id : functionIds)
        collection->addFunction(id);

    doc->setModified();
    return Result::success();
}


DocWriter::Result DocWriter::setRgbMatrix(Doc *doc, quint32 matrixId, int fixtureGroupId,
                                          const QString &algorithm, const QList<QString> &colours)
{
    Function *function = doc->function(matrixId);
    if (function == nullptr || function->type() != Function::RGBMatrixType)
        return Result::failure(QStringLiteral("No RGB matrix with id %1").arg(matrixId));

    RGBMatrix *matrix = qobject_cast<RGBMatrix *>(function);

    if (fixtureGroupId >= 0)
    {
        if (doc->fixtureGroup(quint32(fixtureGroupId)) == nullptr)
        {
            return Result::failure(
                QStringLiteral("No fixture group with id %1").arg(fixtureGroupId));
        }
        matrix->setFixtureGroup(quint32(fixtureGroupId));
    }

    if (algorithm.isEmpty() == false)
    {
        /* Checked against the list BEFORE asking for an instance, because
           RGBAlgorithm::algorithm() cannot report a bad name: for anything that
           is not one of the four built-ins it falls through to
           RGBScriptsCache::script(), which returns a fresh, empty RGBScript
           rather than nullptr (engine/src/rgbscriptscache.cpp:42-55).
         *
         * So a typo would be accepted, and the matrix would run and emit
           nothing at all -- with no error anywhere to explain why the lights
           stayed dark. */
        if (RGBAlgorithm::algorithms(doc).contains(algorithm) == false)
        {
            return Result::failure(QStringLiteral("No algorithm named \"%1\". Available: %2")
                                       .arg(algorithm,
                                            RGBAlgorithm::algorithms(doc).join(QStringLiteral(", "))));
        }

        /* Builds a fresh instance; RGBMatrix takes ownership. */
        RGBAlgorithm *instance = RGBAlgorithm::algorithm(doc, algorithm);
        if (instance == nullptr)
            return Result::failure(QStringLiteral("The engine could not build that algorithm"));

        matrix->setAlgorithm(instance);
    }

    for (int i = 0; i < colours.count() && i < 5; i++)
    {
        const QString &text = colours.at(i);
        if (text.isEmpty())
            continue;

        const QColor colour(text);
        if (colour.isValid() == false)
        {
            return Result::failure(
                QStringLiteral("\"%1\" is not a colour; use #rrggbb").arg(text));
        }
        matrix->setColor(i, colour);
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::applyMatrixPreset(Doc *doc, quint32 matrixId, const QString &type,
                                               const QString &color, const QString &resource,
                                               const QList<QPair<QString, QString>> &properties,
                                               bool instant)
{
    Function *function = doc->function(matrixId);
    if (function == nullptr || function->type() != Function::RGBMatrixType)
        return Result::failure(QStringLiteral("No RGB matrix with id %1").arg(matrixId));

    RGBMatrix *matrix = qobject_cast<RGBMatrix *>(function);

    /* Slot from the type name: Color1..Color5, and the Reset forms that clear
       one. Five is the most any algorithm accepts. */
    const auto slotOf = [&type](const QString &suffix) {
        for (int i = 1; i <= 5; i++)
        {
            if (type == QStringLiteral("Color%1%2").arg(i).arg(suffix))
                return i - 1;
        }
        return -1;
    };

    const int slot = slotOf(QString());
    if (slot >= 0)
    {
        const QColor chosen(color);
        if (chosen.isValid() == false)
            return Result::failure(QStringLiteral("\"%1\" is not a colour").arg(color));

        matrix->setColor(slot, chosen);
        if (instant)
            matrix->updateColorDelta();

        doc->setModified();
        return Result::success();
    }

    const int reset = slotOf(QStringLiteral("Reset"));
    if (reset >= 0)
    {
        /* An invalid colour is how the engine spells "this slot is unset",
           which is not the same as black. */
        matrix->setColor(reset, QColor());
        if (instant)
            matrix->updateColorDelta();

        doc->setModified();
        return Result::success();
    }

    if (type == QStringLiteral("Animation"))
    {
        /* Validated against the list first: RGBAlgorithm::algorithm() cannot
           report a bad name -- it falls through to the script cache, which
           returns an empty but non-null RGBScript. The matrix would then run
           and emit nothing, with no error anywhere. */
        if (RGBAlgorithm::algorithms(doc).contains(resource) == false)
            return Result::failure(QStringLiteral("No algorithm called \"%1\"").arg(resource));

        RGBAlgorithm *algorithm = RGBAlgorithm::algorithm(doc, resource);
        if (algorithm == nullptr)
            return Result::failure(QStringLiteral("No algorithm called \"%1\"").arg(resource));

        /* Algorithm first, then its properties.
         *
         * RGBMatrix::setProperty forwards to the algorithm instance under the
         * matrix's own mutex (rgbmatrix.cpp:426), so setting them afterwards
         * reaches the one that is now running -- and does it without this file
         * needing to know what a script is. Setting them first would put them
         * on the algorithm that is about to be replaced. */
        matrix->setAlgorithm(algorithm);

        for (const auto &property : properties)
            matrix->setProperty(property.first, property.second);
        if (instant)
            matrix->updateColorDelta();

        doc->setModified();
        return Result::success();
    }

    /* Knobs are continuous and images and text need a file, so neither is a
       button. Refusing beats applying something else. */
    return Result::failure(
        QStringLiteral("Presets of type \"%1\" cannot be applied from here yet").arg(type));
}

DocWriter::Result DocWriter::setScriptData(Doc *doc, quint32 scriptId, const QString &data)
{
    Function *function = doc->function(scriptId);
    if (function == nullptr || function->type() != Function::ScriptType)
        return Result::failure(QStringLiteral("No script with id %1").arg(scriptId));

    Script *script = qobject_cast<Script *>(function);

    /* setData parses the program and reports whether it made sense. Accepting
       a script the engine could not parse would leave a function that silently
       does nothing when fired. */
    if (script->setData(data) == false)
        return Result::failure(QStringLiteral("The engine could not parse that script"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setAudioSource(Doc *doc, quint32 audioId, const QString &fileName,
                                            double volume, const QString *device)
{
    Function *function = doc->function(audioId);
    if (function == nullptr || function->type() != Function::AudioType)
        return Result::failure(QStringLiteral("No audio function with id %1").arg(audioId));

    Audio *audio = qobject_cast<Audio *>(function);

    if (fileName.isEmpty() == false)
    {
        if (QFileInfo::exists(fileName) == false)
            return Result::failure(QStringLiteral("No such file: %1").arg(fileName));

        /* Returns false when no decoder plugin can read it. Saying so beats a
           function that loads, shows a duration of zero and never plays. */
        if (audio->setSourceFileName(fileName) == false)
        {
            return Result::failure(
                QStringLiteral("No audio decoder can read %1. Loaded decoders handle: %2")
                    .arg(fileName, doc->audioPluginCache()->getSupportedFormats()
                                       .join(QStringLiteral(", "))));
        }
    }

    if (volume >= 0.0)
    {
        if (volume > 1.0)
            return Result::failure(QStringLiteral("Volume must be between 0 and 1"));
        audio->setVolume(volume);
    }

    if (device != nullptr && device->isEmpty() == false)
    {
        /* Checked against what this machine actually has.
         *
           The engine does not check: getOutputDeviceInfo falls back to the
           default output for any name it does not recognise, so a typo, or a
           device named on the machine the show was built on and absent on this
           one, plays out of the wrong socket and reports nothing. On a rig that
           is the click track in the room. */
        bool known = false;
        for (const AudioDeviceInfo &info : doc->audioPluginCache()->audioDevicesList())
        {
            if ((info.capabilities & AUDIO_CAP_OUTPUT) && info.deviceName == *device)
            {
                known = true;
                break;
            }
        }

        if (known == false)
        {
            QStringList names;
            for (const AudioDeviceInfo &info : doc->audioPluginCache()->audioDevicesList())
            {
                if (info.capabilities & AUDIO_CAP_OUTPUT)
                    names << info.deviceName;
            }

            return Result::failure(
                names.isEmpty()
                    ? QStringLiteral("This machine reports no audio outputs at all, so \"%1\" "
                                     "cannot be one of them").arg(*device)
                    : QStringLiteral("No audio output called \"%1\". This machine has: %2")
                          .arg(*device, names.join(QStringLiteral(", "))));
        }
    }

    if (device != nullptr)
        audio->setAudioDevice(*device);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setVideoSource(Doc *doc, quint32 videoId, const QString &source)
{
    Function *function = doc->function(videoId);
    if (function == nullptr || function->type() != Function::VideoType)
        return Result::failure(QStringLiteral("No video function with id %1").arg(videoId));

    if (source.isEmpty())
        return Result::failure(QStringLiteral("A video needs a source"));

    /* A local path must exist; a URL is taken on trust because resolving it
       here would block the engine thread on the network. */
    const bool isUrl = source.contains(QStringLiteral("://"));
    if (isUrl == false && QFileInfo::exists(source) == false)
        return Result::failure(QStringLiteral("No such file: %1").arg(source));

    Video *video = qobject_cast<Video *>(function);
    video->setSourceUrl(source);

    doc->setModified();
    return Result::success();
}


DocWriter::Result DocWriter::setEfx(Doc *doc, quint32 efxId, const QString &algorithm,
                                    const QJsonObject &geometry, const QList<quint32> *fixtureIds)
{
    Function *function = doc->function(efxId);
    if (function == nullptr || function->type() != Function::EFXType)
        return Result::failure(QStringLiteral("No EFX with id %1").arg(efxId));

    EFX *efx = qobject_cast<EFX *>(function);

    if (algorithm.isEmpty() == false)
    {
        if (EFX::algorithmList().contains(algorithm) == false)
        {
            return Result::failure(QStringLiteral("No EFX algorithm named \"%1\". Available: %2")
                                       .arg(algorithm,
                                            EFX::algorithmList().join(QStringLiteral(", "))));
        }
        efx->setAlgorithm(EFX::stringToAlgorithm(algorithm));
    }

    /* Every one of these is clamped by the engine, so out-of-range input would
       be silently corrected rather than reported. Checking here means a caller
       that asks for width 500 learns it cannot have it. */
    const auto ranged = [&](const char *key, int low, int high, QString &error) -> int {
        if (geometry.contains(QLatin1String(key)) == false)
            return INT_MIN;

        const int value = geometry.value(QLatin1String(key)).toInt();
        if (value < low || value > high)
        {
            error = QStringLiteral("%1 must be between %2 and %3")
                        .arg(QLatin1String(key)).arg(low).arg(high);
        }
        return value;
    };

    QString error;
    const int width      = ranged("width",       0, 127, error);
    const int height     = ranged("height",      0, 127, error);
    const int xOffset    = ranged("xOffset",     0, 255, error);
    const int yOffset    = ranged("yOffset",     0, 255, error);
    const int rotation   = ranged("rotation",    0, 359, error);
    const int startOff   = ranged("startOffset", 0, 359, error);
    const int xFrequency = ranged("xFrequency",  0,   5, error);
    const int yFrequency = ranged("yFrequency",  0,   5, error);
    const int xPhase     = ranged("xPhase",      0, 359, error);
    const int yPhase     = ranged("yPhase",      0, 359, error);

    if (error.isEmpty() == false)
        return Result::failure(error);

    if (width      != INT_MIN) efx->setWidth(width);
    if (height     != INT_MIN) efx->setHeight(height);
    if (xOffset    != INT_MIN) efx->setXOffset(xOffset);
    if (yOffset    != INT_MIN) efx->setYOffset(yOffset);
    if (rotation   != INT_MIN) efx->setRotation(rotation);
    if (startOff   != INT_MIN) efx->setStartOffset(startOff);
    if (xFrequency != INT_MIN) efx->setXFrequency(xFrequency);
    if (yFrequency != INT_MIN) efx->setYFrequency(yFrequency);
    if (xPhase     != INT_MIN) efx->setXPhase(xPhase);
    if (yPhase     != INT_MIN) efx->setYPhase(yPhase);

    if (geometry.contains(QStringLiteral("relative")))
        efx->setIsRelative(geometry.value(QStringLiteral("relative")).toBool());

    if (geometry.contains(QStringLiteral("propagation")))
    {
        const QString wanted = geometry.value(QStringLiteral("propagation")).toString();
        const EFX::PropagationMode mode = EFX::stringToPropagationMode(wanted);
        if (EFX::propagationModeToString(mode).compare(wanted, Qt::CaseInsensitive) != 0)
            return Result::failure(
                QStringLiteral("propagation must be Parallel, Serial or Asymmetric"));
        efx->setPropagationMode(mode);
    }

    /* Per-head adjustments: the start offset around the pattern, the reversed
       direction, the head's own mode (position, dimmer or RGB). This is what
       turns eight moving heads into a wave instead of a block. */
    if (geometry.contains(QStringLiteral("offsets")))
    {
        for (const QJsonValue &value : geometry.value(QStringLiteral("offsets")).toArray())
        {
            const QJsonObject asked = value.toObject();
            const quint32 fixtureId = quint32(asked.value(QStringLiteral("fixture")).toInt(-1));
            const int head = asked.value(QStringLiteral("head")).toInt(0);

            EFXFixture *member = nullptr;
            for (EFXFixture *candidate : efx->fixtures())
            {
                if (candidate->head().fxi == fixtureId && candidate->head().head == head)
                    member = candidate;
            }
            if (member == nullptr)
                return Result::failure(
                    QStringLiteral("The EFX has no head %1 of fixture %2").arg(head).arg(fixtureId));

            if (asked.contains(QStringLiteral("offset")))
            {
                const int offset = asked.value(QStringLiteral("offset")).toInt(-1);
                if (offset < 0 || offset > 359)
                    return Result::failure(QStringLiteral("offset must be 0..359"));
                member->setStartOffset(offset);
            }
            if (asked.contains(QStringLiteral("reverse")))
            {
                member->setDirection(asked.value(QStringLiteral("reverse")).toBool()
                                         ? Function::Backward
                                         : Function::Forward);
            }
            if (asked.contains(QStringLiteral("mode")))
            {
                const QString wanted = asked.value(QStringLiteral("mode")).toString();
                const EFXFixture::Mode mode = EFXFixture::stringToMode(wanted);
                if (EFXFixture::modeToString(mode).compare(wanted, Qt::CaseInsensitive) != 0)
                    return Result::failure(QStringLiteral(
                        "A head's mode must be Position, Dimmer or RGB"));
                member->setMode(mode);
            }
        }
    }

    if (fixtureIds != nullptr)
    {
        for (quint32 id : *fixtureIds)
        {
            if (doc->fixture(id) == nullptr)
                return Result::failure(QStringLiteral("No fixture with id %1").arg(id));
        }

        /* Stopped and waited for before the list is touched. EFX::write() walks
           m_fixtures on the timer thread with no lock, so rebuilding it live
           frees objects out from under it. */
        if (efx->isRunning() && efx->stopAndWait() == false)
        {
            return Result::failure(
                QStringLiteral("\"%1\" did not stop in time; refusing to change its fixtures while it runs")
                    .arg(efx->name()));
        }

        for (EFXFixture *existing : efx->fixtures())
            efx->removeFixture(existing->head().fxi, existing->head().head);

        for (quint32 id : *fixtureIds)
        {
            EFXFixture *member = new EFXFixture(efx);
            member->setHead(GroupHead(id, 0));

            if (efx->addFixture(member) == false)
                delete member;   // already present; addFixture refused it
        }
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setSequenceScene(Doc *doc, quint32 sequenceId, quint32 sceneId)
{
    Function *function = doc->function(sequenceId);
    if (function == nullptr || function->type() != Function::SequenceType)
        return Result::failure(QStringLiteral("No sequence with id %1").arg(sequenceId));

    const Function *scene = doc->function(sceneId);
    if (scene == nullptr || scene->type() != Function::SceneType)
        return Result::failure(QStringLiteral("No scene with id %1").arg(sceneId));

    Sequence *sequence = qobject_cast<Sequence *>(function);

    /* The bound scene is structural: a sequence's steps hold values that only
       mean anything against it. Rebinding a running one would have it stepping
       through values addressed at a scene it no longer drives. */
    if (sequence->isRunning() && sequence->stopAndWait() == false)
    {
        return Result::failure(
            QStringLiteral("\"%1\" did not stop in time; refusing to rebind it while it runs")
                .arg(sequence->name()));
    }

    sequence->setBoundSceneID(sceneId);

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFunctionPath(Doc *doc, quint32 id, const QString &path)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    function->setPath(path);
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setFunctionTempo(Doc *doc, quint32 id, const QString &tempoType)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    const QString wanted = tempoType.toLower();
    if (wanted == QStringLiteral("time"))
        function->setTempoType(Function::Time);
    else if (wanted == QStringLiteral("beats"))
        function->setTempoType(Function::Beats);
    else
        return Result::failure(QStringLiteral("Tempo must be \"time\" or \"beats\""));

    doc->setModified();
    return Result::success();
}

namespace
{
    bool speedModeOf(const QString &name, Chaser::SpeedMode &mode, bool durationAllowed)
    {
        const QString wanted = name.toLower();
        if (wanted == QStringLiteral("common"))
            mode = Chaser::Common;
        else if (wanted == QStringLiteral("perstep"))
            mode = Chaser::PerStep;
        else if (wanted == QStringLiteral("default") && durationAllowed)
            mode = Chaser::Default;
        else
            return false;
        return true;
    }
}

DocWriter::Result DocWriter::setChaserSpeedModes(Doc *doc, quint32 chaserId,
                                                 const QString &fadeIn, const QString &fadeOut,
                                                 const QString &duration)
{
    Function *function = doc->function(chaserId);
    if (function == nullptr
        || (function->type() != Function::ChaserType
            && function->type() != Function::SequenceType))
        return Result::failure(QStringLiteral("No chaser with id %1").arg(chaserId));
    Chaser *chaser = qobject_cast<Chaser *>(function);

    Chaser::SpeedMode mode = Chaser::Common;
    if (fadeIn.isEmpty() == false)
    {
        if (speedModeOf(fadeIn, mode, false) == false)
            return Result::failure(QStringLiteral("fadeInMode must be \"common\" or \"perstep\""));
        chaser->setFadeInMode(mode);
    }
    if (fadeOut.isEmpty() == false)
    {
        if (speedModeOf(fadeOut, mode, false) == false)
            return Result::failure(QStringLiteral("fadeOutMode must be \"common\" or \"perstep\""));
        chaser->setFadeOutMode(mode);
    }
    if (duration.isEmpty() == false)
    {
        /* Default here means "the chaser's own duration": the mode QLC+ only
           offers for this one column. */
        if (speedModeOf(duration, mode, true) == false)
            return Result::failure(
                QStringLiteral("durationMode must be \"common\", \"perstep\" or \"default\""));
        chaser->setDurationMode(mode);
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setChaserStep(Doc *doc, quint32 chaserId, int index,
                                           const int *fadeIn, const int *hold, const int *fadeOut,
                                           const int *duration, const QString *note,
                                           const quint32 *functionId)
{
    Function *function = doc->function(chaserId);
    if (function == nullptr
        || (function->type() != Function::ChaserType
            && function->type() != Function::SequenceType))
        return Result::failure(QStringLiteral("No chaser with id %1").arg(chaserId));
    Chaser *chaser = qobject_cast<Chaser *>(function);

    if (index < 0 || index >= chaser->stepsCount())
        return Result::failure(QStringLiteral("No step %1: the chaser has %2")
                                   .arg(index)
                                   .arg(chaser->stepsCount()));

    ChaserStep step = chaser->steps().at(index);

    if (functionId != nullptr)
    {
        if (*functionId == chaserId)
            return Result::failure(QStringLiteral("A chaser cannot step through itself"));
        if (doc->function(*functionId) == nullptr)
            return Result::failure(QStringLiteral("No function with id %1").arg(*functionId));
        step.fid = *functionId;
    }
    if (fadeIn != nullptr)
        step.fadeIn = uint(qMax(0, *fadeIn));
    if (hold != nullptr)
        step.hold = uint(qMax(0, *hold));
    if (fadeOut != nullptr)
        step.fadeOut = uint(qMax(0, *fadeOut));

    /* The reference editor's arithmetic (ui/src/chasereditor.cpp): the stored
       duration is fadeIn + hold, and whichever of the three the operator
       touched decides which of the others gives way. */
    if (duration != nullptr)
    {
        step.duration = uint(qMax(0, *duration));
        step.hold = step.duration >= step.fadeIn ? step.duration - step.fadeIn : 0;
    }
    else if (fadeIn != nullptr || hold != nullptr)
    {
        step.duration = Function::speedAdd(step.fadeIn, step.hold);
    }

    if (note != nullptr)
        step.note = *note;

    if (chaser->replaceStep(step, index) == false)
        return Result::failure(QStringLiteral("The engine refused the step"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setChaserStepsOrder(Doc *doc, quint32 chaserId,
                                                 const QList<int> &order)
{
    Function *function = doc->function(chaserId);
    if (function == nullptr
        || (function->type() != Function::ChaserType
            && function->type() != Function::SequenceType))
        return Result::failure(QStringLiteral("No chaser with id %1").arg(chaserId));
    Chaser *chaser = qobject_cast<Chaser *>(function);

    const QList<ChaserStep> steps = chaser->steps();
    if (order.count() != steps.count())
        return Result::failure(QStringLiteral("The order names %1 steps, the chaser has %2")
                                   .arg(order.count())
                                   .arg(steps.count()));

    /* A permutation, not a wish list: every index exactly once, or a step
       would be silently duplicated or dropped. */
    QSet<int> seen;
    for (int index : order)
    {
        if (index < 0 || index >= steps.count() || seen.contains(index))
            return Result::failure(
                QStringLiteral("The order must name every step index exactly once"));
        seen.insert(index);
    }

    for (int target = 0; target < order.count(); target++)
    {
        /* Rebuild by replacement: position `target` takes the step that used
           to live at order[target]. */
        if (chaser->replaceStep(steps.at(order.at(target)), target) == false)
            return Result::failure(QStringLiteral("The engine refused the reorder"));
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::cloneFunction(Doc *doc, quint32 id, quint32 &newId)
{
    Function *function = doc->function(id);
    if (function == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    Function *copy = function->createCopy(doc);
    if (copy == nullptr)
        return Result::failure(QStringLiteral("The engine refused the copy"));

    newId = copy->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setSequenceStepValues(Doc *doc, quint32 sequenceId, int index,
                                                   const QList<SceneValue> &values)
{
    Function *function = doc->function(sequenceId);
    if (function == nullptr || function->type() != Function::SequenceType)
        return Result::failure(QStringLiteral("No sequence with id %1").arg(sequenceId));
    Chaser *sequence = qobject_cast<Chaser *>(function);

    if (index < 0 || index >= sequence->stepsCount())
        return Result::failure(QStringLiteral("No step %1: the sequence has %2")
                                   .arg(index)
                                   .arg(sequence->stepsCount()));

    ChaserStep step = sequence->steps().at(index);
    for (const SceneValue &value : values)
    {
        const Fixture *fixture = doc->fixture(value.fxi);
        if (fixture == nullptr)
            return Result::failure(QStringLiteral("No fixture with id %1").arg(value.fxi));
        if (value.channel >= fixture->channels())
            return Result::failure(QStringLiteral("\"%1\" has no channel %2")
                                       .arg(fixture->name())
                                       .arg(value.channel));
        step.setValue(value);
    }

    if (sequence->replaceStep(step, index) == false)
        return Result::failure(QStringLiteral("The engine refused the step"));

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setStartupFunction(Doc *doc, qint64 id)
{
    if (id >= 0 && doc->function(quint32(id)) == nullptr)
        return Result::failure(QStringLiteral("No function with id %1").arg(id));

    doc->setStartupFunction(id >= 0 ? quint32(id) : Function::invalidId());
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setRgbMatrixExtras(Doc *doc, quint32 matrixId,
                                                const QJsonObject &body)
{
    Function *function = doc->function(matrixId);
    if (function == nullptr || function->type() != Function::RGBMatrixType)
        return Result::failure(QStringLiteral("No RGB matrix with id %1").arg(matrixId));
    RGBMatrix *matrix = qobject_cast<RGBMatrix *>(function);

    if (body.contains(QStringLiteral("blendMode")))
    {
        /* stringToBlendMode answers Normal for anything it does not know, so
           the name is checked against the round trip: a typo must refuse, not
           quietly normalize. */
        const QString wanted = body.value(QStringLiteral("blendMode")).toString();
        const Universe::BlendMode mode = Universe::stringToBlendMode(wanted);
        if (Universe::blendModeToString(mode).compare(wanted, Qt::CaseInsensitive) != 0)
            return Result::failure(
                QStringLiteral("blendMode must be Normal, Mask, Additive or Subtractive"));
        matrix->setBlendMode(mode);
    }

    if (body.contains(QStringLiteral("controlMode")))
    {
        const QString wanted = body.value(QStringLiteral("controlMode")).toString();
        const RGBMatrix::ControlMode mode = RGBMatrix::stringToControlMode(wanted);
        if (RGBMatrix::controlModeToString(mode).compare(wanted, Qt::CaseInsensitive) != 0)
            return Result::failure(QStringLiteral(
                "controlMode must be RGB, White, Amber, UV, Dimmer or Shutter"));
        matrix->setControlMode(mode);
    }

    RGBAlgorithm *algorithm = matrix->algorithm();

    if (body.contains(QStringLiteral("text")))
    {
        if (algorithm == nullptr || algorithm->type() != RGBAlgorithm::Text)
            return Result::failure(
                QStringLiteral("\"text\" belongs to the Text algorithm; this matrix runs %1")
                    .arg(algorithm != nullptr ? algorithm->name() : QStringLiteral("nothing")));
        RGBText *text = static_cast<RGBText *>(algorithm);

        const QJsonObject asked = body.value(QStringLiteral("text")).toObject();
        if (asked.contains(QStringLiteral("content")))
            text->setText(asked.value(QStringLiteral("content")).toString());
        if (asked.contains(QStringLiteral("font")))
        {
            QFont font = text->font();
            font.fromString(asked.value(QStringLiteral("font")).toString());
            text->setFont(font);
        }
        if (asked.contains(QStringLiteral("animation")))
        {
            const QString wanted = asked.value(QStringLiteral("animation")).toString();
            if (RGBText::animationStyles().contains(wanted) == false)
                return Result::failure(QStringLiteral("Text animation must be one of: %1")
                                           .arg(RGBText::animationStyles().join(", ")));
            text->setAnimationStyle(RGBText::stringToAnimationStyle(wanted));
        }
    }

    if (body.contains(QStringLiteral("image")))
    {
        if (algorithm == nullptr || algorithm->type() != RGBAlgorithm::Image)
            return Result::failure(
                QStringLiteral("\"image\" belongs to the Image algorithm; this matrix runs %1")
                    .arg(algorithm != nullptr ? algorithm->name() : QStringLiteral("nothing")));
        RGBImage *image = static_cast<RGBImage *>(algorithm);

        const QJsonObject asked = body.value(QStringLiteral("image")).toObject();
        if (asked.contains(QStringLiteral("file")))
        {
            const QString file = asked.value(QStringLiteral("file")).toString();
            if (QFileInfo::exists(file) == false)
                return Result::failure(QStringLiteral("No file at %1").arg(file));
            image->setFilename(file);
        }
        if (asked.contains(QStringLiteral("animation")))
        {
            const QString wanted = asked.value(QStringLiteral("animation")).toString();
            if (RGBImage::animationStyles().contains(wanted) == false)
                return Result::failure(QStringLiteral("Image animation must be one of: %1")
                                           .arg(RGBImage::animationStyles().join(", ")));
            image->setAnimationStyle(RGBImage::stringToAnimationStyle(wanted));
        }
    }

    if (body.contains(QStringLiteral("properties")))
    {
        if (algorithm == nullptr || algorithm->type() != RGBAlgorithm::Script)
            return Result::failure(QStringLiteral(
                "\"properties\" belong to script algorithms; this matrix runs %1")
                    .arg(algorithm != nullptr ? algorithm->name() : QStringLiteral("nothing")));

        const QJsonObject asked = body.value(QStringLiteral("properties")).toObject();
        for (auto it = asked.constBegin(); it != asked.constEnd(); ++it)
        {
            /* Through the MATRIX, not the script instance: RGBMatrix keeps its
               own property map and reapplies it, so a value set on the bare
               script would be forgotten on the next load. */
            matrix->setProperty(it.key(), it.value().toString());
        }
    }

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::bakeMatrixToSequence(Doc *doc, quint32 matrixId, quint32 &sceneId,
                                                  quint32 &sequenceId)
{
    Function *function = doc->function(matrixId);
    if (function == nullptr || function->type() != Function::RGBMatrixType)
        return Result::failure(QStringLiteral("No RGB matrix with id %1").arg(matrixId));
    RGBMatrix *matrix = qobject_cast<RGBMatrix *>(function);

    FixtureGroup *group = doc->fixtureGroup(matrix->fixtureGroup());
    if (group == nullptr)
        return Result::failure(QStringLiteral("The matrix has no fixture group to bake"));
    if (matrix->algorithm() == nullptr)
        return Result::failure(QStringLiteral("The matrix has no algorithm to bake"));
    if (matrix->isRunning())
        return Result::failure(QStringLiteral("Stop the matrix before baking it"));

    const RGBMatrix::ControlMode mode = matrix->controlMode();

    /* The channel one head contributes under the current control mode; the
       reference's per-mode ladder, shared by the scene skeleton and the
       steps. */
    const auto headChannels = [doc, mode](const GroupHead &head) {
        QVector<QPair<quint32, quint32>> out; // (fixture, channel)
        Fixture *fixture = doc->fixture(head.fxi);
        if (fixture == nullptr)
            return out;

        if (mode == RGBMatrix::ControlModeRgb)
        {
            QVector<quint32> rgb = fixture->rgbChannels(head.head);
            if (rgb.count() == 0)
                rgb = fixture->cmyChannels(head.head);
            for (quint32 channel : rgb)
                out.append(qMakePair(head.fxi, channel));
            return out;
        }

        quint32 channel = QLCChannel::invalid();
        if (mode == RGBMatrix::ControlModeDimmer)
        {
            channel = fixture->masterIntensityChannel();
            if (channel == QLCChannel::invalid())
                channel = fixture->channelNumber(QLCChannel::Intensity, QLCChannel::MSB,
                                                 head.head);
        }
        else if (mode == RGBMatrix::ControlModeWhite)
            channel = fixture->channelNumber(QLCChannel::White, QLCChannel::MSB, head.head);
        else if (mode == RGBMatrix::ControlModeAmber)
            channel = fixture->channelNumber(QLCChannel::Amber, QLCChannel::MSB, head.head);
        else if (mode == RGBMatrix::ControlModeUV)
            channel = fixture->channelNumber(QLCChannel::UV, QLCChannel::MSB, head.head);
        else if (mode == RGBMatrix::ControlModeShutter)
        {
            const QVector<quint32> shutters = fixture->head(head.head).shutterChannels();
            if (shutters.count())
                channel = shutters.first();
        }

        if (channel != QLCChannel::invalid())
            out.append(qMakePair(head.fxi, channel));
        return out;
    };

    /* The bound scene: every channel the group can move, at zero. Hidden,
       like the reference makes it -- it exists to give the sequence words. */
    Scene *scene = new Scene(doc);
    scene->setName(group->name());
    scene->setVisible(false);
    for (const GroupHead &head : group->headList())
    {
        for (const auto &pair : headChannels(head))
            scene->setValue(pair.first, pair.second, 0);
    }
    doc->addFunction(scene);

    int totalSteps = matrix->stepsCount();
    int currentStep = 0;
    int increment = 1;

    RGBMatrixStep handler;
    handler.setStepColor(matrix->getColor(0));
    if (matrix->direction() == Function::Backward)
    {
        currentStep = totalSteps - 1;
        increment = -1;
        if (matrix->getColor(1).isValid())
            handler.setStepColor(matrix->getColor(1));
    }
    handler.calculateColorDelta(matrix->getColor(0), matrix->getColor(1), matrix->algorithm());

    if (matrix->runOrder() == Function::PingPong)
        totalSteps = (totalSteps * 2) - 1;

    Sequence *sequence = new Sequence(doc);
    sequence->setName(QStringLiteral("%1 Sequence").arg(matrix->name()));
    sequence->setBoundSceneID(scene->id());
    sequence->setDurationMode(Chaser::PerStep);
    sequence->setDuration(matrix->duration());
    if (matrix->fadeInSpeed() != 0)
    {
        sequence->setFadeInMode(Chaser::PerStep);
        sequence->setFadeInSpeed(matrix->fadeInSpeed());
    }
    if (matrix->fadeOutSpeed() != 0)
    {
        sequence->setFadeOutMode(Chaser::PerStep);
        sequence->setFadeOutSpeed(matrix->fadeOutSpeed());
    }

    for (int i = 0; i < totalSteps; i++)
    {
        matrix->previewMap(currentStep, &handler);

        ChaserStep step;
        step.fid = scene->id();
        step.hold = matrix->duration() - matrix->fadeInSpeed();
        step.duration = matrix->duration();
        step.fadeIn = matrix->fadeInSpeed();
        step.fadeOut = matrix->fadeOutSpeed();

        for (int y = 0; y < handler.m_map.size(); y++)
        {
            for (int x = 0; x < handler.m_map[y].size(); x++)
            {
                const uint colour = handler.m_map[y][x];
                const GroupHead head = group->head(QLCPoint(x, y));
                Fixture *fixture = doc->fixture(head.fxi);
                if (fixture == nullptr)
                    continue;

                const QVector<QPair<quint32, quint32>> channels = headChannels(head);
                if (mode == RGBMatrix::ControlModeRgb && channels.count() == 3)
                {
                    /* CMY heads bake the same three slots with the colour's
                       own CMY reading, exactly like the reference. */
                    const bool cmy = fixture->rgbChannels(head.head).count() == 0;
                    const QColor asColour(colour);
                    step.values.append(SceneValue(head.fxi, channels.at(0).second,
                                                  cmy ? asColour.cyan() : qRed(colour)));
                    step.values.append(SceneValue(head.fxi, channels.at(1).second,
                                                  cmy ? asColour.magenta() : qGreen(colour)));
                    step.values.append(SceneValue(head.fxi, channels.at(2).second,
                                                  cmy ? asColour.yellow() : qBlue(colour)));
                }
                else if (mode != RGBMatrix::ControlModeRgb && channels.count() == 1)
                {
                    step.values.append(SceneValue(head.fxi, channels.first().second,
                                                  RGBMatrix::rgbToGrey(colour)));
                }
            }
        }

        /* The reference's own warning: heads may sit anywhere in the grid,
           and a sequence needs its values ordered. */
        std::sort(step.values.begin(), step.values.end());

        sequence->addStep(step);
        currentStep += increment;
        if (currentStep == totalSteps)
        {
            if (matrix->runOrder() == Function::PingPong)
            {
                currentStep = totalSteps - 2;
                increment = -1;
            }
            else
                currentStep = 0;
        }
        handler.updateStepColor(currentStep, matrix->getColor(0), matrix->stepsCount());
    }

    doc->addFunction(sequence);

    sceneId = scene->id();
    sequenceId = sequence->id();
    doc->setModified();
    return Result::success();
}

namespace
{
    /* The one place JSON becomes palette values, mirroring loadXML's
       conversions so the API and the file agree on every shape. */
    DocWriter::Result applyPaletteBody(QLCPalette *palette, const QJsonObject &body)
    {
        using Result = DocWriter::Result;

        if (body.contains(QStringLiteral("name")))
            palette->setName(body.value(QStringLiteral("name")).toString());

        if (body.contains(QStringLiteral("values")))
        {
            const QJsonArray values = body.value(QStringLiteral("values")).toArray();
            switch (palette->type())
            {
            case QLCPalette::Color:
            {
                const QColor colour(values.at(0).toString());
                if (colour.isValid() == false)
                    return Result::failure(
                        QStringLiteral("A colour palette's value is \"#rrggbb\""));
                palette->setValue(values.at(0).toString());
                break;
            }
            case QLCPalette::PanTilt:
            case QLCPalette::Shutter:
                if (values.count() != 2)
                    return Result::failure(
                        QStringLiteral("This palette type takes two numbers"));
                palette->setValue(values.at(0).toInt(), values.at(1).toInt());
                break;
            case QLCPalette::Position3D:
                if (values.count() != 3)
                    return Result::failure(QStringLiteral("Position3D takes three numbers"));
                palette->setValue(values.at(0).toDouble(), values.at(1).toDouble(),
                                  values.at(2).toDouble());
                break;
            case QLCPalette::Undefined:
                return Result::failure(QStringLiteral("The palette has no type"));
            default:
                if (values.isEmpty())
                    return Result::failure(QStringLiteral("This palette type takes a number"));
                palette->setValue(values.at(0).toInt());
                break;
            }
        }

        if (body.contains(QStringLiteral("fanning")))
        {
            const QJsonObject fanning = body.value(QStringLiteral("fanning")).toObject();
            if (fanning.contains(QStringLiteral("type")))
            {
                const QString wanted = fanning.value(QStringLiteral("type")).toString();
                const QLCPalette::FanningType type = QLCPalette::stringToFanningType(wanted);
                if (QLCPalette::fanningTypeToString(type)
                        .compare(wanted, Qt::CaseInsensitive) != 0)
                    return Result::failure(QStringLiteral(
                        "Fanning type must be Flat, Linear, Sine, Square or Saw"));
                palette->setFanningType(type);
            }
            if (fanning.contains(QStringLiteral("layout")))
            {
                const QString wanted = fanning.value(QStringLiteral("layout")).toString();
                const QLCPalette::FanningLayout layout =
                    QLCPalette::stringToFanningLayout(wanted);
                if (QLCPalette::fanningLayoutToString(layout)
                        .compare(wanted, Qt::CaseInsensitive) != 0)
                    return Result::failure(QStringLiteral("Unknown fanning layout \"%1\"")
                                               .arg(wanted));
                palette->setFanningLayout(layout);
            }
            if (fanning.contains(QStringLiteral("amount")))
            {
                const int amount = fanning.value(QStringLiteral("amount")).toInt(-1);
                if (amount < 0 || amount > 100)
                    return Result::failure(QStringLiteral("Fanning amount is 0..100"));
                palette->setFanningAmount(amount);
            }
            if (fanning.contains(QStringLiteral("value")))
            {
                if (palette->type() == QLCPalette::Color)
                    palette->setFanningValue(
                        fanning.value(QStringLiteral("value")).toString());
                else
                    palette->setFanningValue(fanning.value(QStringLiteral("value")).toInt());
            }
        }

        return Result::success();
    }
}

DocWriter::Result DocWriter::addPalette(Doc *doc, const QString &type, const QString &name,
                                        const QJsonObject &body, quint32 &newId)
{
    const QLCPalette::PaletteType wanted = QLCPalette::stringToType(type);
    if (wanted == QLCPalette::Undefined
        || QLCPalette::typeToString(wanted).compare(type, Qt::CaseInsensitive) != 0)
    {
        return Result::failure(QStringLiteral(
            "Palette type must be Dimmer, Color, Pan, Tilt, PanTilt, Position3D, "
            "Shutter, Gobo or Zoom"));
    }

    QLCPalette *palette = new QLCPalette(wanted);
    palette->setName(name.isEmpty() ? QLCPalette::typeToString(wanted) : name);

    const Result applied = applyPaletteBody(palette, body);
    if (applied.ok == false)
    {
        delete palette;
        return applied;
    }

    if (doc->addPalette(palette) == false)
    {
        delete palette;
        return Result::failure(QStringLiteral("The engine refused the palette"));
    }

    newId = palette->id();
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::updatePalette(Doc *doc, quint32 id, const QJsonObject &body)
{
    QLCPalette *palette = doc->palette(id);
    if (palette == nullptr)
        return Result::failure(QStringLiteral("No palette with id %1").arg(id));

    const Result applied = applyPaletteBody(palette, body);
    if (applied.ok == false)
        return applied;

    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::removePalette(Doc *doc, quint32 id)
{
    if (doc->palette(id) == nullptr)
        return Result::failure(QStringLiteral("No palette with id %1").arg(id));

    /* Named where it is still used: a palette quietly removed from under a
       scene leaves the scene resolving nothing. */
    QStringList holders;
    for (const Function *function : doc->functions())
    {
        if (function->type() != Function::SceneType)
            continue;
        const Scene *scene = qobject_cast<const Scene *>(function);
        if (scene->palettes().contains(id))
            holders << scene->name();
    }
    if (holders.isEmpty() == false)
        return Result::failure(QStringLiteral("Still used by: %1").arg(holders.join(", ")));

    doc->deletePalette(id);
    doc->setModified();
    return Result::success();
}

DocWriter::Result DocWriter::setScenePalettes(Doc *doc, quint32 sceneId,
                                              const QList<quint32> &paletteIds,
                                              const QList<quint32> *fixtureIds)
{
    Function *function = doc->function(sceneId);
    if (function == nullptr || function->type() != Function::SceneType)
        return Result::failure(QStringLiteral("No scene with id %1").arg(sceneId));
    Scene *scene = qobject_cast<Scene *>(function);

    for (quint32 id : paletteIds)
    {
        if (doc->palette(id) == nullptr)
            return Result::failure(QStringLiteral("No palette with id %1").arg(id));
    }
    if (fixtureIds != nullptr)
    {
        for (quint32 id : *fixtureIds)
        {
            if (doc->fixture(id) == nullptr)
                return Result::failure(QStringLiteral("No fixture with id %1").arg(id));
        }
    }

    for (quint32 existing : scene->palettes())
        scene->removePalette(existing);
    for (quint32 id : paletteIds)
        scene->addPalette(id);

    if (fixtureIds != nullptr)
    {
        for (quint32 id : *fixtureIds)
            scene->addFixture(id);
    }

    doc->setModified();
    return Result::success();
}
