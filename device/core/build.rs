fn main() {
    // The target triple names the release asset this binary updates itself from
    let target = std::env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=ALEXSAY_TARGET={target}");
    println!("cargo:rerun-if-changed=build.rs");
}
