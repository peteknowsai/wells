#!/bin/bash
# B.0.9.d.4: per-well identity injection — replaces cloud-init.
#
# Runs once on each well's first boot via well-firstboot.service.
# Reads identity from /dev/disk/by-label/cidata (NoCloud-style read-
# only seed disk built by lib/wellSeed.ts on the host) and applies it:
# hostname, SSH host keys, authorized_keys, per-well user, machine-id,
# swap, DNS pointer at host.well bridge resolver.
#
# Service unit ordering: After=network-online.target. This means
# networking is up by the time we run — `ip route` works — but
# hostname is set late. welld uses delta-snapshot lease lookup so
# that's fine. The earlier Before=systemd-networkd.service ordering
# hung steady-state restarts when cidata was absent (script fail
# blocked networking). After= is the safe shape.
#
# After completion, touches /etc/.well-ready. The systemd unit's
# `ConditionPathExists=!/etc/.well-ready` makes subsequent boots a
# no-op in microseconds.

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
    # No cidata at boot is the steady-state path (warming-restart, wake
    # from hibernation). Touch the marker so future boots skip too,
    # and exit clean — failing here would leak into welld's status.
    log "no cidata seed disk — steady-state boot, marking ready"
    touch /etc/.well-ready
    exit 0
fi

mount -o ro "$DEV" "$SEED"
trap "umount $SEED 2>/dev/null || true" EXIT

if [ ! -f "$SEED/well.env" ]; then
    log "$SEED/well.env missing — bad seed; marking ready anyway"
    touch /etc/.well-ready
    exit 0
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
# collide across wells cloned from the same disk. NB: this also
# changes the systemd-networkd DUID, so the steady-state boot after
# warming gets a NEW DHCP lease (new IP). welld accommodates via
# delta-snapshot lease lookup post-warming.
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup

# vmnet bridge gateway is always 192.168.64.1 — hardcoded so this
# script doesn't need `ip route show default` (race with networkd).
GATEWAY="192.168.64.1"
if ! grep -q 'host\.well' /etc/hosts; then
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

# Exempt the host bridge gateway from sshd's PerSourcePenalties.
# OpenSSH 10 (Ubuntu 25.10+) ships with PerSourcePenalties on by default
# with `noauth:1` and `min:15` — every disconnect-without-auth from the
# same source IP gets a 15-second drop-connection penalty that stacks.
# Wells's host-side flows (welld create+warm probes, lume-side ssh,
# operator's `well exec` from CLI) all originate at 192.168.64.1, so a
# burst of N connections triggers ~N×15s of penalty against the host
# bridge — observed live 2026-05-09 as cells team's blocker #3 (`well
# exec` after rapid prior calls returns "kex_exchange_identification:
# read: Connection reset by peer"). The penalty logic is sensible
# protection against external scanners but actively breaks our trusted
# host-bridge access. Exempt the bridge IP only — don't disable the
# whole feature.
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/01-well-host-exempt.conf <<EOF
# Wells-managed: exempt the host vmnet bridge from PerSourcePenalties.
# All trusted host-side ssh comes from 192.168.64.1.
PerSourcePenaltyExemptList 192.168.64.1
EOF
systemctl reload ssh || systemctl restart ssh || true

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
