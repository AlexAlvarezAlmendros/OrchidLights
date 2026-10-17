project(api-contract)

# El daemon sirve el contrato en GET /api/v1/openapi.json, así que un cliente
# lo lee de la mesa que tiene delante y no de un repositorio que puede ir por
# otra versión. Sin esta regla, un daemon instalado contesta 404 mientras que
# uno del árbol de fuentes funciona -- que es exactamente la trampa que ya
# pillaron los meshes y las gelatinas.
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/openapi.json
    DESTINATION ${INSTALLROOT}/${DATADIR}/api
)
