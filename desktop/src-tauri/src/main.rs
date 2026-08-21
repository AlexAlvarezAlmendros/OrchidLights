//! OrchidLights desktop: the engine daemon in a native window.
//!
//! The shell is deliberately dumb. It starts `orchidlightsd` as a child,
//! points a webview at it, and takes it down cleanly when the window goes.
//! The window is one more client of the same origin the phones on the venue
//! network use -- nothing of the desk itself lives here.
//!
//! That principle decides who does what in the project cycle too. The shell
//! contributes exactly the pieces a browser cannot have -- native file
//! dialogs, files dropped from the file manager, a second launch carrying a
//! path -- and every one of them funnels into the SAME web code paths a
//! browser uses (`orchid-open-request` events, the daemon's token-gated
//! routes). The interface asks the questions; the shell moves the process.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod layout;
mod sidecar;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidecar::{Shared, Sidecar};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, FilePath};

struct ShellState {
    sidecar: Shared,
    token: Option<String>,
}

/// An open request waiting for the page to be ready to take it.
///
/// Pushing the path in with a one-shot eval loses it whenever the event fires
/// before the page has mounted its listeners -- a cold WebKit on a CI box
/// showed exactly that. So the shell PARKS the request and pings; the page
/// pulls it with `take_pending_open`, which consumes under the lock, making
/// double delivery (mount pull + ping pull) structurally impossible.
#[derive(Default)]
struct PendingOpen(std::sync::Mutex<Option<String>>);

/// Native "open a project" dialog. The webview holds no dialog permission of
/// its own: the page asks the shell, the shell asks the operator.
#[tauri::command]
async fn pick_open_file(app: tauri::AppHandle) -> Option<String> {
    let (send, receive) = std::sync::mpsc::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .add_filter("Proyectos QLC+ / OrchidLights", &["qxw"])
        .pick_file(move |picked| {
            let _ = send.send(picked);
        });
    receive.recv().ok().flatten().map(|path| path.to_string())
}

/// Native "save as" dialog, same contract.
#[tauri::command]
async fn pick_save_file(app: tauri::AppHandle) -> Option<String> {
    let (send, receive) = std::sync::mpsc::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .add_filter("Proyectos QLC+ / OrchidLights", &["qxw"])
        .set_file_name("proyecto.qxw")
        .save_file(move |picked| {
            let _ = send.send(picked);
        });
    receive.recv().ok().flatten().map(|path| path.to_string())
}

/// The page collects a parked open request. Consuming: whoever asks first
/// gets it, everyone after gets None.
#[tauri::command]
fn take_pending_open(pending: tauri::State<PendingOpen>) -> Option<String> {
    pending.0.lock().expect("pending lock").take()
}

/// The page answered the close question. `save` already happened (the page
/// saves through the daemon, where saving lives); all that is left here is
/// the process: take the daemon down tidy and end.
#[tauri::command]
fn resolve_close(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.sidecar.shut_down(state.token.as_deref());
    }
    app.exit(0);
}

fn main() {
    // A project given on the command line rides along to the daemon.
    let project: Option<PathBuf> = std::env::args()
        .skip(1)
        .find(|arg| arg.ends_with(".qxw"))
        .map(PathBuf::from);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // A second launch means "bring me the desk", not "give me two" --
            // and if it carried a project, the desk it brings is that one.
            // The path resolves against the SECOND process's directory, which
            // is what `orchidlights show.qxw` from some other terminal means.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let asked: Option<PathBuf> =
                args.iter()
                    .skip(1)
                    .find(|arg| arg.ends_with(".qxw"))
                    .map(|arg| {
                        let candidate = Path::new(arg);
                        if candidate.is_absolute() {
                            candidate.to_path_buf()
                        } else {
                            Path::new(&cwd).join(candidate)
                        }
                    });
            if let Some(path) = asked {
                forward_open_request(app, &path);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            pick_open_file,
            pick_save_file,
            take_pending_open,
            resolve_close
        ])
        .manage(PendingOpen::default())
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = window.app_handle();
                let Some(state) = app.try_state::<ShellState>() else {
                    return;
                };

                /* Unsaved edits make closing a question, and the page asks it
                -- in the desk's own design, with the three answers a
                two-button native dialog cannot offer. The page calls
                `resolve_close` when the answer is "go". Asking is only
                worth it when there is something to lose, so the daemon is
                consulted first; if it cannot answer, there is nothing left
                to protect and the close proceeds. */
                if is_dirty(&state) {
                    api.prevent_close();
                    if let Some(view) = app.get_webview_window("main") {
                        let _ = view
                            .eval("window.dispatchEvent(new CustomEvent('orchid-close-request'))");
                    }
                    return;
                }

                // Clean: the daemon dies with its window, and dies tidy --
                // the rig goes dark (--zero-on-exit), not latched on a look.
                state.sidecar.shut_down(state.token.as_deref());
            }
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                // A .qxw from the file manager. The page decides what opening
                // means (confirm over unsaved edits, then the daemon route).
                if let Some(path) = paths.iter().find(|p| {
                    p.extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("qxw"))
                }) {
                    forward_open_request(window.app_handle(), path);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("la carcasa no pudo arrancar");
}

/// Hand a project path to the page: park it, then ping.
///
/// The ping carries nothing; the page pulls the path with a command. A parked
/// request also survives the page not existing yet at all -- the app pulls on
/// mount -- and a newer request simply replaces an unclaimed older one, which
/// is what dropping two files in a row should mean.
fn forward_open_request(app: &tauri::AppHandle, path: &Path) {
    if let Some(pending) = app.try_state::<PendingOpen>() {
        *pending.0.lock().expect("pending lock") = Some(path.to_string_lossy().into_owned());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new CustomEvent('orchid-open-ping'))");
    }
}

/// Whether the daemon holds unsaved edits. `false` when it cannot say --
/// a daemon that is gone has nothing left to protect.
fn is_dirty(state: &ShellState) -> bool {
    let url = format!("{}/api/v1/project", state.sidecar.base_url());
    let mut request = ureq::get(&url).timeout(Duration::from_millis(900));
    if let Some(token) = &state.token {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let Ok(response) = request.call() else {
        return false;
    };
    let Ok(body) = response.into_json::<serde_json::Value>() else {
        return false;
    };
    body.get("modified").and_then(|m| m.as_bool()) == Some(true)
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
                arm_panic_shortcut(handle, sidecar.base_url().to_string(), token.clone());
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

/// Ctrl+Shift+Esc stops every running function, window focused or not.
///
/// QLC+'s own panic combination. Global because mid-show the operator may be
/// in a media player when everything needs to stop; the web page binds the
/// same keys for browsers, where "global" is not a thing a page can have.
fn arm_panic_shortcut(handle: &tauri::AppHandle, base: String, token: Option<String>) {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |_app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let mut request = ureq::post(&format!("{base}/api/v1/stop"))
                .timeout(std::time::Duration::from_secs(2));
            if let Some(token) = &token {
                request = request.set("Authorization", &format!("Bearer {token}"));
            }
            let _ = request.send_json(serde_json::json!({ "fadeMs": 0 }));
        })
        .build();

    if handle.plugin(plugin).is_err() {
        eprintln!("orchidlights-desktop: sin atajo global de pánico");
        return;
    }

    let combo = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Escape);
    if handle.global_shortcut().register(combo).is_err() {
        // Wayland without the portal, some sandboxes: the page's own binding
        // still works while the window is focused. Said, not hidden.
        eprintln!("orchidlights-desktop: el atajo global de pánico no se pudo registrar");
    }
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
