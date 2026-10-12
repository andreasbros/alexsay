#!/usr/bin/env bash
# Cut a release: bump the SemVer version, regenerate CHANGELOG.md (git-cliff), commit, tag, push,
# and create the GitHub release with its notes and the Speaker and Server download tables. Every binary
# is built, run on its own architecture and attached by the tag-triggered workflow (.github/workflows/release.yml):
# artifacts always come from clean CI builds, never from a developer machine.
#
#   scripts/release-tag.sh patch|minor|major|X.Y.Z [--dry-run]     (just release patch)
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:?usage: release-tag.sh patch|minor|major|X.Y.Z [--dry-run]}"
DRY=0
[ "${2:-}" = "--dry-run" ] && DRY=1

CURRENT="$(sed -n 's/^version = "\(.*\)"/\1/p' device/Cargo.toml | head -1)"
IFS=. read -r MAJ MIN PAT <<< "$CURRENT"
case "$LEVEL" in
  major) NEXT="$((MAJ + 1)).0.0" ;;
  minor) NEXT="$MAJ.$((MIN + 1)).0" ;;
  patch) NEXT="$MAJ.$MIN.$((PAT + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) NEXT="$LEVEL" ;;
  *) echo "unknown level: $LEVEL" >&2; exit 1 ;;
esac
TAG="v$NEXT"
echo "release: $CURRENT -> $NEXT ($TAG)"
git rev-parse "$TAG" >/dev/null 2>&1 && { echo "tag $TAG already exists" >&2; exit 1; }

if [ "$DRY" = 1 ]; then
  echo "-- dry run: release notes preview --"
  git-cliff --unreleased --tag "$TAG" --strip all
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "releases are cut from main (on $BRANCH)" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "working tree not clean; commit or stash first" >&2; exit 1; }
git fetch origin main --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not in sync with origin/main" >&2; exit 1; }
gh auth status >/dev/null

if [ "$NEXT" != "$CURRENT" ]; then
  sed -i -e "0,/^version = \"$CURRENT\"/s//version = \"$NEXT\"/" device/Cargo.toml
  (cd device && cargo update --workspace --quiet)
  sed -i -e "0,/^version = \"$CURRENT\"/s//version = \"$NEXT\"/" server/Cargo.toml
  (cd server && cargo update --workspace --quiet)
fi
git-cliff --tag "$TAG" -o CHANGELOG.md
git add device/Cargo.toml device/Cargo.lock server/Cargo.toml server/Cargo.lock CHANGELOG.md
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "alexsay $TAG"
git push origin main "$TAG"

NOTES="$(mktemp)"
git-cliff --latest --strip all > "$NOTES"
DL="https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/releases/download/$TAG"
cat >> "$NOTES" <<NOTES_EOF

## Install

\`\`\`sh
curl -fsSL https://alexsay.com/install.sh | sh     # Linux, Raspberry Pi, macOS
irm https://alexsay.com/install.ps1 | iex          # Windows
\`\`\`

## Downloads

### Speaker

| Platform | File |
|---|---|
| Linux, x86_64 (static, any distro) | [alexsay-x86_64-linux-musl]($DL/alexsay-x86_64-linux-musl) |
| Linux, aarch64 (static, any distro; Raspberry Pi 5 with the ReSpeaker Flex) | [alexsay-aarch64-linux-musl]($DL/alexsay-aarch64-linux-musl) |
| macOS, Apple Silicon | [alexsay-aarch64-macos]($DL/alexsay-aarch64-macos) |
| macOS, Intel | [alexsay-x86_64-macos]($DL/alexsay-x86_64-macos) |
| Windows, x86_64 | [alexsay-x86_64-windows.zip]($DL/alexsay-x86_64-windows.zip) |
| Windows, arm64 | [alexsay-aarch64-windows.zip]($DL/alexsay-aarch64-windows.zip) |

### Server

Your own alexsay server in one binary: the API, the app, an HTTP server and an embedded SQLite database. Meant for your own machine or home network; exposing it to the internet is at your own risk. It never updates itself: download a new release to upgrade.

| Platform | File |
|---|---|
| Linux, x86_64 (static, any distro) | [alexsay-server-x86_64-linux-musl]($DL/alexsay-server-x86_64-linux-musl) |
| Linux, aarch64 (static, any distro; Raspberry Pi 5) | [alexsay-server-aarch64-linux-musl]($DL/alexsay-server-aarch64-linux-musl) |
| macOS, Apple Silicon | [alexsay-server-aarch64-macos]($DL/alexsay-server-aarch64-macos) |
| macOS, Intel | [alexsay-server-x86_64-macos]($DL/alexsay-server-x86_64-macos) |
| Windows, x86_64 (also runs on Windows on Arm through emulation) | [alexsay-server-x86_64-windows.zip]($DL/alexsay-server-x86_64-windows.zip) |

### Checksums

[SHA256SUMS]($DL/SHA256SUMS) and [SHA256SUMS.sig]($DL/SHA256SUMS.sig), signed with the release key.

Linux and macOS: \`chmod +x\` and run. Windows: unzip and run the .exe.
NOTES_EOF
gh release create "$TAG" --title "alexsay $NEXT" --notes-file "$NOTES"
echo "released $TAG; CI is building and attaching the binaries (gh run watch)"
