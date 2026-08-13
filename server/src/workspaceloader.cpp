/*
  OrchidLights
  workspaceloader.cpp

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
#include <QSaveFile>
#include <QFileInfo>

#include "workspaceloader.h"
#include "xmltree.h"
#include "qlcconfig.h"
#include "qlcfile.h"
#include "doc.h"

namespace
{
    /**
     * Copy the element the reader is sitting on, and everything inside it, into
     * the writer. The reader is left on the matching closing tag.
     *
     * Element names are copied as local names rather than through
     * writeCurrentToken(). A .qxw declares a default namespace on <Workspace>,
     * so writeCurrentToken() re-emits every child bound to it explicitly --
     * <ns0:VirtualConsole xmlns:ns0="http://www.qlcplus.org/Workspace"> instead
     * of <VirtualConsole>. The document still parses, but every preserved
     * section is rewritten and the file grows by a fifth, which is not what
     * "preserved" should mean when the user diffs their show file.
     */
    bool copyElement(QXmlStreamReader &reader, QXmlStreamWriter &writer)
    {
        int depth = 0;

        forever
        {
            switch (reader.tokenType())
            {
            case QXmlStreamReader::StartElement:
                depth++;
                writer.writeStartElement(reader.name().toString());
                for (const QXmlStreamAttribute &attribute : reader.attributes())
                    writer.writeAttribute(attribute.name().toString(), attribute.value().toString());
                break;

            case QXmlStreamReader::EndElement:
                depth--;
                writer.writeEndElement();
                break;

            case QXmlStreamReader::Characters:
                if (reader.isWhitespace() == false)
                    writer.writeCharacters(reader.text().toString());
                break;

            default:
                break;
            }

            if (depth == 0)
                return true;

            if (reader.atEnd() || reader.hasError())
                return false;

            reader.readNext();
        }
    }

    /** Capture an element as a standalone fragment. */
    QString captureElement(QXmlStreamReader &reader)
    {
        QString xml;
        QXmlStreamWriter writer(&xml);
        writer.setAutoFormatting(true);
        writer.setAutoFormattingIndent(1);

        copyElement(reader, writer);

        return xml;
    }

    /**
     * Re-emit a captured fragment, by way of the node tree.
     *
     * Going through XmlTree rather than straight from the string is what makes
     * the tree load-bearing: it is the same code path that widget editing will
     * use, so every save exercises it against every real project. If the tree
     * ever stops being faithful, a round trip stops being identical and the
     * test catches it -- rather than the first person to edit a widget.
     *
     * Parsed back before writing, so a fragment we somehow mangled fails here
     * instead of producing a project file that will not open.
     */
    bool writeFragment(QXmlStreamWriter &writer, const QString &xml)
    {
        XmlNode node;
        if (XmlTree::parse(xml, node) == false)
            return false;

        QXmlStreamReader reader(XmlTree::toXml(node));

        if (reader.readNextStartElement() == false)
            return false;

        return copyElement(reader, writer) && reader.hasError() == false;
    }
}

bool WorkspaceLoader::load(Doc *doc, const QString &fileName,
                           Preserved &preserved, QString &errorMessage)
{
    preserved = Preserved();

    if (fileName.isEmpty())
    {
        errorMessage = QStringLiteral("No project file given");
        return false;
    }

    QXmlStreamReader *reader = QLCFile::getXMLReader(fileName);
    if (reader == nullptr || reader->device() == nullptr || reader->hasError())
    {
        errorMessage = QStringLiteral("Unable to read from %1").arg(fileName);
        QLCFile::releaseXMLReader(reader);
        return false;
    }

    while (!reader->atEnd())
    {
        if (reader->readNext() == QXmlStreamReader::DTD)
            break;
    }

    if (reader->hasError())
    {
        errorMessage = QStringLiteral("%1 is malformed: %2").arg(fileName, reader->errorString());
        QLCFile::releaseXMLReader(reader);
        return false;
    }

    if (reader->dtdName() != KXMLQLCWorkspace)
    {
        errorMessage = QStringLiteral("%1 is not a workspace file").arg(fileName);
        QLCFile::releaseXMLReader(reader);
        return false;
    }

    /* Set the workspace path before loading, so that local files referenced by
       the project resolve even if the project has been moved. */
    doc->setWorkspacePath(QFileInfo(fileName).absolutePath());

    bool result = false;

    if (reader->readNextStartElement() && reader->name() == KXMLQLCWorkspace)
    {
        result = true;

        /* Namespace declarations first, and note they are NOT in attributes():
           with namespace processing on, Qt consumes xmlns="..." into
           namespaceDeclarations() instead. Reading only the attributes drops
           the declaration, every child silently leaves the default namespace,
           and the preserved sections come back subtly different from what went
           in -- while still parsing perfectly. */
        for (const QXmlStreamNamespaceDeclaration &ns : reader->namespaceDeclarations())
        {
            const QString name = ns.prefix().isEmpty()
                                     ? QStringLiteral("xmlns")
                                     : QStringLiteral("xmlns:") + ns.prefix().toString();

            preserved.workspaceAttributes.append(
                qMakePair(name, ns.namespaceUri().toString()));
        }

        for (const QXmlStreamAttribute &attribute : reader->attributes())
        {
            preserved.workspaceAttributes.append(
                qMakePair(attribute.name().toString(), attribute.value().toString()));
        }

        while (reader->readNextStartElement())
        {
            if (reader->name() == KXMLQLCEngine)
            {
                doc->loadXML(*reader);
            }
            else if (reader->name() == KXMLQLCCreator)
            {
                /* Rewritten on save with our own name and version. */
                reader->skipCurrentElement();
            }
            else
            {
                /* Virtual Console, Simple Desk, and anything a future QLC+ adds
                   that we have never heard of. Kept exactly as found. */
                preserved.sections.append(captureElement(*reader));
            }
        }
    }
    else
    {
        errorMessage = QStringLiteral("Workspace node not found in %1").arg(fileName);
    }

    /* A parse that stopped early still leaves whatever was read in Doc, and
       reporting success would let the next save write that truncated show back
       over the user's file. */
    if (result && reader->hasError())
    {
        errorMessage = QStringLiteral("%1 is truncated or malformed: %2")
                           .arg(fileName, reader->errorString());
        result = false;
    }

    QLCFile::releaseXMLReader(reader);

    if (result)
        doc->resetModified();

    return result;
}

bool WorkspaceLoader::save(const Doc *doc, const QString &fileName,
                           const Preserved &preserved, QString &errorMessage)
{
    /* QSaveFile: the original is only replaced once the new content is safely
       on disk. A half-written show file is worse than no save at all. */
    QSaveFile file(fileName);
    if (file.open(QIODevice::WriteOnly | QIODevice::Truncate) == false)
    {
        errorMessage = QStringLiteral("Cannot write to %1: %2").arg(fileName, file.errorString());
        return false;
    }

    QXmlStreamWriter writer(&file);
    writer.setAutoFormatting(true);
    writer.setAutoFormattingIndent(1);

    writer.writeStartDocument();
    writer.writeDTD(QStringLiteral("<!DOCTYPE %1>").arg(KXMLQLCWorkspace));

    writer.writeStartElement(KXMLQLCWorkspace);

    /* Exactly the attributes that were there, and nothing else.
     *
     * QLC+ writes xmlns on <Workspace>, but older files -- Sample.qxw among
     * them -- have none. Adding one puts every child into a default namespace
     * it was not in before, which changes what a preserved section means even
     * though the file still parses. Faithful beats tidy for a show file. */
    for (const auto &attribute : preserved.workspaceAttributes)
        writer.writeAttribute(attribute.first, attribute.second);

    writer.writeStartElement(KXMLQLCCreator);
    writer.writeTextElement(KXMLQLCCreatorName, QStringLiteral(APPNAME));
    writer.writeTextElement(KXMLQLCCreatorVersion, QStringLiteral(APPVERSION));
    writer.writeTextElement(KXMLQLCCreatorAuthor, QLCFile::currentUserName());
    writer.writeEndElement();

    doc->saveXML(&writer);

    for (const QString &section : preserved.sections)
    {
        if (writeFragment(writer, section) == false)
        {
            errorMessage = QStringLiteral("A preserved section of %1 could not be written back")
                               .arg(fileName);
            file.cancelWriting();
            return false;
        }
    }

    writer.writeEndElement(); // Workspace
    writer.writeEndDocument();

    if (writer.hasError())
    {
        errorMessage = QStringLiteral("Error writing XML to %1").arg(fileName);
        file.cancelWriting();
        return false;
    }

    if (file.commit() == false)
    {
        errorMessage = QStringLiteral("Cannot commit %1: %2").arg(fileName, file.errorString());
        return false;
    }

    return true;
}
