//! `--mcp` and `--ctl`: the agent tools that travel inside the package.
//!
//! The .deb puts `orchidlights-mcp` and `orchidctl` on the PATH. An AppImage
//! cannot: it is one file somebody put somewhere, and nothing it carries
//! reaches the PATH. What it does have is a path of its own that stays put, so
//! it answers for both -- `OrchidLights.AppImage --mcp` is the MCP server and
//! `OrchidLights.AppImage --ctl status` is `orchidctl status` -- by handing the
//! process to the same launcher the .deb installs. One launcher, so Node is
//! found, and its absence explained, in exactly one place.
//!
//! This runs before Tauri and before single-instance: an agent starting its
//! MCP server must neither raise a second window nor be swallowed by the
//! desk that is already open.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Hands the process over when the first argument asks for an agent tool;
/// returns when it does not, so the desk starts as usual.
pub fn hand_over_if_asked() {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    let tool = match first.as_deref().and_then(OsStr::to_str) {
        Some("--mcp") => "orchidlights-mcp",
        Some("--ctl") => "orchidctl",
        _ => return,
    };

    let Some(launcher) = find(tool) else {
        eprintln!(
            "orchidlights: este paquete no lleva {tool}. Lo traen el .deb y el AppImage \
             de escritorio; desde el repositorio, node mcp/dist/{}.js",
            if tool == "orchidctl" { "cli" } else { "mcp" }
        );
        std::process::exit(1);
    };

    let mut command = Command::new(&launcher);
    command.args(args);
    clean_library_path(&mut command);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // exec only returns on failure.
        let error = command.exec();
        eprintln!(
            "orchidlights: no pude ceder a {}: {error}",
            launcher.display()
        );
        std::process::exit(1);
    }

    #[cfg(not(unix))]
    {
        let code = command.status().ok().and_then(|s| s.code()).unwrap_or(1);
        std::process::exit(code);
    }
}

/// The launcher sits in the sidecar, under Tauri's resource directory:
/// `<exe dir>/../lib/<product>/sidecar/bin`. That holds for /usr/bin in a .deb
/// and for usr/bin inside a mounted AppImage alike. The product directory's
/// name is the bundler's choice, so it is searched for, and the candidate is
/// confirmed by the file itself rather than by a directory that happens to
/// exist.
fn find(tool: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
    {
        roots.push(dir.join("../lib"));
    }
    if let Some(appdir) = std::env::var_os("APPDIR") {
        roots.push(PathBuf::from(appdir).join("usr/lib"));
    }

    roots.into_iter().find_map(|root| {
        std::fs::read_dir(root).ok()?.flatten().find_map(|entry| {
            let candidate = entry.path().join("sidecar/bin").join(tool);
            candidate.is_file().then_some(candidate)
        })
    })
}

/// The AppImage's AppRun points LD_LIBRARY_PATH into the bundle, for the
/// shell's own GTK. The launcher runs the SYSTEM's Node, and a system binary
/// loading the bundle's libraries fails in ways nobody can read. Only the
/// bundle's entries go; whatever the user had there before stays.
fn clean_library_path(command: &mut Command) {
    let (Some(appdir), Some(paths)) = (
        std::env::var_os("APPDIR"),
        std::env::var_os("LD_LIBRARY_PATH"),
    ) else {
        return;
    };

    let kept: Vec<PathBuf> = std::env::split_paths(&paths)
        .filter(|path| !path.as_os_str().is_empty() && !path.starts_with(&appdir))
        .collect();

    match std::env::join_paths(&kept) {
        Ok(joined) if !kept.is_empty() => {
            command.env("LD_LIBRARY_PATH", joined);
        }
        _ => {
            command.env_remove("LD_LIBRARY_PATH");
        }
    }
}
