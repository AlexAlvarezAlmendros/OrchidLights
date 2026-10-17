//! The kiosk window's own key: an operator's, not the master.
//!
//! The kiosk's cage used to be kept by the interface and the PIN alone: the
//! window carried the master key, and the master key walks through the access
//! mask. With a paired operate key the daemon keeps the cage too -- a kiosk
//! that reaches the API by any road still cannot build anything.
//!
//! The key is kept in `~/.orchidlights/kiosk-key` (owner only) and reused
//! across launches, so the device list holds ONE kiosk, not one per boot. A
//! key the daemon no longer takes -- revoked from the remote screen, or the
//! device file deleted -- is replaced, and the stale device row with it.
//!
//! Everything here is best effort: without a key the kiosk falls back to the
//! master and says so, because a desk that refuses to open its console over a
//! pairing problem is worse than a cage kept by the interface.

use std::io::Write;
use std::path::Path;

/// How the kiosk shows up in the device list, on the remote screen.
const KIOSK_NAME: &str = "Kiosko de este equipo";

/// An operate key for the kiosk window, or None when none could be had.
pub fn operator_key(base: &str, master: &str, user_dir: &Path) -> Option<String> {
    let path = user_dir.join("kiosk-key");

    if let Some(kept) = std::fs::read_to_string(&path)
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
    {
        if role_of(base, &kept).as_deref() == Some("operate") {
            return Some(kept);
        }
    }

    // A stale row would sit on the remote screen as a device nobody holds.
    forget_old_kiosks(base, master);

    let paired: serde_json::Value = ureq::post(&format!("{base}/api/v1/devices"))
        .set("Authorization", &format!("Bearer {master}"))
        .send_json(serde_json::json!({ "name": KIOSK_NAME, "role": "operate" }))
        .ok()?
        .into_json()
        .ok()?;
    let key = paired.get("key")?.as_str()?.to_string();

    if let Err(error) = keep(&path, &key) {
        // Usable for this run; the next one pairs again and cleans up.
        eprintln!("orchidlights-desktop: no pude guardar la llave del kiosko: {error}");
    }
    Some(key)
}

/// The role the daemon reads for a key: "operate", "design", "master", or
/// None when the key opens nothing.
fn role_of(base: &str, key: &str) -> Option<String> {
    let body: serde_json::Value = ureq::get(&format!("{base}/api/v1/access"))
        .set("Authorization", &format!("Bearer {key}"))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    body.get("role")?.as_str().map(str::to_string)
}

fn forget_old_kiosks(base: &str, master: &str) {
    let Some(list) = ureq::get(&format!("{base}/api/v1/devices"))
        .set("Authorization", &format!("Bearer {master}"))
        .call()
        .ok()
        .and_then(|response| response.into_json::<serde_json::Value>().ok())
    else {
        return;
    };

    let devices = list
        .get("devices")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    for device in devices {
        if device.get("name").and_then(|n| n.as_str()) != Some(KIOSK_NAME) {
            continue;
        }
        if let Some(id) = device.get("id").and_then(|i| i.as_u64()) {
            let _ = ureq::delete(&format!("{base}/api/v1/devices/{id}"))
                .set("Authorization", &format!("Bearer {master}"))
                .call();
        }
    }
}

fn keep(path: &Path, key: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(key.as_bytes())?;
    file.write_all(b"\n")
}
