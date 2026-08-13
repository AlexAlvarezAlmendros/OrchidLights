/*
  OrchidLights
  consolelayout.cpp

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
#include <QJsonArray>

#include "consolelayout.h"

bool ConsoleLayout::isLayoutSection(const QString &section)
{
    QXmlStreamReader reader(section);
    return reader.readNextStartElement() && reader.name() == KXMLOrchidLayout;
}

bool ConsoleLayout::parse(const QStringList &preservedSections, QVector<Page> &pages)
{
    for (const QString &section : preservedSections)
    {
        QXmlStreamReader reader(section);

        if (reader.readNextStartElement() == false)
            continue;
        if (reader.name() != KXMLOrchidLayout)
            continue;

        pages.clear();

        while (reader.readNextStartElement())
        {
            if (reader.name() != QStringLiteral("Page"))
            {
                reader.skipCurrentElement();
                continue;
            }

            Page page;
            page.id = reader.attributes().value(QStringLiteral("ID")).toUInt();

            while (reader.readNextStartElement())
            {
                if (reader.name() != QStringLiteral("Row"))
                {
                    reader.skipCurrentElement();
                    continue;
                }

                QVector<quint32> row;
                while (reader.readNextStartElement())
                {
                    if (reader.name() == QStringLiteral("Widget"))
                        row.append(reader.attributes().value(QStringLiteral("ID")).toUInt());
                    reader.skipCurrentElement();
                }

                if (row.isEmpty() == false)
                    page.rows.append(row);
            }

            pages.append(page);
        }

        return reader.hasError() == false;
    }

    return false;
}

QString ConsoleLayout::toXml(const QVector<Page> &pages)
{
    QString xml;
    QXmlStreamWriter writer(&xml);
    writer.setAutoFormatting(true);
    writer.setAutoFormattingIndent(1);

    writer.writeStartElement(KXMLOrchidLayout);
    writer.writeAttribute(QStringLiteral("Version"), QStringLiteral("1"));

    for (const Page &page : pages)
    {
        writer.writeStartElement(QStringLiteral("Page"));
        writer.writeAttribute(QStringLiteral("ID"), QString::number(page.id));

        for (const QVector<quint32> &row : page.rows)
        {
            writer.writeStartElement(QStringLiteral("Row"));
            for (quint32 id : row)
            {
                writer.writeStartElement(QStringLiteral("Widget"));
                writer.writeAttribute(QStringLiteral("ID"), QString::number(id));
                writer.writeEndElement();
            }
            writer.writeEndElement();
        }

        writer.writeEndElement();
    }

    writer.writeEndElement();

    return xml;
}

QJsonObject ConsoleLayout::toJson(const QVector<Page> &pages)
{
    QJsonArray pageArray;

    for (const Page &page : pages)
    {
        QJsonArray rowArray;
        for (const QVector<quint32> &row : page.rows)
        {
            QJsonArray widgets;
            for (quint32 id : row)
                widgets.append(qint64(id));
            rowArray.append(widgets);
        }

        QJsonObject json;
        json["id"] = qint64(page.id);
        json["rows"] = rowArray;
        pageArray.append(json);
    }

    QJsonObject json;
    json["pages"] = pageArray;
    return json;
}

bool ConsoleLayout::fromJson(const QJsonObject &json, QVector<Page> &pages, QString &errorMessage)
{
    if (json.value("pages").isArray() == false)
    {
        errorMessage = QStringLiteral("Expected a \"pages\" array");
        return false;
    }

    QVector<Page> parsed;

    for (const QJsonValue &pageValue : json.value("pages").toArray())
    {
        if (pageValue.isObject() == false)
        {
            errorMessage = QStringLiteral("Every page must be an object");
            return false;
        }

        const QJsonObject pageJson = pageValue.toObject();

        Page page;
        page.id = quint32(pageJson.value("id").toInt());

        for (const QJsonValue &rowValue : pageJson.value("rows").toArray())
        {
            QVector<quint32> row;
            for (const QJsonValue &widget : rowValue.toArray())
            {
                if (widget.isDouble() == false)
                {
                    errorMessage = QStringLiteral("Widget ids must be numbers");
                    return false;
                }
                row.append(quint32(widget.toInt()));
            }

            /* An empty row is what a drag that emptied one leaves behind. It
               carries no information, so it is dropped rather than persisted as
               a gap that reopens on every load. */
            if (row.isEmpty() == false)
                page.rows.append(row);
        }

        parsed.append(page);
    }

    pages = parsed;
    return true;
}
