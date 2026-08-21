//! OrchidLights desktop: the engine daemon in a native window.
//!
//! The shell is deliberately dumb. It starts `orchidlightsd` as a child,
//! points a webview at it, and takes it down cleanly when the window goes.
//! The window is one more client of the same origin the phones on the venue
//! network use -- nothing of the desk itself lives here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod layout;
mod sidecar;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sidecar::{Shared, Sidecar};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct ShellState {
    sidecar: Shared,
    token: Option<String>,
}

fn main() {
    // A project given on the command line rides along to the daemon.
    let project: Option<PathBuf> = std::env::args()
        .skip(1)
        .find(|arg| arg.ends_with(".qxw"))
        .map(PathBuf::from);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch means "bring me the desk", not "give me two".
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let handle = app.handle().clone();

            // The window first, on the splash, so launching feels immediate
            // even while the engine loads a big fixture library.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("OrchidLights")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(720.0, 480.0)
                    .build()?;

            let resources = app.path().resource_dir().ok();
            let project = project.clone();

            // Everything slow happens off the main thread; the splash owns
            // the screen meanwhile.
            std::thread::spawn(move || match boot(&handle, resources, project.as_deref()) {
                Ok(()) => {}
                Err(trouble) => {
                    // Stderr as well as the splash: a headless run (the smoke
                    // test, a CI box) has no window to read.
                    eprintln!("orchidlights-desktop: {trouble}");
                    let detail = trouble.replace('`', "'").replace('\\', "/");
                    let _ = window.eval(format!(
                        "document.body.dataset.state='error';\
                         document.getElementById('state').textContent='No se pudo arrancar';\
                         document.getElementById('trouble').textContent={detail:?};"
                    ));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // The daemon dies with its window, and dies tidy: the rig
                // goes dark (--zero-on-exit) instead of latching the look.
                if let Some(state) = window.app_handle().try_state::<ShellState>() {
                    state.sidecar.shut_down(state.token.as_deref());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("la carcasa no pudo arrancar");
}

/// Start the daemon, wait for it, hand the window over to it.
fn boot(
    handle: &tauri::AppHandle,
    resources: Option<PathBuf>,
    project: Option<&std::path::Path>,
) -> Result<(), String> {
    let layout = layout::resolve(resources)?;
    let user_dir = layout::user_dir()?;
    let log_path = user_dir.join("daemon.log");

    // A fresh port per run, retried a few times because between picking it
    // and the daemon binding it, something else could squat on it.
    let mut last_error = String::new();
    for _ in 0..3 {
        let port = Sidecar::free_port().map_err(|e| e.to_string())?;
        let sidecar =
            Arc::new(Sidecar::spawn(&layout, port, project, &log_path).map_err(|e| e.to_string())?);

        match sidecar.wait_ready(Duration::from_secs(15)) {
            Ok(()) => {
                // The token exists once the daemon is up -- it creates it on
                // every start. Read after readiness, never before.
                let token = layout::read_token(&user_dir);

                let url = match &token {
                    Some(token) => format!("{}/#token={token}", sidecar.base_url()),
                    None => sidecar.base_url().to_string(),
                };

                watch(handle.clone(), sidecar.clone());
                arm_signals(sidecar.clone(), token.clone());
                handle.manage(ShellState { sidecar, token });

                let window = handle
                    .get_webview_window("main")
                    .ok_or("la ventana principal desapareció")?;
                let parsed = url.parse().map_err(|e| format!("URL inválida: {e}"))?;
                window.navigate(parsed).map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(error) => {
                last_error = error;
                sidecar.shut_down(None);
            }
        }
    }

    Err(format!(
        "{last_error}. El registro está en {}",
        log_path.display()
    ))
}

/// SIGTERM and SIGINT run the same orderly shutdown as the close button.
///
/// Tauri's event loop never sees a signal: the process just dies, the
/// window-close path never runs, and the daemon is orphaned -- still driving
/// the rig with its window gone. The smoke test terminates the shell exactly
/// this way, on purpose, because a logout does too.
fn arm_signals(sidecar: Shared, token: Option<String>) {
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        use signal_hook::iterator::Signals;

        std::thread::spawn(move || {
            let Ok(mut signals) = Signals::new([SIGTERM, SIGINT]) else {
                return;
            };
            if signals.forever().next().is_some() {
                sidecar.shut_down(token.as_deref());
                std::process::exit(0);
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = (sidecar, token);
    }
}

/// Watch the child; if it dies without being asked, say so on the splash.
///
/// Restarting silently would be the other choice, and it is the wrong one for
/// a desk: the daemon dying mid-show means every fader position and every
/// running function is gone, and a shell that hides that behind an automatic
/// restart turns a catastrophe into a mystery. The operator gets the truth
/// and a working "reopen" (relaunch) instead.
fn watch(handle: tauri::AppHandle, sidecar: Shared) {
    std::thread::spawn(move || {
        let code = sidecar.wait();
        if sidecar.is_stopping() {
            return;
        }

        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        let detail = format!(
            "El motor terminó solo (código {}). Reabre la aplicación; el registro está en ~/.orchidlights/daemon.log",
            code.unwrap_or(-1)
        );
        // The webview is showing the dead daemon's page; bring back the
        // splash and its error line.
        let _ = window.eval(format!(
            "document.location.replace('tauri://localhost/index.html');\
             setTimeout(() => {{\
               document.body.dataset.state='error';\
               const state = document.getElementById('state');\
               if (state) state.textContent='El motor se ha caído';\
               const trouble = document.getElementById('trouble');\
               if (trouble) trouble.textContent={detail:?};\
             }}, 400);"
        ));
    });
}
