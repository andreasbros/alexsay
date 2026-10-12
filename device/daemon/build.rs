use std::path::Path;

/// The wake word model ships inside the binary. A missing file still builds, with the wake word off,
/// so a fresh checkout compiles before `alexsay wake train` has produced one.
fn main() {
    let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/alexsay.rpw");
    if !model.exists() {
        if let Some(dir) = model.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&model, b"");
        println!(
            "cargo:warning=models/alexsay.rpw is missing: the binary ships without a wake word model"
        );
    }
    println!("cargo:rerun-if-changed={}", model.display());
    println!("cargo:rerun-if-changed=build.rs");
}
