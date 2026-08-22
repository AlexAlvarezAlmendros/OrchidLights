/*
  OrchidLights
  undoring.h

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

#ifndef UNDORING_H
#define UNDORING_H

#include <QByteArray>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QList>
#include <QString>

class Doc;
class EngineHost;

/**
 * Global undo, the way the plan decided it (decision 4): every mutating route
 * snapshots the entity it touches -- its own XML, the same element the .qxw
 * carries -- before and after, into a ring of ~200. Undo swaps the before
 * back through the engine's own loaders; redo swaps the after. Functionally
 * the reference's Tardis ("every edit is undoable, the live desk is not")
 * without replicating its ~180 inverse actions.
 *
 * What is deliberately outside the ring: the live desk and the running state
 * (stopping a chaser is not an edit), I/O patching (the Tardis does not
 * record it either), and the macro operations -- remap, import -- whose undo
 * would need a full-document reload that cuts every running function.
 *
 * The console is inside via MARKERS: the Virtual Console already keeps its
 * own string-swap history in EngineHost, so a console entry here simply
 * delegates to it, keeping one global ordering across both worlds.
 */
class UndoRing final
{
public:
    enum Scope
    {
        FunctionScope,
        FixtureScope,
        GroupScope,
        PaletteScope,
        ConsoleScope,
        MonitorScope,
        ChannelsScope
    };

    struct Item
    {
        quint32 id = 0;
        QByteArray before;  //!< empty means "did not exist"
        QByteArray after;
    };

    struct Entry
    {
        Scope scope = FunctionScope;
        QString label;
        QList<Item> items;
        qint64 stamp = 0;
    };

    explicit UndoRing(EngineHost *engine);

    /* ---- capture -------------------------------------------------------- */

    /** The entity's current state, in the same XML the .qxw carries.
     *  Fixtures ride with their plan item, because deleting a lamp deletes
     *  where it stood and undo must bring both back. */
    static QByteArray snapshot(Doc *doc, Scope scope, quint32 id);

    /** Push a finished entry. Same scope+label+ids within a second COALESCE
     *  (a drag is one gesture, not forty edits): the first before is kept,
     *  the after replaced. */
    void push(Scope scope, const QString &label, const QList<Item> &items);

    /** A console gesture happened; the VC's own history holds the payload. */
    void pushConsoleMarker(const QString &label);

    /* ---- apply ---------------------------------------------------------- */

    bool canUndo() const { return m_done.isEmpty() == false; }
    bool canRedo() const { return m_undone.isEmpty() == false; }

    /** Swap the top entry's before back in. Returns the label, or an empty
     *  string with error set. */
    QString undo(Doc *doc, QString &error);
    QString redo(Doc *doc, QString &error);

    QJsonArray history() const;

private:
    bool apply(Doc *doc, const Entry &entry, bool forward, QString &error);

    EngineHost *m_engine;
    QList<Entry> m_done;
    QList<Entry> m_undone;
    QElapsedTimer m_clock;
};

/**
 * The capture half, made cheap enough to sprinkle: construct one at the top
 * of a mutating DocWriter method and every success path's UNDO_COMMIT() seals
 * the entry. A guard that is never committed (validation refused the edit)
 * evaporates. Thread-local on purpose -- the commit macro must find the guard
 * of ITS call without threading a pointer through sixty signatures.
 */
class UndoGuard final
{
public:
    UndoGuard(Doc *doc, UndoRing::Scope scope, const QString &label,
              const QList<quint32> &ids);
    UndoGuard(Doc *doc, UndoRing::Scope scope, const QString &label, quint32 id);
    ~UndoGuard();

    void commit();

    /** A creation learns its id after the fact: add it with an empty before. */
    void note(quint32 id);

    static void setRing(UndoRing *ring);
    static void commitCurrent();

private:
    Doc *m_doc;
    UndoRing::Scope m_scope;
    QString m_label;
    QList<UndoRing::Item> m_items;
    bool m_committed = false;
    UndoGuard *m_previous = nullptr;
};

/** Seals the innermost active guard, if any. Placed on every success path. */
#define UNDO_COMMIT() UndoGuard::commitCurrent()

#endif
