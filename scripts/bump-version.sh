#!/usr/bin/env bash
# Sets the Guitarfish version everywhere it is recorded, lockfiles included:
#   scripts/bump-version.sh 0.3.0
# The changed files are staged; commit them (nothing else), then tag the commit
# `v<version>` to release it (see README).
set -euo pipefail

version="${1:-}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch>" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

# package.json + package-lock.json (root entries only; no install, no git tag).
for dir in app server; do
  (cd "$dir" && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
done

# Tauri config.
node -e '
  const fs = require("fs"), f = process.argv[1];
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.version = process.argv[2];
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' app/src-tauri/tauri.conf.json "$version"

# Cargo manifests: the first `version =` line is the [package] version.
for toml in app/src-tauri/Cargo.toml app/plugins/tauri-plugin-nowplaying/Cargo.toml; do
  node -e '
    const fs = require("fs"), f = process.argv[1];
    const s = fs.readFileSync(f, "utf8").replace(/^version = ".*"$/m, `version = "${process.argv[2]}"`);
    fs.writeFileSync(f, s);
  ' "$toml" "$version"
done

# Cargo lockfiles: our own two crates only (no network, no dependency updates).
for lock in app/src-tauri/Cargo.lock app/plugins/tauri-plugin-nowplaying/Cargo.lock; do
  node -e '
    const fs = require("fs"), f = process.argv[1], v = process.argv[2];
    const s = fs.readFileSync(f, "utf8").replace(
      /(name = "(?:tabsync|tauri-plugin-nowplaying)"\nversion = )".*"/g, `$1"${v}"`);
    fs.writeFileSync(f, s);
  ' "$lock" "$version"
done

# Stage exactly the files above, so a version commit never picks up anything else.
files=(
  app/package.json app/package-lock.json server/package.json server/package-lock.json
  app/src-tauri/tauri.conf.json
  app/src-tauri/Cargo.toml app/plugins/tauri-plugin-nowplaying/Cargo.toml
  app/src-tauri/Cargo.lock app/plugins/tauri-plugin-nowplaying/Cargo.lock
)
git add -- "${files[@]}"
git --no-pager diff --cached --stat
echo "Version set to $version and staged. Commit with: git commit -m \"Version $version\""
