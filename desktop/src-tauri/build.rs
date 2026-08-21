fn main() {
    // The app's own commands must be declared for the ACL to generate their
    // allow-* permissions -- without this, a REMOTE origin (our daemon page)
    // gets "not allowed. Plugin not found" on every invoke, silently in
    // production. The capability then grants them to the loopback origin.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_open_file",
            "pick_save_file",
            "take_pending_open",
            "resolve_close",
        ]),
    ))
    .expect("tauri-build");
}
