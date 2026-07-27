#!/usr/bin/env bash
# Pirouette self-update worker.
#
# Reinstalls pirouette and restarts the systemd service. This is the step
# that MUST NOT die when the service restarts, so it is designed to run
# inside its OWN systemd transient unit (its own cgroup), detached from
# `pirouette.service`. `pru self-update` launches it via `sudo systemd-run`
# for exactly this reason:
#
#   - An agent runs `pru self-update` from its pi bash tool.
#   - That bash process is a child of pirouette.service's cgroup, so when
#     the service restarts it (and every other in-flight agent command)
#     gets killed. If the install-and-restart logic ran *there*, the
#     restart would kill the very command doing the restart -- the exact
#     failure mode this whole feature exists to fix.
#   - Instead `pru self-update` only *launches* this script into a
#     separate transient unit and returns immediately. This script then
#     survives the restart because it lives outside pirouette's cgroup.
#
# Two install sources (chosen by which env vars are set):
#
#   npm mode  (PIROUETTE_PACKAGE)          -> `npm install -g <spec>` from
#       the registry. The published tarball already contains a built
#       `dist/`, so nothing is compiled here.
#
#   git mode  (PIROUETTE_UPDATE_GIT_URL)   -> clone the repo, `npm ci`,
#       `npm run build`, `npm pack`, then `npm install -g <tarball>`. Used
#       to install an unreleased commit. We build in a fresh clone (rather
#       than letting `npm install -g <git-ref>` do it) because npm does
#       NOT install a package's devDependencies when running its `prepare`
#       script for a git dependency -- so the build tooling is missing and
#       the build fails. A fresh clone treated as the root project DOES
#       get devDependencies via `npm ci`, so building there works.
#
# Inputs (environment):
#   PIROUETTE_PACKAGE         npm spec for npm mode, e.g.
#                             "@neevparikh/pirouette@latest".
#   PIROUETTE_UPDATE_GIT_URL  git clone URL for git mode. Takes precedence
#                             over PIROUETTE_PACKAGE when set.
#   PIROUETTE_UPDATE_GIT_REF  branch/tag/sha to build (git mode; optional,
#                             defaults to the repo's default branch).
#   PIROUETTE_DATA_DIR        where to append the self-update log
#                             (optional; falls back to $HOME/logs).
#   PIROUETTE_SERVICE_NAME    systemd unit to restart (default: pirouette).
#   PIROUETTE_UPDATE_SETTLE   seconds to wait before starting, so the
#                             launching agent command can return cleanly
#                             first (default: 2).
#   PIROUETTE_PORT            port to health-check after the restart
#                             (default: 7777).
#   PIROUETTE_UPDATE_HEALTH_TIMEOUT
#                             seconds to wait for the new server to answer
#                             /api/health before rolling back (default: 90;
#                             0 disables the health check + rollback).
#
# Rollback: before installing, we `npm pack` the currently-installed global
# package into a tarball. If the new build never answers /api/health we
# reinstall that tarball and restart again. The whole point of the feature
# is that agents come back after an update; a broken build that leaves the
# service crash-looping is the worst possible outcome, so we undo it.

set -uo pipefail

SERVICE_NAME="${PIROUETTE_SERVICE_NAME:-pirouette}"
PACKAGE="${PIROUETTE_PACKAGE:-}"
GIT_URL="${PIROUETTE_UPDATE_GIT_URL:-}"
GIT_REF="${PIROUETTE_UPDATE_GIT_REF:-}"
SETTLE="${PIROUETTE_UPDATE_SETTLE:-2}"
HEALTH_PORT="${PIROUETTE_PORT:-7777}"
HEALTH_TIMEOUT="${PIROUETTE_UPDATE_HEALTH_TIMEOUT:-90}"
BACKUP_TARBALL=""

# Resolve a log destination that survives restarts and that `pru logs`
# can surface. Prefer the data dir; fall back to $HOME/logs.
if [ -n "${PIROUETTE_DATA_DIR:-}" ] && mkdir -p "$PIROUETTE_DATA_DIR/logs" 2>/dev/null; then
    LOG_FILE="$PIROUETTE_DATA_DIR/logs/self-update.log"
else
    mkdir -p "$HOME/logs" 2>/dev/null || true
    LOG_FILE="$HOME/logs/self-update.log"
fi

log() {
    local line
    line="[self-update $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
    # Journal (via stdout, when run as a systemd unit) + persistent file.
    printf '%s\n' "$line"
    printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
}

# Drop the rollback snapshot (a ~500KB tarball in TMPDIR). Called on every
# exit path so a run that never needs it doesn't litter /tmp.
cleanup_backup() {
    [ -n "$BACKUP_TARBALL" ] || return 0
    rm -rf "$(dirname "$BACKUP_TARBALL")" 2>/dev/null || true
    BACKUP_TARBALL=""
}

fail() {
    log "ERROR: $*"
    cleanup_backup
    exit 1
}

# --- rollback safety net ---------------------------------------------------

# Pack the *currently installed* global package so we can put it back if
# the new build doesn't come up. The installed tree already contains a
# prebuilt dist/, and package.json "files" lists everything we ship, so a
# plain `npm pack` of that directory round-trips fine (no build needed).
# Where is the package currently installed? Try, in order: the `pirouette`
# / `pru` bins on PATH (follow the symlink into
# <prefix>/lib/node_modules/<pkg>/dist/... and walk up to package.json),
# then the conventional global roots. PATH can be minimal inside a
# transient unit, hence the fallbacks.
installed_package_dir() {
    local bin dir candidate
    for bin in pirouette pru; do
        candidate="$(command -v "$bin" 2>/dev/null)" || continue
        [ -n "$candidate" ] || continue
        candidate="$(readlink -f "$candidate" 2>/dev/null || echo "$candidate")"
        dir="$(dirname "$candidate")"
        while [ "$dir" != "/" ] && [ ! -f "$dir/package.json" ]; do
            dir="$(dirname "$dir")"
        done
        if [ -f "$dir/package.json" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done
    for dir in "$(npm root -g 2>/dev/null)/@neevparikh/pirouette" \
               "$HOME/.npm-global/lib/node_modules/@neevparikh/pirouette" \
               "/usr/local/lib/node_modules/@neevparikh/pirouette"; do
        if [ -f "$dir/package.json" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done
    return 1
}

snapshot_current_install() {
    local dir
    dir="$(installed_package_dir)" || dir=""
    if [ -z "$dir" ]; then
        log "WARN: no existing global install found; rollback disabled"
        return 0
    fi
    local outdir tarball
    outdir="$(mktemp -d "${TMPDIR:-/tmp}/pirouette-rollback.XXXXXX")" || return 0
    # --ignore-scripts: we want a bit-for-bit snapshot of what is installed
    # (dist/ is already built there), not a rebuild -- the global install
    # has no devDependencies, so running `prepare` would fail.
    tarball="$( cd "$dir" && npm pack --silent --ignore-scripts --pack-destination "$outdir" 2>/dev/null | tail -1 )"
    if [ -n "$tarball" ] && [ -f "$outdir/$tarball" ]; then
        BACKUP_TARBALL="$outdir/$tarball"
        log "rollback snapshot: $BACKUP_TARBALL"
    else
        rm -rf "$outdir"
        log "WARN: could not snapshot the current install; rollback disabled"
    fi
}

# Poll the server's health endpoint. Returns 0 as soon as it answers.
wait_for_health() {
    local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -fsS --max-time 3 "http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

rollback() {
    [ -n "$BACKUP_TARBALL" ] || { log "ERROR: no rollback snapshot available; leaving the box on the new build"; return 1; }
    log "ROLLING BACK to the previous build ($BACKUP_TARBALL)"
    npm install -g "$BACKUP_TARBALL" 2>&1 | tail -20
    [ "${PIPESTATUS[0]}" -eq 0 ] || { log "ERROR: rollback install failed"; return 1; }
    sudo systemctl restart "$SERVICE_NAME" || { log "ERROR: rollback restart failed"; return 1; }
    if wait_for_health; then
        log "rollback complete; service healthy on the previous version ($(pirouette --version 2>/dev/null || echo unknown))"
    else
        log "ERROR: still unhealthy after rollback; check 'journalctl -u $SERVICE_NAME'"
        return 1
    fi
}

# --- install strategies ----------------------------------------------------

# npm mode: install a published spec. Retried once (transient registry
# hiccups shouldn't strand the box on the old version).
install_from_npm() {
    [ -n "$PACKAGE" ] || fail "PIROUETTE_PACKAGE not set; nothing to install"
    local attempt
    for attempt in 1 2; do
        log "npm install -g $PACKAGE (attempt $attempt) ..."
        if npm install -g "$PACKAGE" 2>&1 | tail -20; [ "${PIPESTATUS[0]}" -eq 0 ]; then
            return 0
        fi
        [ "$attempt" -eq 1 ] && { log "install failed; retrying in 5s"; sleep 5; }
    done
    fail "npm install failed twice; leaving service on the current version"
}

# git mode: clone, build in the clone (so devDependencies are present),
# pack, and install the resulting tarball. Never touches the live install
# until the final `npm install -g <tarball>`, so a build failure leaves the
# current version untouched.
install_from_git() {
    command -v git >/dev/null 2>&1 || fail "git not found; cannot build from source"
    local workdir
    workdir="$(mktemp -d "${TMPDIR:-/tmp}/pirouette-build.XXXXXX")" || fail "mktemp failed"
    # shellcheck disable=SC2064
    trap "rm -rf '$workdir'" EXIT
    local repo="$workdir/repo"

    log "cloning $GIT_URL${GIT_REF:+ (ref: $GIT_REF)} into $repo"
    if [ -n "$GIT_REF" ]; then
        # Try a shallow clone of the ref (works for branches + tags). Fall
        # back to a full clone + checkout for arbitrary commit SHAs.
        if ! git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" "$repo" 2>/dev/null; then
            log "shallow clone of ref failed (likely a SHA); full clone + checkout"
            git clone "$GIT_URL" "$repo" 2>&1 | tail -5 || fail "git clone failed"
            ( cd "$repo" && git checkout --quiet "$GIT_REF" ) || fail "git checkout $GIT_REF failed"
        fi
    else
        git clone --depth 1 "$GIT_URL" "$repo" 2>&1 | tail -5 || fail "git clone failed"
    fi

    local built_ref
    built_ref="$( cd "$repo" && git rev-parse --short HEAD 2>/dev/null || echo unknown )"
    log "building $built_ref (npm ci)"
    ( cd "$repo" && npm ci 2>&1 | tail -20; [ "${PIPESTATUS[0]}" -eq 0 ] ) || fail "npm ci failed"
    log "npm run build"
    ( cd "$repo" && npm run build 2>&1 | tail -20; [ "${PIPESTATUS[0]}" -eq 0 ] ) || fail "npm run build failed"

    log "npm pack"
    local tarball
    tarball="$( cd "$repo" && npm pack --silent 2>/dev/null | tail -1 )" || fail "npm pack failed"
    [ -n "$tarball" ] && [ -f "$repo/$tarball" ] || fail "npm pack produced no tarball"

    log "npm install -g $tarball"
    npm install -g "$repo/$tarball" 2>&1 | tail -20; [ "${PIPESTATUS[0]}" -eq 0 ] || fail "npm install of built tarball failed"

    rm -rf "$workdir"
    trap - EXIT
}

# --- main ------------------------------------------------------------------

if [ -n "$GIT_URL" ]; then
    log "starting: mode=git url=$GIT_URL ref=${GIT_REF:-default} service=$SERVICE_NAME"
elif [ -n "$PACKAGE" ]; then
    log "starting: mode=npm package=$PACKAGE service=$SERVICE_NAME"
else
    fail "neither PIROUETTE_UPDATE_GIT_URL nor PIROUETTE_PACKAGE set; nothing to do"
fi

# Give the launching agent command a beat to return before we begin, so
# the transcript shows a clean hand-off ("update kicked off") rather than
# a command that appears to hang.
if [ "$SETTLE" -gt 0 ] 2>/dev/null; then
    sleep "$SETTLE"
fi

# 1. Snapshot the current install so a bad build can be undone, then
#    install (source chosen above).
if [ "$HEALTH_TIMEOUT" -gt 0 ] 2>/dev/null; then
    snapshot_current_install
fi
if [ -n "$GIT_URL" ]; then
    install_from_git
else
    install_from_npm
fi

NEW_VERSION="$(pirouette --version 2>/dev/null || echo unknown)"
log "installed pirouette version: $NEW_VERSION"

# 2. Restart the service. This tears down the OLD server (which persists
#    every running agent as 'shutdown' state on graceful exit) and starts
#    the NEW one, whose resumeAll() brings those agents back.
log "restarting systemd service '$SERVICE_NAME'"
if sudo systemctl restart "$SERVICE_NAME"; then
    log "restart requested; new server will resume agents on boot"
else
    fail "systemctl restart $SERVICE_NAME failed"
fi

# 3. Health confirmation. Not cosmetic: if the new build can't serve
#    /api/health, no agent got resumed, so we put the old one back rather
#    than leaving every agent dead on a crash-looping service.
if [ "$HEALTH_TIMEOUT" -le 0 ] 2>/dev/null; then
    log "health check disabled (PIROUETTE_UPDATE_HEALTH_TIMEOUT=0); done."
    exit 0
fi

if wait_for_health; then
    log "service '$SERVICE_NAME' is healthy again (version $NEW_VERSION); agents resuming. done."
    cleanup_backup
    exit 0
fi

log "WARN: '$SERVICE_NAME' did not answer /api/health within ${HEALTH_TIMEOUT}s (version $NEW_VERSION)"
if systemctl is-active --quiet "$SERVICE_NAME" && ! command -v curl >/dev/null 2>&1; then
    # No curl on the box: we can't distinguish "slow" from "broken", and
    # the unit is at least running. Don't roll back on a missing tool.
    log "curl not available for health checks; unit is active, assuming OK"
    cleanup_backup
    exit 0
fi

rollback
status=$?
cleanup_backup
exit "$status"
