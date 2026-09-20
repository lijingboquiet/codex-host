#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
usage: scripts/install-local.sh [--no-build]

Build and globally install the current macOS codexhost npm package, update an
existing /Applications/codexhost.app from that package, stop the running Codex
Desktop and its previous codexhost runtime, then start the updated installation.

options:
  --no-build  reuse the existing TypeScript, Renderer, and Rust release artifacts
  --help      show this help
EOF
}

SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)
      if [[ "$SKIP_BUILD" == true ]]; then
        echo "error: --no-build may only be provided once" >&2
        exit 2
      fi
      SKIP_BUILD=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: local install and Codex Desktop restart are currently supported only on macOS" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) TARGET="macos-arm64" ;;
  x86_64) TARGET="macos-x64" ;;
  *)
    echo "error: unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

command -v node >/dev/null 2>&1 || {
  echo "error: node is required" >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  echo "error: npm is required" >&2
  exit 1
}
if [[ "$SKIP_BUILD" == false ]]; then
  command -v cargo >/dev/null 2>&1 || {
    echo "error: cargo is required" >&2
    exit 1
  }
fi

cd "$REPOSITORY_ROOT"
VERSION="$(node -p 'require("./package.json").version')"
if [[ -z "${CODEXHOST_RELEASE_REPOSITORY:-}" ]]; then
  ORIGIN_URL="$(git config --get remote.origin.url || true)"
  CODEXHOST_RELEASE_REPOSITORY="$(
    node -e '
      const value = process.argv[1];
      const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(value);
      if (!match) process.exit(1);
      process.stdout.write(match[1].toLowerCase());
    ' "$ORIGIN_URL"
  )" || {
    echo "error: origin is not a GitHub repository; set CODEXHOST_RELEASE_REPOSITORY=owner/name" >&2
    exit 1
  }
fi
CODEXHOST_RELEASE_REPOSITORY="$(
  node -e '
    const value = process.argv[1];
    const pattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
    if (!pattern.test(value) || value.endsWith(".")) process.exit(1);
    process.stdout.write(value.toLowerCase());
  ' "$CODEXHOST_RELEASE_REPOSITORY"
)" || {
  echo "error: CODEXHOST_RELEASE_REPOSITORY must be a GitHub owner/name slug" >&2
  exit 1
}
export CODEXHOST_RELEASE_REPOSITORY

echo "codexhost local install: preparing $VERSION for $TARGET from $CODEXHOST_RELEASE_REPOSITORY"
PACKAGE_ARGUMENTS=(run release:npm -- --target "$TARGET" --version "$VERSION" --pack)
if [[ "$SKIP_BUILD" == true ]]; then
  PACKAGE_ARGUMENTS+=(--skip-build)
fi
npm "${PACKAGE_ARGUMENTS[@]}"
npm run release:npm:meta -- --version "$VERSION" --pack

PLATFORM_TARBALL="$REPOSITORY_ROOT/build/npm/$VERSION/$TARGET/codexhost-cli-$VERSION-$TARGET.tgz"
META_TARBALL="$REPOSITORY_ROOT/build/npm/$VERSION/meta/codexhost-cli-$VERSION.tgz"
for artifact in "$PLATFORM_TARBALL" "$META_TARBALL"; do
  if [[ ! -s "$artifact" ]]; then
    echo "error: expected npm package is missing or empty: $artifact" >&2
    exit 1
  fi
done

echo "codexhost local install: installing npm packages"
# Install both local tarballs together so the meta package resolves this platform
# offline. Remove and reinstall the platform package afterward because npm may
# otherwise retain cached contents for an already installed identical version.
npm install --global --offline --force "$PLATFORM_TARBALL" "$META_TARBALL"

NPM_PREFIX="$(npm prefix --global)"
CODEXHOST_BIN="$NPM_PREFIX/bin/codexhost"
case "$TARGET" in
  macos-arm64) PLATFORM_PACKAGE="@codexhost/cli-darwin-arm64" ;;
  macos-x64) PLATFORM_PACKAGE="@codexhost/cli-darwin-x64" ;;
esac
npm uninstall --global "$PLATFORM_PACKAGE"
npm install --global --offline "$PLATFORM_TARBALL"
PLATFORM_PACKAGE_ROOT="$NPM_PREFIX/lib/node_modules/$PLATFORM_PACKAGE"
if [[ ! -x "$CODEXHOST_BIN" ]]; then
  echo "error: installed codexhost command is unavailable: $CODEXHOST_BIN" >&2
  exit 1
fi
if [[ ! -d "$PLATFORM_PACKAGE_ROOT/app" ]]; then
  echo "error: installed codexhost platform package is unavailable: $PLATFORM_PACKAGE_ROOT" >&2
  exit 1
fi
INSTALLED_VERSION="$("$CODEXHOST_BIN" --version)"
if [[ "$INSTALLED_VERSION" != "$VERSION" ]]; then
  echo "error: installed codexhost version is $INSTALLED_VERSION; expected $VERSION" >&2
  exit 1
fi
INSTALLED_RELEASE_REPOSITORY="$(
  node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).releaseRepository ?? ""' \
    "$PLATFORM_PACKAGE_ROOT/app/codexhost-distribution.json"
)"
if [[ "$INSTALLED_RELEASE_REPOSITORY" != "$CODEXHOST_RELEASE_REPOSITORY" ]]; then
  echo "error: installed codexhost release repository is $INSTALLED_RELEASE_REPOSITORY; expected $CODEXHOST_RELEASE_REPOSITORY" >&2
  exit 1
fi

SYSTEM_DESKTOP_PATTERN='^/Applications/(ChatGPT|Codex)\.app/Contents/'
USER_DESKTOP_PATTERN="^$HOME/Applications/(ChatGPT|Codex)\.app/Contents/"
desktop_running() {
  /usr/bin/pgrep -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 ||
    /usr/bin/pgrep -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1
}

RUNTIME_DESCRIPTOR="$HOME/Library/Application Support/codexhost/desktop-runtime-v1.json"
descriptor_value() {
  if [[ ! -f "$RUNTIME_DESCRIPTOR" ]]; then
    return 0
  fi
  /usr/bin/sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" \
    "$RUNTIME_DESCRIPTOR" | /usr/bin/head -n 1
}

controller_pid() {
  local control_port candidate command_line
  control_port="$(descriptor_value control_port)"
  if [[ -z "$control_port" ]]; then
    return 0
  fi
  candidate="$(
    /usr/sbin/lsof -nP -t -iTCP:"$control_port" -sTCP:LISTEN 2>/dev/null |
      /usr/bin/head -n 1
  )"
  if [[ -z "$candidate" ]]; then
    return 0
  fi
  command_line="$(/bin/ps -p "$candidate" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"/app/desktop-controller.mjs"*|*"packages/desktop-control/dist/release-main.js"*)
      printf '%s\n' "$candidate"
      ;;
  esac
}

runtime_running() {
  /usr/bin/pgrep -x codexhost >/dev/null 2>&1 ||
    /usr/bin/pgrep -x codexhost-shim >/dev/null 2>&1 ||
    [[ -n "$(controller_pid)" ]]
}

echo "codexhost local install: stopping Codex Desktop"
if desktop_running; then
  /usr/bin/pkill -TERM -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 || true
  /usr/bin/pkill -TERM -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1 || true

  for _ in {1..100}; do
    desktop_running || break
    /bin/sleep 0.1
  done

  if desktop_running; then
    echo "codexhost local install: Codex Desktop did not exit gracefully; forcing it to stop"
    /usr/bin/pkill -KILL -f "$SYSTEM_DESKTOP_PATTERN" >/dev/null 2>&1 || true
    /usr/bin/pkill -KILL -f "$USER_DESKTOP_PATTERN" >/dev/null 2>&1 || true
  fi
fi

CONTROLLER_PID="$(controller_pid)"
if [[ -n "$CONTROLLER_PID" ]]; then
  /bin/kill -TERM "$CONTROLLER_PID" >/dev/null 2>&1 || true
fi

for _ in {1..50}; do
  runtime_running || break
  /bin/sleep 0.1
done

if runtime_running; then
  echo "codexhost local install: stopping the previous codexhost runtime"
  CONTROLLER_PID="$(controller_pid)"
  if [[ -n "$CONTROLLER_PID" ]]; then
    /bin/kill -KILL "$CONTROLLER_PID" >/dev/null 2>&1 || true
  fi
  /usr/bin/pkill -KILL -x codexhost >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -x codexhost-shim >/dev/null 2>&1 || true
fi

for _ in {1..100}; do
  runtime_running || break
  /bin/sleep 0.1
done
if runtime_running; then
  echo "error: the previous codexhost runtime did not exit before timeout" >&2
  exit 1
fi

LOCAL_APP_PATH="${CODEXHOST_LOCAL_APP_PATH:-/Applications/codexhost.app}"
APP_LAUNCHER="$CODEXHOST_BIN"
if [[ -d "$LOCAL_APP_PATH" ]]; then
  APP_CONTENTS="$LOCAL_APP_PATH/Contents"
  APP_RESOURCES="$APP_CONTENTS/Resources"
  for relative in \
    Contents/Info.plist \
    Contents/MacOS/codexhost \
    Contents/Resources/runtime/node; do
    if [[ ! -f "$LOCAL_APP_PATH/$relative" ]]; then
      echo "error: existing codexhost app is missing $relative: $LOCAL_APP_PATH" >&2
      exit 1
    fi
  done

  APP_PARENT="$(dirname "$LOCAL_APP_PATH")"
  STAGED_APP="$APP_PARENT/.codexhost-local-stage-$$.app"
  BACKUP_APP="$APP_PARENT/.codexhost-local-backup-$$.app"
  cleanup_local_app() {
    rm -rf "$STAGED_APP"
    if [[ -d "$BACKUP_APP" && ! -d "$LOCAL_APP_PATH" ]]; then
      mv "$BACKUP_APP" "$LOCAL_APP_PATH"
    fi
    rm -rf "$BACKUP_APP"
  }
  trap cleanup_local_app EXIT

  echo "codexhost local install: updating $LOCAL_APP_PATH"
  /usr/bin/ditto "$LOCAL_APP_PATH" "$STAGED_APP"
  STAGED_CONTENTS="$STAGED_APP/Contents"
  STAGED_RESOURCES="$STAGED_CONTENTS/Resources"
  rm -rf \
    "$STAGED_RESOURCES/app" \
    "$STAGED_RESOURCES/libexec" \
    "$STAGED_RESOURCES/licenses"
  cp "$PLATFORM_PACKAGE_ROOT/bin/codexhost" "$STAGED_CONTENTS/MacOS/codexhost"
  cp -R "$PLATFORM_PACKAGE_ROOT/app" "$STAGED_RESOURCES/app"
  cp -R "$PLATFORM_PACKAGE_ROOT/libexec" "$STAGED_RESOURCES/libexec"
  cp -R "$PLATFORM_PACKAGE_ROOT/licenses" "$STAGED_RESOURCES/licenses"
  cp "$PLATFORM_PACKAGE_ROOT/THIRD_PARTY_NOTICES.txt" \
    "$STAGED_RESOURCES/THIRD_PARTY_NOTICES.txt"
  node -e \
    'const fs = require("node:fs"); const [file, version, target, releaseRepository] = process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, version, distribution: "installer", target, releaseRepository }) + "\n");' \
    "$STAGED_RESOURCES/app/codexhost-distribution.json" \
    "$VERSION" \
    "$TARGET" \
    "$CODEXHOST_RELEASE_REPOSITORY"
  chmod 755 \
    "$STAGED_CONTENTS/MacOS/codexhost" \
    "$STAGED_RESOURCES/libexec/codexhost-shim" \
    "$STAGED_RESOURCES/libexec/codexhost-updater" \
    "$STAGED_RESOURCES/runtime/node"

  BUNDLE_VERSION="${VERSION%%-*}"
  BUNDLE_VERSION="${BUNDLE_VERSION%%+*}"
  /usr/bin/plutil -replace CFBundleShortVersionString -string "$BUNDLE_VERSION" \
    "$STAGED_CONTENTS/Info.plist"
  /usr/bin/plutil -replace CFBundleVersion -string "$BUNDLE_VERSION" \
    "$STAGED_CONTENTS/Info.plist"
  /usr/bin/codesign --force --sign - "$STAGED_RESOURCES/runtime/node"
  /usr/bin/codesign --force --sign - "$STAGED_RESOURCES/libexec/codexhost-shim"
  /usr/bin/codesign --force --sign - "$STAGED_RESOURCES/libexec/codexhost-updater"
  /usr/bin/codesign --force --sign - "$STAGED_CONTENTS/MacOS/codexhost"
  /usr/bin/codesign --force --sign - "$STAGED_APP"
  /usr/bin/codesign --verify --deep --strict "$STAGED_APP"
  STAGED_VERSION="$(
    node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
      "$STAGED_RESOURCES/app/codexhost-distribution.json"
  )"
  if [[ "$STAGED_VERSION" != "$VERSION" ]]; then
    echo "error: staged codexhost app version does not match $VERSION" >&2
    exit 1
  fi

  mv "$LOCAL_APP_PATH" "$BACKUP_APP"
  mv "$STAGED_APP" "$LOCAL_APP_PATH"
  rm -rf "$BACKUP_APP"
  trap - EXIT
  APP_LAUNCHER="$LOCAL_APP_PATH/Contents/MacOS/codexhost"
fi

echo "codexhost local install: starting $APP_LAUNCHER"
"$APP_LAUNCHER"
