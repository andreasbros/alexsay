use std::path::PathBuf;

/// The bundle (workerd, the Worker, the app) is made by `just server-bundle`. Without one the launcher
/// still builds, and says at run time that it carries nothing to serve.
fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let bundle = std::env::var("ALEXSAY_SERVER_BUNDLE")
        .map_or_else(|_| manifest.join("build/bundle.tar.zst"), PathBuf::from);
    let path = if bundle.exists() {
        bundle
    } else {
        println!(
            "cargo:warning=no server bundle at {}: run `just server-bundle`",
            bundle.display()
        );
        let empty =
            PathBuf::from(std::env::var("OUT_DIR").unwrap_or_default()).join("empty.tar.zst");
        let _ = std::fs::write(&empty, b"");
        empty
    };
    println!(
        "cargo:rustc-env=ALEXSAY_SERVER_BUNDLE_PATH={}",
        path.display()
    );
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-env-changed=ALEXSAY_SERVER_BUNDLE");
}
