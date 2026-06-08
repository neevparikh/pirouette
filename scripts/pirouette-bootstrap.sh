#!/bin/bash
# Pirouette host bootstrap.
#
# Runs over SSH from the laptop on every `pru setup` (and is uploaded again
# for `pru sync`). Idempotent end-to-end: the slow work (skel seed, yadm
# clone, npm install) happens once; later runs detect the previous state and
# short-circuit.
#
# Required env (set by src/cli/remote/host.ts buildBootstrapEnv() before
# invoking us over SSH):
#   PIROUETTE_PERSISTENT_ROOT   mount-point of the persistent volume
#                               (e.g. /data on a METR k8s devpod, /srv on
#                               a long-running VM you set up by hand).
#   PIROUETTE_HOME_DIR          target of the $HOME symlink. Defaults to
#                               ${PIROUETTE_PERSISTENT_ROOT}/home/$USER if
#                               unset.
#   PIROUETTE_DATA_DIR          where pirouette's server state lives.
#                               Defaults to ${PIROUETTE_PERSISTENT_ROOT}/
#                               pirouette/data if unset.
#   PIROUETTE_PACKAGE           npm package spec to install (e.g.
#                               @neevparikh/pirouette@latest).
#   PIROUETTE_PORT              port pirouette server binds. Default 7777.
#
# Optional env:
#   PIROUETTE_DOTFILES_URL          HTTPS clone URL for yadm dotfiles.
#                                   Empty -> skip clone.
#   PIROUETTE_AUTHORIZED_KEYS_URL   URL serving an authorized_keys body.
#                                   Re-fetched on every run for key
#                                   rotation. Empty -> fall back to
#                                   copying the image's pre-swap ~/.ssh/.
#   PIROUETTE_FORCE_REINSTALL=1     force `npm install -g` even if pirouette
#                                   appears to already be installed.
#   PIROUETTE_TS_ENABLED=1          enable tailscale-on-pod: install (if
#                                   missing), start tailscaled in userspace
#                                   mode, `tailscale up` interactively on
#                                   first run, `tailscale serve --https=443
#                                   -> http://localhost:$PIROUETTE_PORT`.
#                                   Subsequent runs are idempotent.
#   PIROUETTE_TS_HOSTNAME           short hostname for this node on the
#                                   tailnet (e.g. "pirouette-gpu-devpod").
#                                   The phone-reachable FQDN is
#                                   ${HOSTNAME}.<tailnet>.ts.net.
#   PIROUETTE_TS_STATE_PERSISTENT=1 symlink /var/lib/tailscale ->
#                                   ${PIROUETTE_PERSISTENT_ROOT}/tailscale-
#                                   state so the node key survives pod
#                                   recreate. Default on when TS_ENABLED.
#
# Output goes to $HOME/logs/bootstrap.log via `tee` after we set up $HOME.

set -euo pipefail

log() { echo "[pirouette-bootstrap] $*"; }

# ---- 0. Defaults + validation ---------------------------------------------
: "${PIROUETTE_PERSISTENT_ROOT:?PIROUETTE_PERSISTENT_ROOT not set}"
: "${PIROUETTE_PACKAGE:?PIROUETTE_PACKAGE not set}"
export PIROUETTE_PORT="${PIROUETTE_PORT:-7777}"
export PIROUETTE_HOME_DIR="${PIROUETTE_HOME_DIR:-$PIROUETTE_PERSISTENT_ROOT/home/$(id -un)}"
export PIROUETTE_DATA_DIR="${PIROUETTE_DATA_DIR:-$PIROUETTE_PERSISTENT_ROOT/pirouette/data}"
# Address the server binds. 127.0.0.1 (reach via SSH tunnel) by default;
# 0.0.0.0 when something in front of the loopback bind needs to reach it
# (a docker `-p` mapping, a host-level `tailscale serve`, ...).
export PIROUETTE_BIND_HOST="${PIROUETTE_BIND_HOST:-127.0.0.1}"
# Adopt mode: skip the whole-home migration (section 2). Set for hosts that
# are already laid out the way you want -- e.g. a docker container whose
# $HOME is a bind-mount, not a symlink we should move.
export PIROUETTE_ADOPT="${PIROUETTE_ADOPT:-0}"

# Sanity: persistent_root must look like a real mountpoint / writable dir.
# The first-mount case (PVC just attached, root-owned) is handled below
# via sudo chown; this catches genuinely bad config.
if [ ! -d "$PIROUETTE_PERSISTENT_ROOT" ]; then
    echo "[pirouette-bootstrap] ERROR: $PIROUETTE_PERSISTENT_ROOT is not a directory." >&2
    echo "  Check hosts.<name>.persistent_root in ~/.pirouette/config.toml." >&2
    exit 1
fi

log "starting on $(hostname) as $(id -un)"
log "  persistent_root = $PIROUETTE_PERSISTENT_ROOT"
log "  home_dir        = $PIROUETTE_HOME_DIR"
log "  data_dir        = $PIROUETTE_DATA_DIR"
log "  bind_host       = $PIROUETTE_BIND_HOST"
log "  adopt           = $PIROUETTE_ADOPT"
log "  package         = $PIROUETTE_PACKAGE"

# ---- 1. Take ownership of $PIROUETTE_PERSISTENT_ROOT ---------------------
# First-mount case: a freshly-attached PVC is root:root 0755 and our SSH
# user can't write to it. Use sudo (image contract: NOPASSWD sudo) once.
# Idempotent: skip the chown when we already own it.
if [ ! -w "$PIROUETTE_PERSISTENT_ROOT" ]; then
    log "claiming $PIROUETTE_PERSISTENT_ROOT (first-mount sudo chown)"
    sudo chown "$(id -u):$(id -g)" "$PIROUETTE_PERSISTENT_ROOT"
fi

# Make sure the dirs we're about to write to exist.
mkdir -p "$PIROUETTE_DATA_DIR" "$(dirname "$PIROUETTE_HOME_DIR")"

# ---- 2. Whole-home migration ---------------------------------------------
# $HOME -> $PIROUETTE_HOME_DIR via symlink, seeded once from /opt/home-skel.
# Image-baked $HOME state ends up in the persistent volume on first boot and
# survives pod/instance recreates. Skipped entirely in adopt mode (see above).
#
# Safety notes:
#   - We cd /tmp before mv'ing /home/<user> so we don't orphan our own CWD.
#   - The pre-swap $HOME gets stashed (not deleted) at $HOME.pre-pirouette-<ts>
#     so a botched run is recoverable. Cleanup is manual today.
#   - Refuses to clobber if /home/<user> is already a symlink to a DIFFERENT
#     target (someone else's setup). Surface the conflict; require manual fix.
ensure_persistent_home() {
    local user persistent_home current_home
    user="$(id -un)"
    persistent_home="$PIROUETTE_HOME_DIR"
    current_home="$HOME"

    # Adopt mode: the host is already laid out the way the user wants
    # (e.g. a container with a bind-mounted $HOME). Don't touch $HOME.
    if [ "${PIROUETTE_ADOPT:-0}" = "1" ]; then
        log "adopt mode: skipping home migration (using existing \$HOME=$current_home)"
        return 0
    fi

    # Already migrated to OUR target? Idempotent fast path.
    if [ -L "$current_home" ] \
       && [ "$(readlink "$current_home")" = "$persistent_home" ]; then
        log "$current_home already symlinked to $persistent_home; skipping migration"
        return 0
    fi

    # Symlink exists but points somewhere else. Refuse to clobber.
    if [ -L "$current_home" ]; then
        local existing
        existing="$(readlink "$current_home")"
        echo "[pirouette-bootstrap] ERROR: $current_home is a symlink to $existing," >&2
        echo "  but pirouette expects it to point to $persistent_home." >&2
        echo "  Either set hosts.<name>.home_dir = \"$existing\" in your config" >&2
        echo "  (or hosts.<name>.adopt = true to use \$HOME as-is), or fix and re-run." >&2
        exit 1
    fi

    sudo install -d -o "$user" -g "$user" "$(dirname "$persistent_home")"
    mkdir -p "$persistent_home"

    # First-boot seeding from /opt/home-skel. Sentinel prevents re-seed on
    # subsequent boots (image bumps don't re-seed,
    # which is the price of persistent home).
    local seed_src="/opt/home-skel"
    local seed_sentinel="$persistent_home/.pirouette-home-seeded"
    if [ -d "$seed_src" ] && [ ! -f "$seed_sentinel" ]; then
        log "first boot: seeding $persistent_home from $seed_src"
        cp -an "$seed_src/." "$persistent_home/" 2>/dev/null || true
        touch "$seed_sentinel"
    elif [ ! -d "$seed_src" ]; then
        log "no /opt/home-skel in image; persistent home will start empty"
    fi

    # Foot-gun (C) mitigation. If PIROUETTE_AUTHORIZED_KEYS_URL is unset
    # we'll have no way to populate $HOME/.ssh/authorized_keys after the
    # swap, and the next SSH connect fails. Copy the image's pre-swap
    # .ssh/ into the persistent target as a fallback. (If URL IS set,
    # the fetch step below idempotently overwrites this anyway.)
    if [ -z "${PIROUETTE_AUTHORIZED_KEYS_URL:-}" ] \
       && [ -d "$current_home/.ssh" ] \
       && [ ! -e "$persistent_home/.ssh/authorized_keys" ]; then
        log "no PIROUETTE_AUTHORIZED_KEYS_URL set; copying pre-swap ~/.ssh/ into persistent target"
        sudo install -d -o "$user" -g "$user" -m 700 "$persistent_home/.ssh"
        cp -an "$current_home/.ssh/." "$persistent_home/.ssh/" 2>/dev/null || true
    fi

    # cd out of $HOME so we don't orphan our own CWD (foot-gun B).
    cd /tmp

    local stash="${current_home}.pre-pirouette-$(date +%s)"
    log "swapping: mv $current_home -> $stash; ln -s $persistent_home -> $current_home"
    sudo mv "$current_home" "$stash" 2>/dev/null || true
    sudo ln -sfn "$persistent_home" "$current_home"
    sudo chown -h "$user:$user" "$current_home"
    log "migration complete (pre-pirouette stash at $stash; manual cleanup if you want)"
}
ensure_persistent_home

# Now that $HOME is the persistent target, start logging there too.
mkdir -p "$HOME/logs" "$PIROUETTE_DATA_DIR/logs"
exec > >(tee -a "$HOME/logs/bootstrap.log") 2>&1

# ---- 3. authorized_keys ---------------------------------------------------
# Idempotent overwrite on every run. Key rotation Just Works (rotate at the
# URL, re-run `pru setup`).
if [ -n "${PIROUETTE_AUTHORIZED_KEYS_URL:-}" ]; then
    log "fetching authorized_keys from $PIROUETTE_AUTHORIZED_KEYS_URL"
    mkdir -p "$HOME/.ssh"
    chmod 700 "$HOME/.ssh"
    curl -fsSL "$PIROUETTE_AUTHORIZED_KEYS_URL" -o "$HOME/.ssh/authorized_keys" || true
    chmod 600 "$HOME/.ssh/authorized_keys"
fi

# ---- 4. npm prefix --------------------------------------------------------
# user-local npm prefix so `npm install -g` doesn't need sudo. Idempotent.
NPM_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_PREFIX/bin" "$NPM_PREFIX/lib"
if [ "$(npm config get prefix 2>/dev/null)" != "$NPM_PREFIX" ]; then
    log "setting npm prefix to $NPM_PREFIX"
    npm config set prefix "$NPM_PREFIX"
fi
for rc in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.zshrc" \
          "$HOME/.zshenv" "$HOME/.profile"; do
    if [ -e "$rc" ] && ! grep -qF "/.npm-global/bin" "$rc"; then
        printf '\n# pirouette: user-local npm bin (added by pirouette-bootstrap.sh)\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$rc"
    fi
done
export PATH="$NPM_PREFIX/bin:$PATH"

# ---- 5. Dotfiles (yadm) ---------------------------------------------------
if [ -z "${PIROUETTE_DOTFILES_URL:-}" ]; then
    log "no PIROUETTE_DOTFILES_URL set; skipping yadm clone"
elif [ -d "$HOME/.local/share/yadm/repo.git" ]; then
    log "dotfiles already present; skipping yadm clone"
elif command -v yadm >/dev/null 2>&1; then
    # Pre-seed the git host's key into known_hosts when the URL is in
    # SSH form (git@HOST:owner/repo.git). Without this, the first ssh
    # to that host -- which yadm clone -> git clone -> ssh shells out
    # to -- hits a host-key prompt that the non-interactive bootstrap
    # can't answer, and the clone hangs or fails. ssh-keyscan +
    # appending to known_hosts is exactly what `accept-new` does at
    # connect time, just done eagerly. Idempotent: ssh-keygen -F bails
    # if the host's already trusted.
    if [[ "$PIROUETTE_DOTFILES_URL" =~ ^[^@]+@([^:]+): ]]; then
        git_host="${BASH_REMATCH[1]}"
        mkdir -p "$HOME/.ssh"
        chmod 700 "$HOME/.ssh"
        touch "$HOME/.ssh/known_hosts"
        chmod 600 "$HOME/.ssh/known_hosts"
        if ! ssh-keygen -F "$git_host" -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
            log "seeding known_hosts for $git_host"
            ssh-keyscan -H "$git_host" >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
        fi
    fi
    log "cloning dotfiles from $PIROUETTE_DOTFILES_URL"
    if yadm clone --depth 1 "$PIROUETTE_DOTFILES_URL"; then
        yadm alt || true
        yadm checkout -f -- "$HOME" || true
        log "dotfiles in place"
    else
        log "WARN: yadm clone failed; continuing without dotfiles"
        log "  (if URL is SSH-form, check that ForwardAgent yes is in"
        log "   your ~/.ssh/config for the host alias, and that the"
        log "   key your local ssh-agent has access to is also a deploy"
        log "   key / collaborator on the dotfiles repo.)"
    fi
else
    log "WARN: yadm not on PATH; skipping dotfiles clone"
fi

# ---- 6. Install pirouette --------------------------------------------------
HAVE="$(pirouette --version 2>/dev/null || true)"
if [ -z "$HAVE" ] || [ "${PIROUETTE_FORCE_REINSTALL:-0}" = "1" ]; then
    log "installing $PIROUETTE_PACKAGE into $NPM_PREFIX"
    npm install -g "$PIROUETTE_PACKAGE" 2>&1 | tail -5
else
    log "pirouette $HAVE already installed at $(command -v pirouette)"
fi

# ---- 7. Start the server in tmux ------------------------------------------
# Idempotent: only spawn if not already running. Bind $PIROUETTE_BIND_HOST
# (default 127.0.0.1 loopback -- access from laptop via SSH tunnel).
#
# The tmux command forwards a curated set of env vars that the laptop's
# host module plumbs through (default model / thinking level,
# config-level allowed_hosts). Empty / unset vars are omitted rather
# than passed as empty strings because the server falls back to
# config.toml / defaults via nullish-coalesce -- an explicit empty
# string would override the fallback to literal "".
#
# Kept as a function so the tailscale block (which restarts the session
# with an additional allowed-hosts entry for the tailnet FQDN) can
# reuse the exact same env-construction logic.
build_server_env() {
    local extra_allowed_hosts="${1:-}"
    local env_str=""
    [ -n "${PIROUETTE_DEFAULT_MODEL:-}" ] && \
        env_str="$env_str PIROUETTE_DEFAULT_MODEL='$PIROUETTE_DEFAULT_MODEL'"
    [ -n "${PIROUETTE_DEFAULT_THINKING_LEVEL:-}" ] && \
        env_str="$env_str PIROUETTE_DEFAULT_THINKING_LEVEL='$PIROUETTE_DEFAULT_THINKING_LEVEL'"
    # Merge config-level allowed_hosts with any extra entries the caller
    # supplies (e.g. the tailscale FQDN). Server parses this comma-separated.
    local hosts="${PIROUETTE_ALLOWED_HOSTS:-}"
    if [ -n "$extra_allowed_hosts" ]; then
        if [ -n "$hosts" ]; then
            hosts="$hosts,$extra_allowed_hosts"
        else
            hosts="$extra_allowed_hosts"
        fi
    fi
    [ -n "$hosts" ] && env_str="$env_str PIROUETTE_ALLOWED_HOSTS='$hosts'"
    echo "$env_str"
}

SESSION_NAME="pirouette"
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    log "tmux session '$SESSION_NAME' already running; not restarting"
else
    log "starting tmux session '$SESSION_NAME' (binding $PIROUETTE_BIND_HOST:$PIROUETTE_PORT)"
    server_env="$(build_server_env)"
    tmux new-session -d -s "$SESSION_NAME" \
        "PIROUETTE_DATA_DIR='$PIROUETTE_DATA_DIR' PIROUETTE_PORT='$PIROUETTE_PORT' PIROUETTE_HOST='$PIROUETTE_BIND_HOST' $server_env pirouette server 2>&1 | tee -a '$PIROUETTE_DATA_DIR/logs/pirouette.log'"
fi

# ---- 8. Tailscale (optional) ----------------------------------------------
# Bridges the loopback-bound pirouette server onto the tailnet so any
# device on the tailnet (phone, other laptop) can reach the dashboard
# without an SSH tunnel. Trust boundary stays the tailnet ACL --
# pirouette server is still bound 127.0.0.1; only tailscaled (same
# pod, same netns) reaches it.
#
# k8s pods typically lack CAP_NET_ADMIN, so we run tailscaled in
# userspace mode (no TUN device, virtual netstack inside tailscaled).
# `tailscale serve` works fine in userspace mode — listener is a
# socket inside tailscaled, externally identical to kernel-mode.
#
# First-boot is interactive: `tailscale up` (without --auth-key)
# prints a login URL and blocks until the user approves in a browser.
# `pru setup` streams that URL back to the laptop terminal. Subsequent
# boots reuse the cached node key from /var/lib/tailscale (symlinked
# to the persistent volume by default) and skip the auth step.
if [ "${PIROUETTE_TS_ENABLED:-0}" = "1" ]; then
    : "${PIROUETTE_TS_HOSTNAME:?PIROUETTE_TS_HOSTNAME not set; required when TS_ENABLED=1}"

    # State persistence: symlink /var/lib/tailscale -> persistent.
    # Idempotent: skip when already a symlink to the right target.
    if [ "${PIROUETTE_TS_STATE_PERSISTENT:-1}" = "1" ]; then
        ts_state="$PIROUETTE_PERSISTENT_ROOT/tailscale-state"
        sudo install -d -o root -g root -m 700 "$ts_state"
        if [ ! -L /var/lib/tailscale ] \
           || [ "$(sudo readlink /var/lib/tailscale 2>/dev/null)" != "$ts_state" ]; then
            # If /var/lib/tailscale exists as a regular dir (image-baked or
            # left over from a non-persistent run), move its contents into
            # the persistent target FIRST so the cached node key survives.
            if [ -d /var/lib/tailscale ] && [ ! -L /var/lib/tailscale ]; then
                sudo cp -an /var/lib/tailscale/. "$ts_state"/ 2>/dev/null || true
                sudo rm -rf /var/lib/tailscale
            fi
            sudo ln -sfn "$ts_state" /var/lib/tailscale
            log "tailscale state persisted at $ts_state"
        fi
    fi

    # Install if missing. The official install script auto-detects distro.
    if ! command -v tailscale >/dev/null 2>&1; then
        log "installing tailscale"
        curl -fsSL https://tailscale.com/install.sh | sudo sh
    fi

    # Start tailscaled in userspace mode if not already running.
    # `nohup` + `&` so it survives the bootstrap ssh session ending.
    # Idempotent: skip when pgrep finds an existing tailscaled.
    if ! pgrep -x tailscaled >/dev/null 2>&1; then
        log "starting tailscaled (userspace networking)"
        sudo nohup tailscaled \
            --tun=userspace-networking \
            --state=/var/lib/tailscale/tailscaled.state \
            --socket=/var/run/tailscale/tailscaled.sock \
            > /tmp/tailscaled.log 2>&1 &
        # Give tailscaled a moment to bind its control socket.
        for _ in 1 2 3 4 5; do
            sudo tailscale status --json >/dev/null 2>&1 && break
            sleep 1
        done
    fi

    # `tailscale up` if not authed yet. Streams the login URL to the
    # laptop's terminal (pru setup uses sshStreaming for this step).
    # `--ssh=false` because devpod already has its own sshd on :22 and
    # we don't want tailscale-ssh shadowing it.
    if ! sudo tailscale status >/dev/null 2>&1; then
        log "authenticating to tailnet as $PIROUETTE_TS_HOSTNAME (approve in browser)"
        sudo tailscale up \
            --hostname="$PIROUETTE_TS_HOSTNAME" \
            --ssh=false
    else
        log "tailscale already authed as $(sudo tailscale status --json | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 || echo unknown)"
    fi

    # `tailscale serve --bg --https=443 http://localhost:$PORT`
    # idempotent: re-running the same mapping is a no-op. Setting the
    # mapping survives tailscaled restarts (stored in serve config).
    log "bridging tailnet :443 -> http://localhost:$PIROUETTE_PORT"
    sudo tailscale serve --bg --https=443 "http://localhost:$PIROUETTE_PORT" || true

    # Extract the FQDN to plumb into PIROUETTE_ALLOWED_HOSTS so the
    # server's Host-header allowlist accepts the tailscale URL.
    #
    # We parse `tailscale serve status`'s plain-text output (which prints
    # the URL deterministically across versions) rather than
    # `tailscale status --json`. The JSON path is fragile: newer tailscale
    # versions pretty-print the JSON with whitespace between key and
    # value (`"DNSName": "..."`), which breaks naive regex extraction
    # and — with set -euo pipefail — kills the bootstrap. The plain-text
    # serve-status output is `https://<fqdn>/` on its own line; trivial
    # to extract and stable.
    #
    # `|| true` at the end so even if parsing fails the script doesn't
    # exit — the useful work (tailscaled up, serve configured) has
    # already happened, and an empty ts_fqdn just skips the optional
    # restart-with-allowlist below.
    ts_fqdn="$(sudo tailscale serve status 2>/dev/null \
        | grep -oE 'https://[^/[:space:]]+\.ts\.net' \
        | head -1 \
        | sed 's|^https://||' \
        || true)"
    if [ -n "$ts_fqdn" ]; then
        log "dashboard URL: https://$ts_fqdn"
        echo "$ts_fqdn" > "$PIROUETTE_DATA_DIR/tailscale-fqdn"

        # Restart the pirouette tmux session with the tailscale FQDN in
        # PIROUETTE_ALLOWED_HOSTS so the server's Host-header allowlist
        # accepts requests addressed to that hostname. (Loopback addresses
        # are always allowed automatically; only the new non-loopback FQDN
        # needs to be allow-listed.) Idempotent via a sentinel file: only
        # restart when the running session's FQDN differs from the
        # tailscale-current one.
        sentinel="$PIROUETTE_DATA_DIR/tailscale-fqdn-active"
        prev_fqdn="$(cat "$sentinel" 2>/dev/null || true)"
        if [ "$prev_fqdn" != "$ts_fqdn" ]; then
            log "restarting pirouette server (adding $ts_fqdn to allowed_hosts)"
            tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
            # build_server_env merges PIROUETTE_ALLOWED_HOSTS from config
            # with the tailscale FQDN so we don't drop existing entries.
            server_env="$(build_server_env "$ts_fqdn")"
            tmux new-session -d -s "$SESSION_NAME" \
                "PIROUETTE_DATA_DIR='$PIROUETTE_DATA_DIR' PIROUETTE_PORT='$PIROUETTE_PORT' PIROUETTE_HOST='$PIROUETTE_BIND_HOST' $server_env pirouette server 2>&1 | tee -a '$PIROUETTE_DATA_DIR/logs/pirouette.log'"
            echo "$ts_fqdn" > "$sentinel"
        fi
    fi
fi

log "bootstrap complete."
