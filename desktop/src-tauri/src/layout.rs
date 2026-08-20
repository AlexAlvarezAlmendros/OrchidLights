//! Where the daemon and its data live, resolved once at startup.
//!
//! Two worlds:
//!
//!  - **Installed**: everything sits in the bundle's resource directory,
//!    mirroring the AppImage layout the project already ships (`bin/`,
//!    `lib/`, `qtplugins/`, `plugins/orchidlights/`, `share/orchidlights/`).
//!  - **Development**: nothing is installed, so nothing is guessed. The
//!    `ORCHID_SIDECAR` environment variable names the daemon binary and the
//!    data directories are derived from the repository around it, with
//!    `ORCHID_FIXTURE_DIR`/`ORCHID_PLUGIN_DIR`/`ORCHID_WEB_DIR` as overrides.
//!    A missing piece is a clear error now, not a daemon that starts and
//!    serves nothing.

use std::path::{Path, PathBuf};

use crate::sidecar::Layout;

pub fn resolve(resource_dir: Option<PathBuf>) -> Result<Layout, String> {
    if let Ok(daemon) = std::env::var("ORCHID_SIDECAR") {
        return development(Path::new(&daemon));
    }

    if let Some(resources) = resource_dir {
        let root = resources.join("sidecar");
        if root.join("bin/orchidlightsd").exists() {
            return Ok(Layout {
                daemon: root.join("bin/orchidlightsd"),
                fixtures: root.join("share/orchidlights/fixtures"),
                plugins: root.join("plugins/orchidlights"),
                web: root.join("share/orchidlights/web"),
                lib_dir: Some(root.join("lib")),
                qt_plugin_dir: Some(root.join("qtplugins")),
            });
        }
    }

    Err("no hay daemon: ni recursos empaquetados ni ORCHID_SIDECAR apuntando a un build".into())
}

/// The uninstalled world: daemon from the build tree, data from the repo.
fn development(daemon: &Path) -> Result<Layout, String> {
    if !daemon.exists() {
        return Err(format!(
            "ORCHID_SIDECAR apunta a {} y no existe",
            daemon.display()
        ));
    }

    // build/server/src/orchidlightsd -> the repository holds the build tree.
    // ancestors() yields the path itself first, so the repo is the FOURTH
    // ancestor -- nth(3) was the build directory, and the fixtures fallback
    // half-worked from there (CMake mirrors resources/ into the build tree),
    // which made the real mistake read as a missing web directory.
    let repo = daemon
        .ancestors()
        .nth(4)
        .ok_or("ORCHID_SIDECAR no parece estar dentro de un árbol de build")?;

    let fixtures = env_dir("ORCHID_FIXTURE_DIR", repo.join("resources/fixtures"))?;
    let web = env_dir("ORCHID_WEB_DIR", repo.join("web/dist"))?;

    /* Output plugins have no source-tree fallback in the daemon itself (the
    build scatters one directory per plugin), so development needs the flat
    directory the helper script builds -- same trick as the smoke tests. */
    let plugins =
        match std::env::var("ORCHID_PLUGIN_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => return Err(
                "falta ORCHID_PLUGIN_DIR: los plugins de salida necesitan un directorio plano; \
                 genera uno con desktop/scripts/dev-plugin-dir.sh"
                    .into(),
            ),
        };
    if !plugins.is_dir() {
        return Err(format!(
            "ORCHID_PLUGIN_DIR {} no es un directorio",
            plugins.display()
        ));
    }

    Ok(Layout {
        daemon: daemon.to_path_buf(),
        fixtures,
        plugins,
        web,
        lib_dir: None,
        qt_plugin_dir: None,
    })
}

fn env_dir(name: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    let dir = std::env::var(name).map(PathBuf::from).unwrap_or(fallback);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("{name}: {} no existe", dir.display()))
    }
}

/// Where the daemon keeps per-user state; the shell reads the token there and
/// writes the daemon's log next to it. One directory for both programs, so
/// "where do I look" has one answer.
pub fn user_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "sin HOME")?;
    let dir = PathBuf::from(home).join(".orchidlights");
    std::fs::create_dir_all(&dir).map_err(|e| format!("no puedo crear {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn read_token(user_dir: &Path) -> Option<String> {
    std::fs::read_to_string(user_dir.join("api-token"))
        .ok()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}
