/*
  OrchidLights
  xmltree.h

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

#ifndef XMLTREE_H
#define XMLTREE_H

#include <QStringList>
#include <QString>
#include <QVector>
#include <QPair>

/**
 * A verbatim XML tree, for editing a document we do not understand.
 *
 * The Virtual Console section of a .qxw holds 489 persisted fields across
 * eleven widget types; this daemon models 124 of them. Regenerating that
 * section from the model would therefore delete most of it -- every input and
 * key binding in the show, every button's action, the fonts, the grand master.
 *
 * So the section is never regenerated. It is parsed into this tree, which
 * interprets nothing: element name, attributes in their original order, text
 * and children, all copied. Editing means patching nodes; everything not
 * patched is written back exactly as it arrived, including elements from a
 * QLC+ newer than this code.
 *
 * The rule that makes it hold: never reorder or drop a node you did not
 * author.
 */
struct XmlNode
{
    QString name;

    /** Kept as a list, not a map: attribute order is preserved so a save
     *  produces a readable diff rather than a reshuffled file. */
    QVector<QPair<QString, QString>> attributes;

    /** Text directly inside this element. Empty for container elements. */
    QString text;

    QVector<XmlNode> children;

    bool hasAttribute(const QString &key) const;
    QString attribute(const QString &key, const QString &fallback = QString()) const;

    /** Set an attribute, keeping its position when it already exists and
     *  appending it otherwise. */
    void setAttribute(const QString &key, const QString &value);
    void removeAttribute(const QString &key);

    /** First child with this name, or nullptr. */
    XmlNode *child(const QString &name);
    const XmlNode *child(const QString &name) const;

    /** Child with this name, created at the end if missing. */
    XmlNode &childOrCreate(const QString &name);
};

namespace XmlTree
{
    /** Parse a standalone fragment. Returns false when it will not read. */
    bool parse(const QString &xml, XmlNode &root);

    /** Serialise back to a fragment, in the same shape the reader accepts. */
    QString toXml(const XmlNode &root);
}

#endif // XMLTREE_H
