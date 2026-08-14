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
#include <QColor>
#include <QSet>

#include "docwriter.h"

#include "rgbalgorithm.h"
#include "efxfixture.h"
#include "grouphead.h"
#include "collection.h"
#include "rgbmatrix.h"
#include "sequence.h"
#include "chaser.h"
#include "script.h"
#include "scene.h"
#include "show.h"
#include "audio.h"
#include "video.h"
#include "efx.h"
#include "chaserstep.h"
#include "qlcfixturedefcache.h"
#include "qlcfixturemode.h"
#include "qlcfixturedef.h"
#include "fixturegroup.h"
#include "grouphead.h"
#include "qlcpoint.h"
#include "fixture.h"
#include "inputoutputmap.h"
#include "outputpatch.h"
#include "universe.h"
#include "audioplugincache.h"
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
    if (function == nullptr || function->type() != Function::ChaserType)
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
    if (function == nullptr || function->type() != Function::ChaserType)
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
                                            double volume)
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
