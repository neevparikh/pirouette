#!/bin/bash
# Pirouette EC2 bootstrap script. Runs once on first boot via cloud-init.
#
# Variables substituted by the CLI before launch:
#   PIROUETTE_VOLUME_ID      — EBS volume id expected to be attached (vol-...)
#   PIROUETTE_DATA_MOUNT     — where to mount the volume on the host (e.g. /var/lib/pirouette)
#   PIROUETTE_DOCKER_IMAGE   — container image to pull (placeholder, used in chunk 5)
#
# Idempotent: safe to re-run. All expensive steps are guarded by existence checks.
#
# Output goes to /var/log/cloud-init-output.log. `pru logs --boot` will tail it.

set -euo pipefail

log() { echo "[pirouette-bootstrap] $*"; }

log "starting bootstrap on $(uname -a)"
log "waiting for apt to be unlocked..."
while pgrep -x "apt-get|dpkg" > /dev/null 2>&1; do sleep 2; done

# ---- 1. Install Docker (but don't start it until EBS + data-root config) ----
if ! command -v docker > /dev/null; then
    log "installing docker"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg lsb-release jq nvme-cli < /dev/null

    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io < /dev/null
    # Explicitly DON'T enable --now yet; we need to relocate data-root first.
    systemctl stop docker.service docker.socket 2>/dev/null || true
    usermod -aG docker ubuntu
    log "docker installed (not started)"
else
    log "docker already installed"
fi

# ---- 2. Locate the EBS data volume --------------------------------------
#
# Modern Nitro instances (m6i et al) expose EBS as NVMe. The OS device name
# (e.g. /dev/nvme1n1) isn't guaranteed to match the attach-volume --device
# argument, so we look up the block device by its NVMe serial, which equals
# the AWS volume id with the `vol-` prefix stripped. The volume may be
# attached a few seconds after user-data starts; poll with a generous timeout.
find_volume_device() {
    local target_serial="${PIROUETTE_VOLUME_ID#vol-}"
    for dev in /dev/nvme*n1; do
        [ -b "$dev" ] || continue
        # nvme id-ctrl returns hex-padded serial for some EBS vols; normalise
        local serial
        serial=$(nvme id-ctrl -o json "$dev" 2>/dev/null | jq -r '.sn' | tr -d ' ')
        # Accept both "vol0abc…" and "vol-0abc…" / with or without dashes
        case "$serial" in
            *"${target_serial//-/}"*) echo "$dev"; return 0 ;;
            *"${target_serial}"*) echo "$dev"; return 0 ;;
        esac
    done
    return 1
}

log "waiting for EBS volume $PIROUETTE_VOLUME_ID to appear..."
VOLUME_DEVICE=""
for i in $(seq 1 60); do
    if VOLUME_DEVICE=$(find_volume_device); then
        log "found EBS volume at $VOLUME_DEVICE after ${i}s"
        break
    fi
    sleep 1
done
if [ -z "$VOLUME_DEVICE" ]; then
    log "ERROR: EBS volume $PIROUETTE_VOLUME_ID did not appear in 60s; aborting"
    exit 1
fi

# ---- 3. Format (first time only) + mount --------------------------------
FSTYPE=$(blkid -o value -s TYPE "$VOLUME_DEVICE" || true)
if [ -z "$FSTYPE" ]; then
    log "formatting $VOLUME_DEVICE as ext4 (fresh volume)"
    mkfs.ext4 -L pirouette-data "$VOLUME_DEVICE"
else
    log "$VOLUME_DEVICE already has $FSTYPE filesystem; skipping format"
fi

mkdir -p "$PIROUETTE_DATA_MOUNT"

# Use LABEL for fstab so device-name churn doesn't break mounts across reboots.
if ! grep -q "LABEL=pirouette-data" /etc/fstab; then
    log "adding /etc/fstab entry"
    echo "LABEL=pirouette-data $PIROUETTE_DATA_MOUNT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

if ! mountpoint -q "$PIROUETTE_DATA_MOUNT"; then
    log "mounting $VOLUME_DEVICE -> $PIROUETTE_DATA_MOUNT"
    mount "$PIROUETTE_DATA_MOUNT"
fi

chown -R ubuntu:ubuntu "$PIROUETTE_DATA_MOUNT"

# ---- 4. Prep subdirectories for later chunks -----------------------------
sudo -u ubuntu mkdir -p \
    "$PIROUETTE_DATA_MOUNT/sessions" \
    "$PIROUETTE_DATA_MOUNT/worktrees" \
    "$PIROUETTE_DATA_MOUNT/state" \
    "$PIROUETTE_DATA_MOUNT/scripts" \
    "$PIROUETTE_DATA_MOUNT/logs" \
    "$PIROUETTE_DATA_MOUNT/tarballs"

# Container home is a persistent bind-mount so dotfiles (yadm repo, npm
# globals, pirouette caches) survive docker restarts without re-cloning.
# Owned uid/gid 1000 — the conventional non-root uid that both this VM's
# `ubuntu` user and most dev-container images use (including npx27/dev-unfetched).
# The pirouette CLI creates per-container-user directories (home-<user>)
# when it launches the container; here we just ensure uid 1000 owns the
# parent so `sudo -u ubuntu` operations work.
# (No pre-created home-<user>/ dir here — pirouette creates them on demand.)

# The agent-sock directory is where the user's forwarded SSH agent socket
# appears when they SSH in with RemoteForward. Container bind-mounts this
# directory and reads SSH_AUTH_SOCK=/agent-sock/ssh.sock.
sudo mkdir -p "$PIROUETTE_DATA_MOUNT/agent-sock"
sudo chown 1000:1000 "$PIROUETTE_DATA_MOUNT/agent-sock"
sudo chmod 0755 "$PIROUETTE_DATA_MOUNT/agent-sock"

# Docker + containerd data roots live on the EBS volume.
mkdir -p "$PIROUETTE_DATA_MOUNT/docker" "$PIROUETTE_DATA_MOUNT/containerd"

# ---- 4b. Enable unix-socket RemoteForward for agent-socket forwarding ---
# Without StreamLocalBindUnlink, sshd refuses to replace an existing socket
# at the RemoteForward target path — so reconnecting with ssh would fail.
if ! grep -q '^StreamLocalBindUnlink' /etc/ssh/sshd_config; then
    echo 'StreamLocalBindUnlink yes' >> /etc/ssh/sshd_config
    systemctl reload ssh || systemctl reload sshd || true
    log "enabled StreamLocalBindUnlink in sshd_config"
fi

# ---- 5. Relocate Docker + containerd storage to the EBS volume -----------
# The default Ubuntu root volume is ~8 GiB; the dev container image alone is
# 12+ GiB extracted. Keep all image layers and container rootfs on the
# persistent EBS volume so:
#   (a) root doesn't fill up,
#   (b) re-provisioned instances can reuse cached layers across setup cycles.
log "pointing docker + containerd at $PIROUETTE_DATA_MOUNT"
mkdir -p /etc/docker /etc/containerd
cat > /etc/docker/daemon.json <<JSON
{
    "data-root": "$PIROUETTE_DATA_MOUNT/docker"
}
JSON
cat > /etc/containerd/config.toml <<TOML
version = 2
root = "$PIROUETTE_DATA_MOUNT/containerd"
state = "/run/containerd"
[plugins."io.containerd.grpc.v1.cri".containerd]
  snapshotter = "overlayfs"
TOML

systemctl daemon-reload
systemctl enable containerd
systemctl restart containerd
systemctl enable docker
systemctl start docker

# ---- 6. Container pull ---------------------------------------------------
# We pull now to warm the cache, but the container isn't started here —
# `pru setup` finishes that step after source + pi config are rsynced.
log "pulling container image $PIROUETTE_DOCKER_IMAGE"
docker pull "$PIROUETTE_DOCKER_IMAGE" || log "WARN: image pull failed; retry later"

log "bootstrap complete"
touch "$PIROUETTE_DATA_MOUNT/.bootstrap-done"
