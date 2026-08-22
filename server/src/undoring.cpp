/*
  OrchidLights
  undoring.cpp

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

#include "undoring.h"

#include <QBuffer>
#include <functional>
#include <QJsonDocument>
#include <QJsonObject>
#include <QXmlStreamReader>
#include <QXmlStreamWriter>

#include "doc.h"
#include "enginehost.h"
#include "fixture.h"
#include "channelsgroup.h"
#include "fixturegroup.h"
#include "function.h"
#include "monitorproperties.h"
#include "qlcpalette.h"

namespace
{
    constexpr int RING = 200;
    constexpr qint64 COALESCE_MS = 1000;

    UndoRing *s_ring = nullptr;
    thread_local UndoGuard *s_current = nullptr;

    QByteArray writeElement(const std::function<void(QXmlStreamWriter &)> &write)
    {
        QBuffer buffer;
        buffer.open(QIODevice::WriteOnly);
        QXmlStreamWriter writer(&buffer);
        write(writer);
        return buffer.data();
    }

    /** The plan item of head 0 (and only head 0: per-head undo would need a
     *  matrix of snapshots for a rare edit; the head items ride along inside
     *  MonitorProperties and survive everything except deletion). */
    QJsonObject planOf(Doc *doc, quint32 fixtureId)
    {
        MonitorProperties *monitor = doc->monitorProperties();
        QJsonObject plan;
        if (monitor->containsFixture(fixtureId) == false)
            return plan;

        const QVector3D position = monitor->fixturePosition(fixtureId, 0, 0);
        const QVector3D rotation = monitor->fixtureRotation(fixtureId, 0, 0);
        plan["x"] = position.x();
        plan["y"] = position.y();
        plan["z"] = position.z();
        plan["rx"] = rotation.x();
        plan["ry"] = rotation.y();
        plan["rz"] = rotation.z();
        const QColor gel = monitor->fixtureGelColor(fixtureId, 0, 0);
        if (gel.isValid())
            plan["gel"] = gel.name();
        plan["zoom"] = monitor->fixtureFixedZoom(fixtureId, 0, 0);
        plan["flags"] = int(monitor->fixtureFlags(fixtureId, 0, 0));
        plan["placed"] = true;
        return plan;
    }

    void restorePlan(Doc *doc, quint32 fixtureId, const QJsonObject &plan)
    {
        MonitorProperties *monitor = doc->monitorProperties();
        if (plan.value("placed").toBool() == false)
        {
            if (monitor->containsFixture(fixtureId))
                monitor->removeFixture(fixtureId, 0, 0);
            return;
        }

        monitor->setFixturePosition(fixtureId, 0, 0,
                                    QVector3D(float(plan.value("x").toDouble()),
                                              float(plan.value("y").toDouble()),
                                              float(plan.value("z").toDouble())));
        monitor->setFixtureRotation(fixtureId, 0, 0,
                                    QVector3D(float(plan.value("rx").toDouble()),
                                              float(plan.value("ry").toDouble()),
                                              float(plan.value("rz").toDouble())));
        monitor->setFixtureGelColor(fixtureId, 0, 0, QColor(plan.value("gel").toString()));
        monitor->setFixtureFixedZoom(fixtureId, 0, 0, plan.value("zoom").toInt());
        monitor->setFixtureFlags(fixtureId, 0, 0, quint32(plan.value("flags").toInt()));
    }
}

/*****************************************************************************
 * UndoRing
 *****************************************************************************/

UndoRing::UndoRing(EngineHost *engine)
    : m_engine(engine)
{
    m_clock.start();
}

QByteArray UndoRing::snapshot(Doc *doc, Scope scope, quint32 id)
{
    switch (scope)
    {
        case FunctionScope:
        {
            const Function *function = doc->function(id);
            if (function == nullptr)
                return QByteArray();
            return writeElement([&](QXmlStreamWriter &w) { function->saveXML(&w); });
        }
        case FixtureScope:
        {
            const Fixture *fixture = doc->fixture(id);
            if (fixture == nullptr)
                return QByteArray();

            /* The fixture and where it stands, together: deleting a lamp
               deletes its place on the plan, and undo brings both back. */
            QJsonObject wrapper;
            wrapper["entity"] = QString::fromUtf8(
                writeElement([&](QXmlStreamWriter &w) { fixture->saveXML(&w); }));
            wrapper["plan"] = planOf(doc, id);
            return QJsonDocument(wrapper).toJson(QJsonDocument::Compact);
        }
        case GroupScope:
        {
            const FixtureGroup *group = doc->fixtureGroup(id);
            if (group == nullptr)
                return QByteArray();
            return writeElement([&](QXmlStreamWriter &w) { group->saveXML(&w); });
        }
        case PaletteScope:
        {
            const QLCPalette *palette = doc->palette(id);
            if (palette == nullptr)
                return QByteArray();
            return writeElement([&](QXmlStreamWriter &w) { palette->saveXML(&w); });
        }
        case ChannelsScope:
        {
            const ChannelsGroup *group = doc->channelsGroup(id);
            if (group == nullptr)
                return QByteArray();
            return writeElement([&](QXmlStreamWriter &w) { group->saveXML(&w); });
        }
        default:
            return QByteArray();
    }
}

void UndoRing::push(Scope scope, const QString &label, const QList<Item> &items)
{
    if (items.isEmpty())
        return;

    bool changed = false;
    for (const Item &item : items)
    {
        if (item.before != item.after)
        {
            changed = true;
            break;
        }
    }
    if (changed == false)
        return;

    const qint64 now = m_clock.elapsed();

    /* A drag is one gesture: the same edit on the same things within a
       second folds into the previous entry, before kept, after replaced. */
    if (m_done.isEmpty() == false)
    {
        Entry &last = m_done.last();
        if (last.scope == scope && last.label == label
            && now - last.stamp < COALESCE_MS
            && last.items.count() == items.count())
        {
            bool sameIds = true;
            for (int i = 0; i < items.count(); i++)
            {
                if (last.items.at(i).id != items.at(i).id)
                {
                    sameIds = false;
                    break;
                }
            }
            if (sameIds)
            {
                for (int i = 0; i < items.count(); i++)
                    last.items[i].after = items.at(i).after;
                last.stamp = now;
                m_undone.clear();
                return;
            }
        }
    }

    Entry entry;
    entry.scope = scope;
    entry.label = label;
    entry.items = items;
    entry.stamp = now;
    m_done.append(entry);
    if (m_done.count() > RING)
        m_done.removeFirst();
    m_undone.clear();
}

void UndoRing::pushConsoleMarker(const QString &label)
{
    Entry entry;
    entry.scope = ConsoleScope;
    entry.label = label;
    entry.stamp = m_clock.elapsed();
    /* One placeholder item so the entry survives the empty check; the VC's
       own history holds the payload. */
    Item marker;
    marker.after = QByteArrayLiteral("console");
    entry.items.append(marker);
    m_done.append(entry);
    if (m_done.count() > RING)
        m_done.removeFirst();
    m_undone.clear();
}

QString UndoRing::undo(Doc *doc, QString &error)
{
    if (m_done.isEmpty())
    {
        error = QStringLiteral("Nothing to undo");
        return QString();
    }

    Entry entry = m_done.takeLast();
    if (apply(doc, entry, false, error) == false)
    {
        /* A failed apply puts the entry back rather than eating it. */
        m_done.append(entry);
        return QString();
    }

    m_undone.append(entry);
    return entry.label;
}

QString UndoRing::redo(Doc *doc, QString &error)
{
    if (m_undone.isEmpty())
    {
        error = QStringLiteral("Nothing to redo");
        return QString();
    }

    Entry entry = m_undone.takeLast();
    if (apply(doc, entry, true, error) == false)
    {
        m_undone.append(entry);
        return QString();
    }

    m_done.append(entry);
    return entry.label;
}

bool UndoRing::apply(Doc *doc, const Entry &entry, bool forward, QString &error)
{
    if (entry.scope == ConsoleScope)
    {
        const bool ok = forward ? m_engine->redoConsole() : m_engine->undoConsole();
        if (ok == false)
            error = QStringLiteral("The console has nothing on its stack for this");
        return ok;
    }

    for (int i = entry.items.count() - 1; i >= 0; i--)
    {
        const Item &item = entry.items.at(i);
        const QByteArray &target = forward ? item.after : item.before;

        switch (entry.scope)
        {
            case FunctionScope:
            {
                Function *existing = doc->function(item.id);
                if (existing != nullptr)
                {
                    /* The runner may be holding this. Stopping ONLY this
                       function is the whole point of entity-sized undo:
                       everything else keeps playing. */
                    if (existing->isRunning())
                        existing->stopAndWait();
                    doc->deleteFunction(item.id);
                }
                if (target.isEmpty())
                    break;

                QXmlStreamReader reader(target);
                reader.readNextStartElement();
                if (Function::loader(reader, doc) == false)
                {
                    error = QStringLiteral("The engine refused the stored function back");
                    return false;
                }
                break;
            }
            case FixtureScope:
            {
                if (doc->fixture(item.id) != nullptr)
                {
                    m_engine->forgetFixture(item.id);
                    doc->deleteFixture(item.id);
                }
                if (target.isEmpty())
                    break;

                const QJsonObject wrapper = QJsonDocument::fromJson(target).object();
                QXmlStreamReader reader(wrapper.value("entity").toString());
                reader.readNextStartElement();
                if (Fixture::loader(reader, doc) == false)
                {
                    error = QStringLiteral("The engine refused the stored fixture back");
                    return false;
                }
                restorePlan(doc, item.id, wrapper.value("plan").toObject());
                break;
            }
            case GroupScope:
            {
                if (doc->fixtureGroup(item.id) != nullptr)
                    doc->deleteFixtureGroup(item.id);
                if (target.isEmpty())
                    break;

                QXmlStreamReader reader(target);
                reader.readNextStartElement();
                if (FixtureGroup::loader(reader, doc) == false)
                {
                    error = QStringLiteral("The engine refused the stored group back");
                    return false;
                }
                break;
            }
            case ChannelsScope:
            {
                if (doc->channelsGroup(item.id) != nullptr)
                    doc->deleteChannelsGroup(item.id);
                if (target.isEmpty())
                    break;

                QXmlStreamReader reader(target);
                reader.readNextStartElement();
                if (ChannelsGroup::loader(reader, doc) == false)
                {
                    error = QStringLiteral("The engine refused the stored channels group back");
                    return false;
                }
                break;
            }
            case PaletteScope:
            {
                if (doc->palette(item.id) != nullptr)
                    doc->deletePalette(item.id);
                if (target.isEmpty())
                    break;

                QXmlStreamReader reader(target);
                reader.readNextStartElement();
                if (QLCPalette::loader(reader, doc) == false)
                {
                    error = QStringLiteral("The engine refused the stored palette back");
                    return false;
                }
                break;
            }
            default:
                break;
        }
    }

    doc->setModified();
    return true;
}

QJsonArray UndoRing::history() const
{
    QJsonArray list;
    for (const Entry &entry : m_done)
    {
        QJsonObject one;
        one["label"] = entry.label;
        one["scope"] = int(entry.scope);
        one["items"] = entry.items.count();
        list.append(one);
    }
    return list;
}

/*****************************************************************************
 * UndoGuard
 *****************************************************************************/

UndoGuard::UndoGuard(Doc *doc, UndoRing::Scope scope, const QString &label,
                     const QList<quint32> &ids)
    : m_doc(doc)
    , m_scope(scope)
    , m_label(label)
{
    for (quint32 id : ids)
    {
        UndoRing::Item item;
        item.id = id;
        item.before = UndoRing::snapshot(doc, scope, id);
        m_items.append(item);
    }

    m_previous = s_current;
    s_current = this;
}

UndoGuard::UndoGuard(Doc *doc, UndoRing::Scope scope, const QString &label, quint32 id)
    : UndoGuard(doc, scope, label, QList<quint32>{id})
{
}

UndoGuard::~UndoGuard()
{
    s_current = m_previous;
}

void UndoGuard::note(quint32 id)
{
    UndoRing::Item item;
    item.id = id;
    m_items.append(item);
}

void UndoGuard::commit()
{
    if (m_committed || s_ring == nullptr)
        return;
    m_committed = true;

    for (UndoRing::Item &item : m_items)
        item.after = UndoRing::snapshot(m_doc, m_scope, item.id);

    s_ring->push(m_scope, m_label, m_items);
}

void UndoGuard::setRing(UndoRing *ring)
{
    s_ring = ring;
}

void UndoGuard::commitCurrent()
{
    if (s_current != nullptr)
        s_current->commit();
}
