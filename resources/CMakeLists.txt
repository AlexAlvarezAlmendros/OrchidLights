project(resources)

add_subdirectory(fixtures)
add_subdirectory(gobos)
add_subdirectory(inputprofiles)
add_subdirectory(miditemplates)
add_subdirectory(modifierstemplates)
add_subdirectory(rgbscripts)
add_subdirectory(samples)
if(qmlui)
    add_subdirectory(colorfilters)
    add_subdirectory(meshes)
elseif(server)
    # The daemon serves the gel books (GET /api/v1/colorfilters); without this
    # an installed daemon answers an empty list while a source-tree one works,
    # which is exactly how CI caught it.
    add_subdirectory(colorfilters)
    # And the 3D meshes (GET /api/v1/meshes/...): same trap, same lesson --
    # CI caught the missing meshes as a 404 in the browser console.
    add_subdirectory(meshes)
endif()
