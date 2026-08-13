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

#include "docwriter.h"

#include "qlcfixturedefcache.h"
#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "fixturegroup.h"
#include "grouphead.h"
#include "qlcpoint.h"
#include "fixture.h"
#include "inputoutputmap.h"
#include "universe.h"
#include "outputpatch.h"
#include "universe.h"
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

    for (quint32 id : group->fixtureList())
        group->resignFixture(id);

    group->setSize(QSize(qMax(1, fixtureIds.count()), 1));

    int x = 0;
    for (quint32 id : fixtureIds)
        group->assignFixture(id, QLCPoint(x++, 0));

    doc->setModified();
    return Result::success();
}
