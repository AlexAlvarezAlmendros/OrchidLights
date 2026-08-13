project(web)

# The web interface is built by pnpm, not by CMake. Wiring pnpm into the C++
# build would make every compile depend on a node_modules install, and a build
# that pulls from the network is a build that fails on the wrong night.
#
# The rule here only installs what is already in dist/, and says so clearly when
# it is not there rather than shipping a daemon that answers 404 at its own URL.
set(web_dist "${CMAKE_CURRENT_SOURCE_DIR}/dist")

if(EXISTS "${web_dist}/index.html")
    install(DIRECTORY "${web_dist}/"
            DESTINATION ${INSTALLROOT}/${DATADIR}/web)
    message("Web interface found, will be installed from ${web_dist}")
else()
    message(WARNING
        "The web interface has not been built, so it will not be installed. "
        "Run: cd web && pnpm install && pnpm build")
endif()
