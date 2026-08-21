//! The daemon as a child process: started, watched, and stopped on purpose.
//!
//! The shell owns exactly one `orchidlightsd` and its whole lifecycle. Three
//! facts about the daemon shape everything here:
//!
//!  - `InstallPaths` resolves its data relative to the *binary*, with no
//!    source-tree fallback for output plugins. A daemon launched from a
//!    bundle's resource directory finds nothing on its own, so the shell
//!    always passes the three `ORCHID_*` directories explicitly.
//!  - It is a Qt program with no screen: `QT_QPA_PLATFORM=offscreen` or it
//!    dies on startup.
//!  - Left to die by signal it latches the last DMX frame on the rig, so the
//!    orderly exit (`POST /api/v1/shutdown`, then SIGTERM, then SIGKILL) is
//!    not politeness -- it is what `--zero-on-exit` hangs off.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where the daemon's stdout/stderr goes, size-capped.
///
/// The engine is talkative -- an evening of use once produced a 31 MB log --
/// so the capture rotates: at 5 MB the file moves to `daemon.log.1` (replacing
/// any previous one) and a fresh file starts. Two files, ten megabytes, and an
/// evening's tail is always there for a crash report.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    /// Set while the shell itself is taking the daemon down, so the watcher
    /// thread can tell "we asked for this" from "it died on us".
    stopping: AtomicBool,
    base: String,
}

/// Everything the daemon needs to run outside an installation.
pub struct Layout {
    pub daemon: PathBuf,
    pub fixtures: PathBuf,
    pub plugins: PathBuf,
    pub web: PathBuf,
    /// Extra library paths for a bundled Qt (empty in dev, where the system
    /// Qt the daemon was built against is already visible).
    pub lib_dir: Option<PathBuf>,
    pub qt_plugin_dir: Option<PathBuf>,
}

impl Sidecar {
    /// Pick a free loopback port by binding to :0 and letting it go.
    ///
    /// There is a sliver of a race between the drop and the daemon's own
    /// bind; `spawn` retries with a fresh port if the daemon loses it.
    pub fn free_port() -> std::io::Result<u16> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        Ok(listener.local_addr()?.port())
    }

    pub fn spawn(
        layout: &Layout,
        port: u16,
        project: Option<&Path>,
        log_path: &Path,
    ) -> std::io::Result<Self> {
        let mut command = Command::new(&layout.daemon);
        command
            .arg("--port")
            .arg(port.to_string())
            // The shell dies with the rig dark: it exists to be quit on
            // purpose, unlike a headless daemon someone walks away from.
            .arg("--zero-on-exit")
            .env("QT_QPA_PLATFORM", "offscreen")
            .env("ORCHID_FIXTURE_DIR", &layout.fixtures)
            .env("ORCHID_PLUGIN_DIR", &layout.plugins)
            .env("ORCHID_WEB_DIR", &layout.web)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(dir) = &layout.lib_dir {
            command.env("LD_LIBRARY_PATH", dir);
        }
        if let Some(dir) = &layout.qt_plugin_dir {
            command.env("QT_PLUGIN_PATH", dir);
        }
        if let Some(path) = project {
            command.arg(path);
        }

        let mut child = command.spawn()?;

        // Both streams into one capped log, off-thread so a chatty engine
        // never backs up into a blocked pipe (a full pipe stalls the writer).
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        for stream in [stdout.map(boxed_reader), stderr.map(boxed_err_reader)]
            .into_iter()
            .flatten()
        {
            let log = log_path.to_path_buf();
            std::thread::spawn(move || capture(stream, &log));
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            stopping: AtomicBool::new(false),
            base: format!("http://127.0.0.1:{port}"),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Wait until the API answers. 200 and 401 both mean "alive" -- a guarded
    /// daemon refuses precisely because it is up.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let url = format!("{}/api/v1/status", self.base);

        while Instant::now() < deadline {
            if let Some(status) = probe(&url) {
                if status == 200 || status == 401 {
                    return Ok(());
                }
            }

            // A child that already exited will never answer; say so now
            // rather than at the deadline.
            if let Some(code) = self.exit_code() {
                return Err(format!("el daemon terminó al arrancar (código {code})"));
            }

            std::thread::sleep(Duration::from_millis(150));
        }

        Err("el daemon no respondió a tiempo".into())
    }

    /// The exit code if the child has finished, without blocking.
    pub fn exit_code(&self) -> Option<i32> {
        let mut guard = self.child.lock().expect("sidecar lock");
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }

    /// Block until the child exits. Used by the watcher thread.
    pub fn wait(&self) -> Option<i32> {
        // Taking the child out of the mutex so the shutdown path can still
        // signal it by PID would race; instead wait polls, holding the lock
        // only momentarily.
        loop {
            {
                let mut guard = self.child.lock().expect("sidecar lock");
                let child = guard.as_mut()?;
                if let Ok(Some(status)) = child.try_wait() {
                    return Some(status.code().unwrap_or(-1));
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// The orderly exit: ask over HTTP with the token, give it five seconds,
    /// then SIGTERM, two more, then SIGKILL. One path, so "did it stop the
    /// functions first" never depends on which way the app closed.
    pub fn shut_down(&self, token: Option<&str>) {
        self.stopping.store(true, Ordering::SeqCst);

        if let Some(token) = token {
            let asked = ureq::post(&format!("{}/api/v1/shutdown", self.base))
                .set("Authorization", &format!("Bearer {token}"))
                .timeout(Duration::from_secs(2))
                .call();
            if asked.is_ok() && self.wait_exit(Duration::from_secs(5)) {
                return;
            }
        }

        #[cfg(unix)]
        {
            if let Some(pid) = self.pid() {
                // SAFETY: plain kill(2) on a PID we own.
                unsafe { libc_kill(pid as i32, 15) };
                if self.wait_exit(Duration::from_secs(2)) {
                    return;
                }
            }
        }

        let mut guard = self.child.lock().expect("sidecar lock");
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }

    fn pid(&self) -> Option<u32> {
        let guard = self.child.lock().expect("sidecar lock");
        guard.as_ref().map(|c| c.id())
    }

    fn wait_exit(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            {
                let mut guard = self.child.lock().expect("sidecar lock");
                if let Some(child) = guard.as_mut() {
                    if let Ok(Some(_)) = child.try_wait() {
                        *guard = None;
                        return true;
                    }
                } else {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }
}

/// GET a URL and report only the status code; None while nothing listens.
fn probe(url: &str) -> Option<u16> {
    match ureq::get(url).timeout(Duration::from_millis(900)).call() {
        Ok(response) => Some(response.status()),
        Err(ureq::Error::Status(code, _)) => Some(code),
        Err(_) => None,
    }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, signal: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, signal)
}

type Reader = Box<dyn BufRead + Send>;

fn boxed_reader(stream: std::process::ChildStdout) -> Reader {
    Box::new(BufReader::new(stream))
}

fn boxed_err_reader(stream: std::process::ChildStderr) -> Reader {
    Box::new(BufReader::new(stream))
}

/// Copy a child stream into the capped log file.
fn capture(mut stream: Reader, log_path: &Path) {
    let mut line = String::new();
    loop {
        line.clear();
        match stream.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }

        rotate_if_needed(log_path);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

fn rotate_if_needed(log_path: &Path) {
    let Ok(meta) = std::fs::metadata(log_path) else {
        return;
    };
    if meta.len() < LOG_LIMIT {
        return;
    }
    let rotated = log_path.with_extension("log.1");
    let _ = std::fs::rename(log_path, rotated);
}

/// Shared handle the window and the watcher both hold.
pub type Shared = Arc<Sidecar>;
