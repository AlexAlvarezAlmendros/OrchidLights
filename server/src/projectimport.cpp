/*
  OrchidLights
  projectimport.cpp

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

#include "projectimport.h"

#include <QFileInfo>
#include <QXmlStreamReader>
#include <QJsonArray>
#include <QMap>
#include <QSet>

#include "chaser.h"
#include "chaserstep.h"
#include "collection.h"
#include "doc.h"
#include "efx.h"
#include "efxfixture.h"
#include "fixture.h"
#include "fixturegroup.h"
#include "grouphead.h"
#include "qlcfile.h"

#define KXMLQLCWorkspace QStringLiteral("Workspace")
#include "qlcfixturedef.h"
#include "qlcfixturemode.h"
#include "qlcpalette.h"
#include "scene.h"
#include "scenevalue.h"
#include "script.h"
#include "sequence.h"
#include "rgbmatrix.h"

namespace
{
    /**
     * The foreign file into a scratch Doc that shares the live one's
     * definition cache. The cache reference MUST be nulled before the scratch
     * Doc dies, or its destructor deletes the cache the live Doc still uses.
     */
    class ForeignDoc
    {
    public:
        explicit ForeignDoc(Doc *main)
            : m_doc(new Doc(nullptr))
        {
            delete m_doc->fixtureDefCache();
            m_doc->setFixtureDefinitionCache(main->fixtureDefCache());
        }

        ~ForeignDoc()
        {
            m_doc->setFixtureDefinitionCache(nullptr);
            delete m_doc;
        }

        Doc *operator->() const { return m_doc; }
        Doc *get() const { return m_doc; }

        bool load(const QString &path, QString &error)
        {
            const QFileInfo info(path);
            if (info.isFile() == false)
            {
                error = QStringLiteral("There is no file at %1").arg(path);
                return false;
            }

            QXmlStreamReader *reader = QLCFile::getXMLReader(path);
            if (reader == nullptr || reader->device() == nullptr || reader->hasError())
            {
                if (reader != nullptr)
                    QLCFile::releaseXMLReader(reader);
                error = QStringLiteral("%1 could not be read").arg(path);
                return false;
            }

            while (reader->atEnd() == false)
            {
                if (reader->readNext() == QXmlStreamReader::DTD)
                    break;
            }

            bool ok = false;
            if (reader->hasError() == false && reader->dtdName() == KXMLQLCWorkspace
                && reader->readNextStartElement() && reader->name() == KXMLQLCWorkspace)
            {
                m_doc->setWorkspacePath(info.absolutePath());
                while (reader->readNextStartElement())
                {
                    if (reader->name() == KXMLQLCEngine)
                    {
                        m_doc->loadXML(*reader, false);
                        ok = true;
                    }
                    else
                    {
                        reader->skipCurrentElement();
                    }
                }
            }

            QLCFile::releaseXMLReader(reader);
            if (ok == false)
                error = QStringLiteral("%1 is not a QLC+ workspace").arg(path);
            return ok;
        }

    private:
        Doc *m_doc;
    };

    /**
     * The first run of channels that holds the fixture, starting from where it
     * stood in the foreign project -- ported from importmanager.cpp:195, with
     * the walk capped so it cannot wander into a universe the project does not
     * have (the reference happily does).
     */
    bool availableAddress(Doc *doc, int channels, int &universe, int &address)
    {
        const int universes = int(doc->inputOutputMap()->universesCount());
        quint32 absolute = (quint32(universe) << 9) + quint32(address);
        const quint32 end = quint32(universes) << 9;
        int freeRun = 0;

        while (absolute < end)
        {
            if (doc->fixtureForAddress(absolute) == Fixture::invalidId())
                freeRun++;
            else
                freeRun = 0;

            if (freeRun == channels)
            {
                universe = int(absolute >> 9);
                address = int(absolute) - universe * 512 - (channels - 1);
                return true;
            }

            absolute++;
            /* A run cannot straddle two universes. */
            if ((absolute & 511) == 0)
                freeRun = 0;
        }

        return false;
    }

    struct ImportState
    {
        Doc *doc = nullptr;
        Doc *foreign = nullptr;
        QMap<quint32, quint32> fixtureRemap;
        QMap<quint32, quint32> groupRemap;
        QMap<quint32, quint32> paletteRemap;
        QMap<quint32, quint32> functionRemap;
        QList<quint32> pendingFunctions;
        int fixturesCreated = 0;
        int fixturesReused = 0;
        int groupsCreated = 0;
        int palettesCreated = 0;
        int functionsCreated = 0;
        QStringList skipped;
    };

    bool importFixtures(ImportState &state, const QList<quint32> &wanted, QString &error)
    {
        for (quint32 importId : wanted)
        {
            Fixture *foreign = state.foreign->fixture(importId);
            if (foreign == nullptr)
            {
                error = QStringLiteral("The file has no fixture with id %1").arg(importId);
                return false;
            }

            /* A fixture with the same name is the same fixture: reuse it
               rather than patching a twin next to it. */
            bool matched = false;
            for (Fixture *ours : state.doc->fixtures())
            {
                if (ours->name() == foreign->name())
                {
                    state.fixtureRemap[importId] = ours->id();
                    state.fixturesReused++;
                    matched = true;
                    break;
                }
            }
            if (matched)
                continue;

            QLCFixtureDef *foreignDef = foreign->fixtureDef();
            QLCFixtureMode *foreignMode = foreign->fixtureMode();
            QLCFixtureDef *def = nullptr;
            QLCFixtureMode *mode = nullptr;
            if (foreignDef != nullptr && foreignMode != nullptr)
            {
                def = state.doc->fixtureDefCache()->fixtureDef(foreignDef->manufacturer(),
                                                               foreignDef->model());
                if (def != nullptr)
                    mode = def->mode(foreignMode->name());
            }

            Fixture *fixture = new Fixture(state.doc);
            fixture->setName(foreign->name());

            int universe = int(foreign->universe());
            int address = int(foreign->address());
            if (availableAddress(state.doc, int(foreign->channels()), universe, address) == false)
            {
                /* Out of room: add a universe rather than dropping the lamp on
                   somebody -- the RGB panel wizard already does the same. */
                state.doc->inputOutputMap()->addUniverse();
                state.doc->inputOutputMap()->startUniverses();
                universe = int(state.doc->inputOutputMap()->universesCount()) - 1;
                address = 0;
            }
            fixture->setUniverse(quint32(universe));
            fixture->setAddress(quint32(address));

            if ((def == nullptr || mode == nullptr) && foreignDef != nullptr
                && foreignMode != nullptr && foreignDef->model() == KXMLFixtureRGBPanel)
            {
                /* Panel definitions are generated, not cached, so they travel
                   by deep copy -- the same move Doc::replaceFixtures makes. */
                QLCFixtureDef *copyDef = new QLCFixtureDef();
                *copyDef = *foreignDef;
                QLCFixtureMode *copyMode = new QLCFixtureMode(copyDef);
                *copyMode = *foreignMode;
                def = copyDef;
                mode = copyMode;
            }
            else if (def == nullptr || mode == nullptr)
            {
                /* The definition did not travel: a generic dimmer of the same
                   width keeps the channels addressable, and the summary's
                   "resolved" flag says what happened. */
                def = fixture->genericDimmerDef(int(foreign->channels()));
                mode = fixture->genericDimmerMode(def, int(foreign->channels()));
            }
            fixture->setFixtureDefinition(def, mode);

            if (state.doc->addFixture(fixture) == false)
            {
                delete fixture;
                error = QStringLiteral("The engine refused fixture \"%1\"").arg(foreign->name());
                return false;
            }

            state.fixtureRemap[importId] = fixture->id();
            state.fixturesCreated++;
        }

        return true;
    }

    void importGroups(ImportState &state)
    {
        const QList<quint32> chosen = state.fixtureRemap.keys();
        const QSet<quint32> chosenSet(chosen.begin(), chosen.end());

        for (FixtureGroup *foreign : state.foreign->fixtureGroups())
        {
            /* Only groups the selection fully covers: a half-imported matrix
               would snake across lamps that are not there. */
            const QList<quint32> members = foreign->fixtureList();
            if (members.isEmpty())
                continue;
            bool covered = true;
            for (quint32 member : members)
            {
                if (chosenSet.contains(member) == false)
                {
                    covered = false;
                    break;
                }
            }
            if (covered == false)
            {
                state.skipped.append(QStringLiteral("grupo \"%1\" (fixtures fuera de la selección)")
                                         .arg(foreign->name()));
                continue;
            }

            bool matched = false;
            for (FixtureGroup *ours : state.doc->fixtureGroups())
            {
                if (ours->name() == foreign->name())
                {
                    state.groupRemap[foreign->id()] = ours->id();
                    matched = true;
                    break;
                }
            }
            if (matched)
                continue;

            FixtureGroup *group = new FixtureGroup(state.doc);
            group->setName(foreign->name());
            group->setSize(foreign->size());

            if (state.doc->addFixtureGroup(group) == false)
            {
                delete group;
                continue;
            }

            const QMap<QLCPoint, GroupHead> heads = foreign->headsMap();
            for (auto it = heads.constBegin(); it != heads.constEnd(); ++it)
            {
                GroupHead head = it.value();
                head.fxi = state.fixtureRemap.value(head.fxi);
                group->assignHead(it.key(), head);
            }

            state.groupRemap[foreign->id()] = group->id();
            state.groupsCreated++;
        }
    }

    void importPalette(ImportState &state, quint32 paletteId)
    {
        if (state.paletteRemap.contains(paletteId))
            return;

        QLCPalette *foreign = state.foreign->palette(paletteId);
        if (foreign == nullptr)
            return;

        /* The reference has this remap landing in the FIXTURE map
           (importmanager.cpp:396) -- ported onto the right one. */
        for (QLCPalette *ours : state.doc->palettes())
        {
            if (ours->name() == foreign->name())
            {
                state.paletteRemap[paletteId] = ours->id();
                return;
            }
        }

        QLCPalette *palette = new QLCPalette(foreign->type());
        palette->setName(foreign->name());
        palette->setValues(foreign->values());
        palette->setFanningType(foreign->fanningType());
        palette->setFanningLayout(foreign->fanningLayout());
        palette->setFanningAmount(foreign->fanningAmount());
        palette->setFanningValue(foreign->fanningValue());

        if (state.doc->addPalette(palette) == false)
        {
            delete palette;
            return;
        }

        state.paletteRemap[paletteId] = palette->id();
        state.palettesCreated++;
    }

    QList<SceneValue> remapValues(const ImportState &state, const QList<SceneValue> &values)
    {
        QList<SceneValue> result;
        for (SceneValue value : values)
        {
            if (state.fixtureRemap.contains(value.fxi) == false)
                continue;
            value.fxi = state.fixtureRemap.value(value.fxi);
            result.append(value);
        }
        return result;
    }

    void importFunction(ImportState &state, quint32 functionId)
    {
        if (state.pendingFunctions.contains(functionId) == false)
            return;

        Function *foreign = state.foreign->function(functionId);
        /* Taken off the list FIRST: a chaser that somehow contains itself must
           not recurse forever. */
        state.pendingFunctions.removeOne(functionId);
        if (foreign == nullptr)
            return;

        /* Dependencies first, so the copy's references can be remapped. */
        QList<quint32> dependencies;
        switch (foreign->type())
        {
            case Function::ChaserType:
            case Function::SequenceType:
            case Function::CollectionType:
                dependencies = foreign->components();
                break;
            case Function::ScriptType:
                dependencies = qobject_cast<Script *>(foreign)->functionList();
                break;
            default:
                break;
        }
        for (quint32 dependency : dependencies)
            importFunction(state, dependency);

        Function *copy = foreign->createCopy(state.doc, true);
        if (copy == nullptr)
            return;
        state.functionRemap[functionId] = copy->id();
        state.functionsCreated++;

        switch (copy->type())
        {
            case Function::SceneType:
            {
                Scene *scene = qobject_cast<Scene *>(copy);
                const QList<SceneValue> values = scene->values();
                const QList<quint32> groups = scene->fixtureGroups();
                const QList<quint32> palettes = scene->palettes();

                scene->clear();

                for (quint32 group : groups)
                {
                    if (state.groupRemap.contains(group))
                        scene->addFixtureGroup(state.groupRemap.value(group));
                }
                for (quint32 palette : palettes)
                {
                    importPalette(state, palette);
                    if (state.paletteRemap.contains(palette))
                        scene->addPalette(state.paletteRemap.value(palette));
                }
                for (const SceneValue &value : remapValues(state, values))
                {
                    scene->addFixture(value.fxi);
                    scene->setValue(value);
                }
                break;
            }
            case Function::CollectionType:
            {
                Collection *collection = qobject_cast<Collection *>(copy);
                const QList<quint32> members = collection->functions();
                for (quint32 member : members)
                    collection->removeFunction(member);
                for (quint32 member : members)
                {
                    if (state.functionRemap.contains(member))
                        collection->addFunction(state.functionRemap.value(member));
                }
                break;
            }
            case Function::ChaserType:
            {
                Chaser *chaser = qobject_cast<Chaser *>(copy);
                QList<int> orphans;
                for (int i = 0; i < chaser->stepsCount(); i++)
                {
                    ChaserStep *step = chaser->stepAt(i);
                    if (state.functionRemap.contains(step->fid))
                        step->fid = state.functionRemap.value(step->fid);
                    else if (state.doc->function(step->fid) == nullptr)
                        orphans.append(i);
                }
                for (int i = orphans.count() - 1; i >= 0; i--)
                    chaser->removeStep(orphans.at(i));
                break;
            }
            case Function::SequenceType:
            {
                Sequence *sequence = qobject_cast<Sequence *>(copy);
                const quint32 bound = sequence->boundSceneID();
                if (bound != Function::invalidId() && state.functionRemap.contains(bound))
                    sequence->setBoundSceneID(state.functionRemap.value(bound));

                /* The reference leaves each step's values pointing at the
                   foreign fixture ids -- lamps that are not there, or worse,
                   somebody else's. Remapped here like a scene's. */
                for (int i = 0; i < sequence->stepsCount(); i++)
                {
                    ChaserStep *step = sequence->stepAt(i);
                    step->values = remapValues(state, step->values);
                }
                break;
            }
            case Function::EFXType:
            {
                /* The reference remaps these heads through the FUNCTION map
                   (importmanager.cpp:574) -- fixtures go through the fixture
                   map. */
                EFX *efx = qobject_cast<EFX *>(copy);
                for (EFXFixture *head : efx->fixtures())
                {
                    GroupHead groupHead(head->head());
                    if (state.fixtureRemap.contains(groupHead.fxi))
                    {
                        groupHead.fxi = state.fixtureRemap.value(groupHead.fxi);
                        head->setHead(groupHead);
                    }
                }
                break;
            }
            case Function::RGBMatrixType:
            {
                RGBMatrix *matrix = qobject_cast<RGBMatrix *>(copy);
                if (matrix->fixtureGroup() != FixtureGroup::invalidId()
                    && state.groupRemap.contains(matrix->fixtureGroup()))
                {
                    matrix->setFixtureGroup(state.groupRemap.value(matrix->fixtureGroup()));
                }
                break;
            }
            default:
                break;
        }
    }
}

DocWriter::Result ProjectImport::preview(Doc *doc, const QString &path, QJsonObject &out)
{
    ForeignDoc foreign(doc);
    QString error;
    if (foreign.load(path, error) == false)
        return DocWriter::Result::failure(error);

    QJsonArray fixtures;
    for (const Fixture *fixture : foreign->fixtures())
    {
        QJsonObject entry;
        entry["id"] = qint64(fixture->id());
        entry["name"] = fixture->name();
        entry["universe"] = qint64(fixture->universe()) + 1;
        entry["address"] = qint64(fixture->address()) + 1;
        entry["channels"] = qint64(fixture->channels());
        if (fixture->fixtureDef() != nullptr)
        {
            entry["manufacturer"] = fixture->fixtureDef()->manufacturer();
            entry["model"] = fixture->fixtureDef()->model();
        }
        fixtures.append(entry);
    }

    QJsonArray functions;
    for (const Function *function : foreign->functions())
    {
        QJsonObject entry;
        entry["id"] = qint64(function->id());
        entry["name"] = function->name();
        entry["type"] = Function::typeToString(function->type());
        functions.append(entry);
    }

    out["fixtures"] = fixtures;
    out["functions"] = functions;
    out["groups"] = foreign->fixtureGroups().count();
    out["palettes"] = foreign->palettes().count();
    return DocWriter::Result::success();
}

DocWriter::Result ProjectImport::apply(Doc *doc, const QString &path, const Selection &selection,
                                       QJsonObject &report)
{
    ForeignDoc foreign(doc);
    QString error;
    if (foreign.load(path, error) == false)
        return DocWriter::Result::failure(error);

    ImportState state;
    state.doc = doc;
    state.foreign = foreign.get();

    QList<quint32> wantedFixtures;
    if (selection.allFixtures)
    {
        for (const Fixture *fixture : foreign->fixtures())
            wantedFixtures.append(fixture->id());
    }
    else
    {
        wantedFixtures = selection.fixtures;
    }
    std::sort(wantedFixtures.begin(), wantedFixtures.end());

    if (selection.allFunctions)
    {
        for (const Function *function : foreign->functions())
            state.pendingFunctions.append(function->id());
    }
    else
    {
        state.pendingFunctions = selection.functions;
        for (quint32 id : selection.functions)
        {
            if (foreign->function(id) == nullptr)
            {
                return DocWriter::Result::failure(
                    QStringLiteral("The file has no function with id %1").arg(id));
            }
        }
    }

    if (importFixtures(state, wantedFixtures, error) == false)
        return DocWriter::Result::failure(error);

    importGroups(state);

    while (state.pendingFunctions.isEmpty() == false)
        importFunction(state, state.pendingFunctions.first());

    QJsonObject remapped;
    for (auto it = state.functionRemap.constBegin(); it != state.functionRemap.constEnd(); ++it)
        remapped[QString::number(it.key())] = qint64(it.value());

    report["fixturesCreated"] = state.fixturesCreated;
    report["fixturesReused"] = state.fixturesReused;
    report["groupsCreated"] = state.groupsCreated;
    report["palettesCreated"] = state.palettesCreated;
    report["functionsCreated"] = state.functionsCreated;
    report["functionIds"] = remapped;
    if (state.skipped.isEmpty() == false)
        report["skipped"] = QJsonArray::fromStringList(state.skipped);

    doc->setModified();
    return DocWriter::Result::success();
}
