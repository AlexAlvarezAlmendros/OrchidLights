/*
  OrchidLights
  xmltree.cpp

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

#include <QXmlStreamWriter>
#include <QXmlStreamReader>

#include "xmltree.h"

bool XmlNode::hasAttribute(const QString &key) const
{
    for (const auto &attribute : attributes)
    {
        if (attribute.first == key)
            return true;
    }
    return false;
}

QString XmlNode::attribute(const QString &key, const QString &fallback) const
{
    for (const auto &attribute : attributes)
    {
        if (attribute.first == key)
            return attribute.second;
    }
    return fallback;
}

void XmlNode::setAttribute(const QString &key, const QString &value)
{
    for (auto &attribute : attributes)
    {
        if (attribute.first == key)
        {
            attribute.second = value;
            return;
        }
    }

    attributes.append(qMakePair(key, value));
}

void XmlNode::removeAttribute(const QString &key)
{
    for (int i = 0; i < attributes.count(); i++)
    {
        if (attributes.at(i).first == key)
        {
            attributes.remove(i);
            return;
        }
    }
}

XmlNode *XmlNode::child(const QString &childName)
{
    for (XmlNode &node : children)
    {
        if (node.name == childName)
            return &node;
    }
    return nullptr;
}

const XmlNode *XmlNode::child(const QString &childName) const
{
    for (const XmlNode &node : children)
    {
        if (node.name == childName)
            return &node;
    }
    return nullptr;
}

XmlNode &XmlNode::childOrCreate(const QString &childName)
{
    if (XmlNode *existing = child(childName))
        return *existing;

    XmlNode created;
    created.name = childName;
    children.append(created);
    return children.last();
}

XmlNode *XmlNode::findById(const QString &id)
{
    if (attribute(QStringLiteral("ID")) == id)
        return this;

    for (XmlNode &node : children)
    {
        if (XmlNode *found = node.findById(id))
            return found;
    }

    return nullptr;
}

bool XmlNode::removeById(const QString &id)
{
    for (int i = 0; i < children.count(); i++)
    {
        if (children.at(i).attribute(QStringLiteral("ID")) == id)
        {
            children.remove(i);
            return true;
        }
    }

    for (XmlNode &node : children)
    {
        if (node.removeById(id))
            return true;
    }

    return false;
}

namespace
{
    void readNode(QXmlStreamReader &reader, XmlNode &node)
    {
        node.name = reader.name().toString();

        for (const QXmlStreamAttribute &attribute : reader.attributes())
        {
            node.attributes.append(
                qMakePair(attribute.name().toString(), attribute.value().toString()));
        }

        while (reader.readNext() != QXmlStreamReader::Invalid)
        {
            if (reader.isEndElement())
                return;

            if (reader.isStartElement())
            {
                XmlNode child;
                readNode(reader, child);
                node.children.append(child);
            }
            else if (reader.isCharacters() && reader.isWhitespace() == false)
            {
                /* Appended rather than assigned: an element can carry text in
                   more than one run when it is interleaved with children, and
                   dropping the later runs would quietly change its value. */
                node.text += reader.text().toString();
            }

            if (reader.atEnd())
                return;
        }
    }

    void writeNode(QXmlStreamWriter &writer, const XmlNode &node)
    {
        writer.writeStartElement(node.name);

        for (const auto &attribute : node.attributes)
            writer.writeAttribute(attribute.first, attribute.second);

        if (node.text.isEmpty() == false)
            writer.writeCharacters(node.text);

        for (const XmlNode &child : node.children)
            writeNode(writer, child);

        writer.writeEndElement();
    }
}

bool XmlTree::parse(const QString &xml, XmlNode &root)
{
    QXmlStreamReader reader(xml);

    if (reader.readNextStartElement() == false)
        return false;

    root = XmlNode();
    readNode(reader, root);

    return reader.hasError() == false;
}

QString XmlTree::toXml(const XmlNode &root)
{
    QString xml;
    QXmlStreamWriter writer(&xml);
    writer.setAutoFormatting(true);
    writer.setAutoFormattingIndent(1);

    writeNode(writer, root);

    return xml;
}

QStringList XmlTree::collectIds(const XmlNode &root)
{
    QStringList ids;

    if (root.hasAttribute(QStringLiteral("ID")))
        ids << root.attribute(QStringLiteral("ID"));

    for (const XmlNode &child : root.children)
        ids << collectIds(child);

    return ids;
}
