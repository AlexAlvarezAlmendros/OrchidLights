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

#include "inputoutputmap.h"
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
    bool lineExists(const QStringList &lines, const QString &name, quint32 &index)
    {
        for (int i = 0; i < lines.count(); i++)
        {
            /* Plugins report lines as "1: eth0 192.168.1.42" and similar, so
               match on containment rather than equality: the caller should be
               able to pass back exactly what the API handed it, or just the
               distinguishing part. */
            if (lines.at(i) == name || lines.at(i).contains(name))
            {
                index = quint32(i);
                return true;
            }
        }
        return false;
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
        /* Clearing the patch: the universe keeps running, it just stops
           reaching anything. */
        map->setOutputPatch(quint32(engine), QString(), QString(), QString(), 0, false, 0);
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
