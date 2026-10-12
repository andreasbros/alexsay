#!/usr/bin/env bash
# Bumps device/Cargo.toml's workspace version, commits and tags vX.Y.Z. With --no-release it stops
# there (CI creates the release); otherwise it pushes and creates the GitHub release, which triggers
# the release workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
bump="${1:?patch | minor | major | X.Y.Z}"
no_release="${2:-}"
current=$(grep -m1 '^version = ' device/Cargo.toml | sed 's/version = "\(.*\)"/\1/')
IFS=. read -r major minor patch <<< "$current"
case "$bump" in
  patch) next="$major.$minor.$((patch + 1))" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  *) [[ "$bump" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version $bump"; exit 1; }; next="$bump" ;;
esac
[ -z "$(git status --porcelain)" ] || { echo "working tree is not clean"; exit 1; }
sed -i "0,/^version = \"$current\"/s//version = \"$next\"/" device/Cargo.toml
(cd device && cargo update --workspace --quiet)
git add device/Cargo.toml device/Cargo.lock
git commit -q -m "Release $next"
git tag -a "v$next" -m "alexsay v$next"
echo "v$next"
if [ "$no_release" != "--no-release" ]; then
  git push origin HEAD --follow-tags
  gh release create "v$next" --title "alexsay v$next" --generate-notes
fi
