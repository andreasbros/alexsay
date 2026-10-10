{
  description = "alexsay: Raspberry Pi speaker daemon, Cloudflare API, web app and website";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./device/rust-toolchain.toml;
        # The daemon runs on a Raspberry Pi 5 (aarch64); the cross gcc links the release build
        piCc = pkgs.pkgsCross.aarch64-multiplatform.stdenv.cc;
        # e2e/package.json must pin @playwright/test to this driver's version
        playwrightBrowsers = pkgs.playwright-driver.browsers;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustToolchain
            nodejs_24
            pnpm
            just
            jq
            resvg
            imagemagick
            openssl
          ];

          CARGO_TARGET_DIR = "target/nix";
          # Referenced by path rather than put on PATH, so host C builds keep the host gcc
          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER = "${piCc}/bin/${piCc.targetPrefix}cc";
          CC_aarch64_unknown_linux_gnu = "${piCc}/bin/${piCc.targetPrefix}cc";
          AR_aarch64_unknown_linux_gnu = "${piCc}/bin/${piCc.targetPrefix}ar";
          PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

          shellHook = ''
            export WRANGLER_SEND_METRICS=false
            echo "alexsay shell: just --list"
          '';
        };
      });
}
