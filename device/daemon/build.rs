use std::path::Path;

/// The wake word models ship inside the binary. A missing file still builds, with that engine off,
/// so a fresh checkout compiles before `alexsay wake train` or `just wake-train` has produced one.
fn main() {
    for name in ["alexsay.rpw", "alexsay.onnx"] {
        let model = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../models")
            .join(name);
        if !model.exists() {
            if let Some(dir) = model.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&model, b"");
            println!("cargo:warning=models/{name} is missing: the binary ships without it");
        }
        println!("cargo:rerun-if-changed={}", model.display());
    }
    println!("cargo:rerun-if-changed=build.rs");
}
