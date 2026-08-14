/*
  OrchidLights
  jsonview.h

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

#ifndef JSONVIEW_H
#define JSONVIEW_H

#include <QJsonObject>
#include <QJsonArray>

struct VcWidget;
class Fixture;
class Function;
class Universe;
class Doc;

/**
 * Turns engine objects into the JSON the API speaks.
 *
 * Kept apart from the routing so the shape of the wire format is readable in
 * one place, and so the same views can feed the WebSocket stream later.
 *
 * DMX addresses are 1-based here and universes are numbered from 1, matching
 * what is printed on the fixtures and what an operator types into a desk. The
 * engine counts both from 0 internally; the conversion happens here and only
 * here.
 */
namespace JsonView
{
    QJsonObject fixture(const Fixture *fixture);
    QJsonObject function(const Function *function);
    QJsonObject universe(const Universe *universe, int index);

    QJsonArray fixtures(const Doc *doc);
    QJsonArray functions(const Doc *doc);
    QJsonArray universes(const Doc *doc);

    /**
     * What a function is made of: a chaser's steps, a scene's values, a
     * collection's members.
     *
     * The write side of these already exists; without the read side a client
     * can change a body it cannot see, which is not editing, it is guessing.
     * Returns an empty object for the types not modelled here yet.
     */
    QJsonObject functionBody(const Doc *doc, const Function *function);

    /** The Virtual Console tree, geometry included: the interface needs the
        original coordinates to group widgets into rows and reflow them. */
    QJsonObject vcWidget(const VcWidget &widget);
}

#endif // JSONVIEW_H
