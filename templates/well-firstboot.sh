#!/bin/bash
# B.0.9.d.4: per-well identity injection — replaces cloud-init.
#
# Runs once on each well's first boot via well-firstboot.service.
# Reads identity from /dev/disk/by-label/cidata (NoCloud-style read-
# only seed disk built by lib/wellSeed.ts on the host) and applies it:
# hostname, SSH host keys, authorized_keys, per-well user, machine-id,
# swap, DNS pointer at host.well bridge resolver.
#
# After completion, touches /etc/.well-ready. The systemd unit's
# `ConditionPathExists=!/etc/.well-ready` makes subsequent boots a
# no-op in microseconds — wells's hibernate flow detaches the cidata
# before save, so steady-state boots have no auxiliary attachment for
# Apple's restoreMachineStateFrom to validate.
#
# Ships in the base image at /usr/local/sbin/well-firstboot.

set -euo pipefail

log() { echo "[well-firstboot] $*" >&2; }

SEED="/run/cidata"
mkdir -p "$SEED"

# vmnet's bootpd labels removable disks variably; check both common
# casings before giving up.
DEV=""
for label in CIDATA cidata; do
    if [ -e "/dev/disk/by-label/$label" ]; then
        DEV="/dev/disk/by-label/$label"
        break
    fi
done
if [ -z "$DEV" ]; then
    log "no cidata seed disk found at /dev/disk/by-label/{CIDATA,cidata} — refusing to seed"
    exit 1
fi

mount -o ro "$DEV" "$SEED"
trap "umount $SEED 2>/dev/null || true" EXIT

if [ ! -f "$SEED/well.env" ]; then
    log "$SEED/well.env missing — bad seed disk"
    exit 2
fi

# shellcheck disable=SC1091
source "$SEED/well.env"

: "${WELL_HOSTNAME:?well.env missing WELL_HOSTNAME}"
: "${WELL_USER:=well}"

log "applying identity: hostname=$WELL_HOSTNAME user=$WELL_USER"

hostnamectl set-hostname "$WELL_HOSTNAME"
echo "$WELL_HOSTNAME" > /etc/hostname

# Per-host SSH keys — every well gets its own. The base image ships
# baked-in keys from bake time; rotate now so hosts can't impersonate
# each other.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A

# authorized_keys for the ubuntu user (cloud image's default) + the
# per-well well user. Both keys share — host orchestrator (welld) uses
# either as appropriate.
if [ -f "$SEED/authorized_keys" ]; then
    install -d -o ubuntu -g ubuntu -m 0700 /home/ubuntu/.ssh
    install -o ubuntu -g ubuntu -m 0600 "$SEED/authorized_keys" /home/ubuntu/.ssh/authorized_keys

    id "$WELL_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash -d "/home/$WELL_USER" -G sudo "$WELL_USER"
    install -d -o "$WELL_USER" -g "$WELL_USER" -m 0700 "/home/$WELL_USER/.ssh"
    install -o "$WELL_USER" -g "$WELL_USER" -m 0600 "$SEED/authorized_keys" "/home/$WELL_USER/.ssh/authorized_keys"
    echo "$WELL_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-well
    chmod 440 /etc/sudoers.d/90-well
fi

# Fresh machine-id so DBus/journal/anything keyed off it doesn't
# collide across wells cloned from the same disk.
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup

# /etc/hosts gets host.well pinned at the vmnet gateway. Skip if
# already present (idempotent across base bakes that pre-applied it).
GATEWAY=$(ip route show default | awk '/default/ {print $3}' | head -1)
if ! grep -q '\bhost\.well\b' /etc/hosts; then
    echo "$GATEWAY  host.well" >> /etc/hosts
fi

# DNS: route .well queries to welld's bridge resolver on port 5353.
# systemd-resolved 253+ supports IP:PORT in DNS=.
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/well.conf <<EOF
[Resolve]
DNS=$GATEWAY:5353
Domains=~well
EOF
systemctl restart systemd-resolved || true

# 512 MB swap as a safety net for working-set spikes past the well's
# RAM allocation. Idempotent — only set up if /swap.img doesn't exist.
if [ ! -f /swap.img ]; then
    fallocate -l 512M /swap.img
    chmod 600 /swap.img
    mkswap /swap.img
    swapon /swap.img
    echo '/swap.img none swap sw 0 0' >> /etc/fstab
fi

# Final marker. Subsequent boots skip the entire script via the
# service's ConditionPathExists=!/etc/.well-ready gate.
touch /etc/.well-ready
log "first-boot identity injection complete"
