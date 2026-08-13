set(module_name "orchidlightsd")

add_executable(${module_name}
    main.cpp
    apiauth.cpp apiauth.h
    apiserver.cpp apiserver.h
    consolelayout.cpp consolelayout.h
    enginehost.cpp enginehost.h
    fixturelibrary.cpp fixturelibrary.h
    installpaths.cpp installpaths.h
    virtualconsole.cpp virtualconsole.h
    jsonview.cpp jsonview.h
    levelsource.cpp levelsource.h
    livefeed.cpp livefeed.h
    workspaceloader.cpp workspaceloader.h
)

target_include_directories(${module_name} PRIVATE
    ../../engine/src
)

target_link_libraries(${module_name} PRIVATE
    Qt${QT_MAJOR_VERSION}::Core
    Qt${QT_MAJOR_VERSION}::Gui
    Qt${QT_MAJOR_VERSION}::Qml
    Qt${QT_MAJOR_VERSION}::HttpServer
    Qt${QT_MAJOR_VERSION}::WebSockets
    qlcplusengine
)

install(TARGETS ${module_name}
    DESTINATION ${INSTALLROOT}/${BINDIR}
)
