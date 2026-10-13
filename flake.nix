{
  description = "alexsay: Raspberry Pi speaker daemon, Cloudflare API, web app and website";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    crane.url = "github:ipetkov/crane";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay, crane }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./device/rust-toolchain.toml;
        # e2e/package.json must pin @playwright/test to this driver's version
        playwrightBrowsers = pkgs.playwright-driver.browsers;

        # The speaker binary, fully static (musl, ALSA compiled in) for the Linux targets.
        # crossPkgs supplies the musl C toolchain and a static alsa-lib for that architecture.
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        speakerSrc = pkgs.lib.cleanSourceWith {
          src = craneLib.path ./device;
          # The wake word models ship inside the binary, so they ride along with the Cargo sources
          filter = path: type: (craneLib.filterCargoSources path type) || (pkgs.lib.hasSuffix ".rpw" path) || (pkgs.lib.hasSuffix ".onnx" path);
        };
        speakerFor = { crossPkgs, target, features ? [ ] }:
          let
            cc = crossPkgs.stdenv.cc;
            alsa = pkgs.lib.getDev crossPkgs.pkgsStatic.alsa-lib;
            upper = builtins.replaceStrings [ "-" ] [ "_" ] (pkgs.lib.toUpper target);
            envTarget = builtins.replaceStrings [ "-" ] [ "_" ] target;
            args = {
              src = speakerSrc;
              strictDeps = true;
              pname = "alexsay";
              cargoExtraArgs = "-p alexsay-daemon" + pkgs.lib.optionalString (features != [ ]) " --features ${builtins.concatStringsSep "," features}";
              doCheck = false;
              nativeBuildInputs = [ pkgs.pkg-config pkgs.file ];
              CARGO_BUILD_TARGET = target;
              "CARGO_TARGET_${upper}_LINKER" = "${cc}/bin/${cc.targetPrefix}cc";
              "CC_${envTarget}" = "${cc}/bin/${cc.targetPrefix}cc";
              "AR_${envTarget}" = "${cc}/bin/${cc.targetPrefix}ar";
              HOST_CC = "${pkgs.stdenv.cc.nativePrefix}cc";
              CARGO_BUILD_RUSTFLAGS = "-C target-feature=+crt-static";
              PKG_CONFIG_ALL_STATIC = "1";
              PKG_CONFIG_PATH = "${alsa}/lib/pkgconfig";
              "PKG_CONFIG_PATH_${envTarget}" = "${alsa}/lib/pkgconfig";
            };
            # The dependency build stubs out local crates; the vendored candle-core is a real dependency
            cargoArtifacts = craneLib.buildDepsOnly (args // {
              dummySrc = craneLib.mkDummySrc {
                src = speakerSrc;
                extraDummyScript = ''
                  rm -rf $out/vendor
                  cp -r ${speakerSrc}/vendor $out/vendor
                '';
              };
            });
          in
          craneLib.buildPackage (args // {
            inherit cargoArtifacts;
            postInstall = ''
              file $out/bin/alexsay
              file $out/bin/alexsay | grep -Eq "statically linked|static-pie linked" || (echo "alexsay is not static"; exit 1)
            '';
          });
        muslX86 = pkgs.pkgsCross.musl64;
        muslArm = pkgs.pkgsCross.aarch64-multiplatform-musl;
      in
      {
        packages = {
          # Linux x86_64, any distribution: USB microphone and speaker through ALSA
          alexsay-x86_64-linux = speakerFor { crossPkgs = muslX86; target = "x86_64-unknown-linux-musl"; };
          # Raspberry Pi 5 with the ReSpeaker Flex (its ASR beam channel is the default input)
          alexsay-aarch64-linux = speakerFor { crossPkgs = muslArm; target = "aarch64-unknown-linux-musl"; features = [ "flex" ]; };
          # Raspberry Pi or any aarch64 Linux with a plain USB microphone
          alexsay-aarch64-linux-generic = speakerFor { crossPkgs = muslArm; target = "aarch64-unknown-linux-musl"; };
        };

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
            pkg-config
            alsa-lib
            file
            gh
            git-cliff
          ];

          CARGO_TARGET_DIR = "target/nix";
          PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsers;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";

          shellHook = ''
            export WRANGLER_SEND_METRICS=false
            export LD_LIBRARY_PATH="${pkgs.alsa-lib}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            echo "alexsay shell: just --list"
          '';
        };
      });
}
