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

#include <QFileInfo>
#include <QXmlStreamReader>

#include "workspaceloader.h"
#include "qlcfile.h"
#include "doc.h"

bool WorkspaceLoader::load(Doc *doc, const QString &fileName, QString &errorMessage)
{
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

        while (reader->readNextStartElement())
        {
            if (reader->name() == KXMLQLCEngine)
            {
                doc->loadXML(*reader);
            }
            else
            {
                /* Virtual Console and Simple Desk live outside Doc in QLC+ and
                   are not engine state. They are read by their own controllers
                   in F2; skipping them here keeps the project file intact on
                   the way back out. */
                reader->skipCurrentElement();
            }
        }
    }
    else
    {
        errorMessage = QStringLiteral("Workspace node not found in %1").arg(fileName);
    }

    QLCFile::releaseXMLReader(reader);

    if (result)
        doc->resetModified();

    return result;
}
