#!/bin/bash
# Pirouette container entrypoint.
#
# Replaces the upstream image's entrypoint. Runs as the image's non-root
# user. Ideally that user is uid 1000 so it matches the host's `ubuntu` user
# and bind-mounted files have consistent ownership.
#
# Every step is idempotent — it's safe to `docker restart pirouette` at any
# time. First boot does the slow work (yadm clone, `npm install -g`); later
# boots are instant.
#
# Environment (set by `docker run -e …`):
#   PIROUETTE_DATA_DIR             — bind-mount target for the EBS data volume (default /data)
#   PIROUETTE_PACKAGE              — npm package spec for the server (required)
#   PIROUETTE_DOTFILES_URL         — public HTTPS clone URL for yadm dotfiles (optional; empty skips)
#   PIROUETTE_AUTHORIZED_KEYS_URL  — URL serving an authorized_keys body (optional; empty skips)
#
# Expected bind mounts:
#   /data                    — persistent EBS volume; pirouette's sessions/state live here
#   $HOME                    — persistent container home; yadm dotfiles persist across restarts
#   /agent-sock              — directory the host drops a forwarded SSH agent socket into
#                              (empty when nobody is SSH'd into the host with agent forwarding)
set -euo pipefail

log() { echo "[pirouette-entrypoint] $*"; }

export PIROUETTE_DATA_DIR="${PIROUETTE_DATA_DIR:-/data}"
export PIROUETTE_PACKAGE="${PIROUETTE_PACKAGE:-}"
export PIROUETTE_DOTFILES_URL="${PIROUETTE_DOTFILES_URL:-}"
export PIROUETTE_AUTHORIZED_KEYS_URL="${PIROUETTE_AUTHORIZED_KEYS_URL:-}"

if [ -z "$PIROUETTE_PACKAGE" ]; then
    echo "[pirouette-entrypoint] ERROR: PIROUETTE_PACKAGE env var is required (e.g. @your-scope/pirouette@latest)" >&2
    exit 1
fi

# The server picks up this env var and points SSH-based commands at the host
# agent socket that sshd forwards into /agent-sock/ssh.sock when the user SSHes
# in with ForwardAgent + RemoteForward. If the user isn't connected, the path
# simply doesn't exist — background git operations fail, interactive ones work.
export SSH_AUTH_SOCK="/agent-sock/ssh.sock"

mkdir -p "$HOME/logs"
LOG="$HOME/logs/entrypoint.log"
exec > >(tee -a "$LOG") 2>&1

log "starting up  PWD=$PWD  USER=$(id -un)  HOME=$HOME"

# ---- 0. First-boot $HOME seed -------------------------------------------
# We bind-mount the host's per-user state dir over /home/<user>, which
# masks anything the image baked into $HOME (oh-my-zsh, paru config,
# language toolchains' default layouts, etc.). If the image left a
# snapshot at /opt/home-skel, copy it into the bind-mount on first boot.
# Done before yadm clone so dotfiles win on top.
SEED_SRC="/opt/home-skel"
SEED_SENTINEL="$HOME/.pirouette-home-seeded"
if [ -d "$SEED_SRC" ] && [ ! -f "$SEED_SENTINEL" ]; then
    log "first boot: seeding \$HOME from $SEED_SRC"
    # -a preserves perms/ownership; -n won't overwrite anything yadm or
    # the user has already put in place. Errors on stale dangling symlinks
    # are non-fatal.
    cp -an "$SEED_SRC"/. "$HOME"/ 2>/dev/null || true
    touch "$SEED_SENTINEL"
    log "seed complete"
elif [ ! -d "$SEED_SRC" ]; then
    log "no /opt/home-skel in image; skipping \$HOME seed (image-installed home files may be hidden by the bind-mount)"
fi

# ---- 1. Dotfiles over HTTPS (public repo; no SSH agent required) --------
if [ -z "$PIROUETTE_DOTFILES_URL" ]; then
    log "no PIROUETTE_DOTFILES_URL set; skipping yadm clone"
elif [ -d "$HOME/.local/share/yadm/repo.git" ]; then
    log "dotfiles already present; skipping yadm clone"
else
    log "cloning dotfiles from $PIROUETTE_DOTFILES_URL"
    if yadm clone --depth 1 "$PIROUETTE_DOTFILES_URL"; then
        yadm alt || true
        yadm checkout -f -- "$HOME" || true
        log "dotfiles in place"
    else
        log "WARN: yadm clone failed; continuing without dotfiles"
    fi
fi

# ---- 2. SSH host keys + authorized_keys (for `pru ssh` into container) --
# The image already runs sshd as its normal entrypoint; we start it ourselves.
sudo ssh-keygen -A 2>/dev/null || true
if [ -z "$PIROUETTE_AUTHORIZED_KEYS_URL" ]; then
    log "no PIROUETTE_AUTHORIZED_KEYS_URL set; container sshd will reject logins (docker exec still works)"
elif [ ! -s "$HOME/.ssh/authorized_keys" ]; then
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    log "fetching authorized_keys from $PIROUETTE_AUTHORIZED_KEYS_URL"
    curl -fsSL "$PIROUETTE_AUTHORIZED_KEYS_URL" -o "$HOME/.ssh/authorized_keys" || true
    chmod 600 "$HOME/.ssh/authorized_keys"
fi

log "starting sshd"
# Pre-create the log file so sshd (running as root via sudo) opens an
# already-existing user-owned file and just appends to it. Without this,
# sshd creates the file as root and we end up with a root-owned file in
# $HOME -- which the user can't manage.
touch "$HOME/logs/sshd.log"
sudo /usr/sbin/sshd -E "$HOME/logs/sshd.log" &

# ---- 3. Install pirouette if missing (idempotent) ------------------------
# `npm install -g` writes to the node prefix (usually /usr/lib/node_modules
# or similar), which requires root. The image's user has passwordless sudo,
# so we shell out with sudo for the install only.
if ! command -v pirouette > /dev/null; then
    log "installing $PIROUETTE_PACKAGE"
    sudo npm install -g "$PIROUETTE_PACKAGE" 2>&1 | tail -5
else
    log "pirouette already installed ($(pirouette --version 2>/dev/null || echo unknown))"
fi

# ---- 4. Start the pirouette server in a long-lived tmux session ---------
# `pru sync` (dev-mode) and any operator who SSHes in can attach with
# `tmux attach -t pirouette` to see live server output.
mkdir -p "$PIROUETTE_DATA_DIR/logs"
SESSION_NAME="pirouette"
if tmux has-session -t "$SESSION_NAME" 2> /dev/null; then
    log "tmux session '$SESSION_NAME' already running; not restarting"
else
    log "starting tmux session '$SESSION_NAME'"
    tmux new-session -d -s "$SESSION_NAME" \
        "pirouette server 2>&1 | tee -a $PIROUETTE_DATA_DIR/logs/pirouette.log"
fi

log "entrypoint complete; pinning container alive"
exec sleep infinity
