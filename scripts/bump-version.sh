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

# Every file that records the version: the only list, used to check, edit and stage.
npm_dirs=(app)
tauri_conf=app/src-tauri/tauri.conf.json
cargo_tomls=(app/src-tauri/Cargo.toml app/plugins/tauri-plugin-nowplaying/Cargo.toml)
cargo_locks=(app/src-tauri/Cargo.lock app/plugins/tauri-plugin-nowplaying/Cargo.lock)
files=("$tauri_conf" "${cargo_tomls[@]}" "${cargo_locks[@]}")
for dir in "${npm_dirs[@]}"; do files+=("$dir/package.json" "$dir/package-lock.json"); done

# Check everything before touching a file, so a refusal leaves the tree as it was.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "error: not inside a git work tree" >&2; exit 1; }
if ! git diff --cached --quiet; then
  echo "error: changes are already staged; commit or unstage them first so the version commit holds only the version" >&2
  exit 1
fi
if ! git diff --quiet -- "${files[@]}"; then
  echo "error: these files have uncommitted changes that would end up in the version commit:" >&2
  git diff --name-only -- "${files[@]}" >&2
  exit 1
fi

# package.json + package-lock.json (root entries only; no install, no git tag).
for dir in "${npm_dirs[@]}"; do
  (cd "$dir" && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
done

# Tauri config.
node -e '
  const fs = require("fs"), f = process.argv[1];
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.version = process.argv[2];
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$tauri_conf" "$version"

# Cargo manifests: the first `version =` line is the [package] version.
for toml in "${cargo_tomls[@]}"; do
  node -e '
    const fs = require("fs"), f = process.argv[1];
    const s = fs.readFileSync(f, "utf8").replace(/^version = ".*"(\r?)$/m, `version = "${process.argv[2]}"$1`);
    fs.writeFileSync(f, s);
  ' "$toml" "$version"
done

# Cargo lockfiles: our own two crates only (no network, no dependency updates).
for lock in "${cargo_locks[@]}"; do
  node -e '
    const fs = require("fs"), f = process.argv[1], v = process.argv[2];
    const s = fs.readFileSync(f, "utf8").replace(
      /(name = "(?:tabsync|tauri-plugin-nowplaying)"\r?\nversion = )".*"/g, `$1"${v}"`);
    fs.writeFileSync(f, s);
  ' "$lock" "$version"
done

# Fail loudly if any file doesn't record the new version (e.g. a pattern stopped matching).
node -e '
  const fs = require("fs");
  const [v, ...files] = process.argv.slice(1);
  const bad = [];
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    let ok;
    if (f.endsWith("package-lock.json")) { const j = JSON.parse(s); ok = j.version === v && j.packages?.[""]?.version === v; }
    else if (f.endsWith(".json")) ok = JSON.parse(s).version === v;
    else if (f.endsWith("Cargo.toml")) ok = /^version = "(.*)"\r?$/m.exec(s)?.[1] === v;
    else {
      const ours = [...s.matchAll(/name = "(?:tabsync|tauri-plugin-nowplaying)"\r?\nversion = "(.*)"/g)];
      ok = ours.length > 0 && ours.every((m) => m[1] === v);
    }
    if (!ok) bad.push(f);
  }
  if (bad.length) { console.error(`error: version ${v} not set in: ${bad.join(", ")}`); process.exit(1); }
' "$version" "${files[@]}"

git add -- "${files[@]}"
git --no-pager diff --cached --stat
echo "Version set to $version and staged. Commit with: git commit -m \"Version $version\""
