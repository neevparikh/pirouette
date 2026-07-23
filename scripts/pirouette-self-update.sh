#!/usr/bin/env bash
# Pirouette self-update worker.
#
# Reinstalls the pirouette npm package and restarts the systemd service.
# This is the step that MUST NOT die when the service restarts, so it is
# designed to run inside its OWN systemd transient unit (its own cgroup),
# detached from `pirouette.service`. `pru self-update` launches it via
# `sudo systemd-run` for exactly this reason:
#
#   - An agent runs `pru self-update` from its pi bash tool.
#   - That bash process is a child of pirouette.service's cgroup, so when
#     the service restarts it (and every other in-flight agent command)
#     gets killed. If the npm-install-and-restart logic ran *there*, the
#     restart would kill the very command doing the restart -- the exact
#     failure mode this whole feature exists to fix.
#   - Instead `pru self-update` only *launches* this script into a
#     separate transient unit and returns immediately. This script then
#     survives the restart because it lives outside pirouette's cgroup.
#
# Inputs (environment):
#   PIROUETTE_PACKAGE         npm spec to (re)install, e.g.
#                             "@neevparikh/pirouette@latest". Required.
#   PIROUETTE_DATA_DIR        where to append the self-update log
#                             (optional; falls back to $HOME/logs).
#   PIROUETTE_SERVICE_NAME    systemd unit to restart (default: pirouette).
#   PIROUETTE_UPDATE_SETTLE   seconds to wait before starting, so the
#                             launching agent command can return cleanly
#                             first (default: 2).
#
# It is intentionally dependency-free (pure bash + npm + systemctl) so it
# can run even if a previous install left the pirouette binary broken.

set -uo pipefail

SERVICE_NAME="${PIROUETTE_SERVICE_NAME:-pirouette}"
PACKAGE="${PIROUETTE_PACKAGE:-}"
SETTLE="${PIROUETTE_UPDATE_SETTLE:-2}"

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

fail() {
    log "ERROR: $*"
    exit 1
}

if [ -z "$PACKAGE" ]; then
    fail "PIROUETTE_PACKAGE not set; nothing to install"
fi

log "starting: package=$PACKAGE service=$SERVICE_NAME"

# Give the launching agent command a beat to return before we begin, so
# the transcript shows a clean hand-off ("update kicked off") rather than
# a command that appears to hang.
if [ "$SETTLE" -gt 0 ] 2>/dev/null; then
    sleep "$SETTLE"
fi

# 1. Install the new package into the user-local npm prefix. Retry once:
#    a transient registry hiccup shouldn't leave the box on the old
#    version with no retry.
install_pkg() {
    npm install -g "$PACKAGE" 2>&1 | tail -20
    return "${PIPESTATUS[0]}"
}

log "npm install -g $PACKAGE ..."
if ! install_pkg; then
    log "first npm install attempt failed; retrying in 5s"
    sleep 5
    if ! install_pkg; then
        fail "npm install failed twice; leaving service on the current version"
    fi
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

# 3. Best-effort health confirmation so the log tells the whole story.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log "service '$SERVICE_NAME' is active again (version $NEW_VERSION). done."
        exit 0
    fi
    sleep 1
done

log "WARN: service '$SERVICE_NAME' not active yet; check 'pru logs' / journalctl"
exit 0
