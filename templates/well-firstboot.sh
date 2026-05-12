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

# --env passthroughs to /etc/environment. PAM reads this file on every
# session including non-login SSH, so cells's `well exec -- cmd` reliably
# sees CELLS_PROXY_SECRET / etc. Append-only — we never blow away what's
# already there (cloud image's PATH, distro defaults).
if [ -f "$SEED/etc-environment.append" ]; then
    # Idempotent: drop any prior wells-managed block, then re-add.
    sed -i '/^# wells-env --- begin$/,/^# wells-env --- end$/d' /etc/environment 2>/dev/null || true
    {
        echo "# wells-env --- begin"
        cat "$SEED/etc-environment.append"
        echo "# wells-env --- end"
    } >> /etc/environment
    log "applied $(grep -c '=' "$SEED/etc-environment.append") env passthroughs to /etc/environment"
fi

hostnamectl set-hostname "$WELL_HOSTNAME"
echo "$WELL_HOSTNAME" > /etc/hostname

# Per-host SSH keys — every well gets its own. The base image ships
# baked-in keys from bake time; rotate now so hosts can't impersonate
# each other. We skip RSA: it needs ~1 KB of entropy and Apple VZ
# guests' first-boot entropy pool is thin (intermittent multi-minute
# stalls in getrandom() observed 2026-05-10 on cell-base). Ed25519
# wants ~32 bytes and ECDSA-P256 wants ~64. haveged + random.trust_cpu
# (configured at bake) cover the daemon-level fix; this line caps the
# blast radius from any residual stall.
rm -f /etc/ssh/ssh_host_*
ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key
ssh-keygen -q -t ecdsa -N "" -f /etc/ssh/ssh_host_ecdsa_key

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

    # Same substrate key for the cell user. Cells's host-bridge does
    # `ssh cell@<ip>` directly (services API hardcodes User=ubuntu,
    # bridge wants cell). Re-using the seed key avoids managing a
    # second per-well keypair. The cell user is created at bake time
    # via cloud-init-base.yaml (home /cell, NOPASSWD sudo).
    if id cell >/dev/null 2>&1; then
        install -d -o cell -g cell -m 0700 /cell/.ssh
        install -o cell -g cell -m 0600 "$SEED/authorized_keys" /cell/.ssh/authorized_keys
    fi
fi

# Fresh machine-id so DBus/journal/anything keyed off it doesn't
# collide across wells cloned from the same disk. NB: this also
# changes the systemd-networkd DUID, so the steady-state boot after
# warming gets a NEW DHCP lease (new IP). welld accommodates via
# delta-snapshot lease lookup post-warming.
rm -f /etc/machine-id /var/lib/dbus/machine-id
systemd-machine-id-setup

# W.72: static IP from cidata. When welld allocated a static address
# at create time, well.env carries WELL_STATIC_IP_CIDR + WELL_GATEWAY +
# WELL_NAMESERVERS. We rewrite /etc/netplan/01-well.yaml (baked into
# the base image with dhcp4: true) and `netplan apply` to switch the
# guest off DHCP entirely. Bootpd is bypassed for the rest of the
# well's life; the steady-state boot after warming comes up directly
# on the static address with no DHCP step.
#
# When WELL_STATIC_IP_CIDR is unset (legacy / static range disabled),
# the existing dhcp4: true netplan is left alone.
if [ -n "${WELL_STATIC_IP_CIDR:-}" ]; then
    : "${WELL_GATEWAY:?well.env missing WELL_GATEWAY (paired with WELL_STATIC_IP_CIDR)}"
    : "${WELL_NAMESERVERS:?well.env missing WELL_NAMESERVERS (paired with WELL_STATIC_IP_CIDR)}"
    # Build the nameservers YAML block without a trailing newline so the
    # heredoc terminator below stays on its own line.
    NS_YAML=""
    IFS=',' read -ra NS_LIST <<< "$WELL_NAMESERVERS"
    for ns in "${NS_LIST[@]}"; do
        if [ -z "$NS_YAML" ]; then
            NS_YAML="            - ${ns}"
        else
            NS_YAML="${NS_YAML}"$'\n'"            - ${ns}"
        fi
    done
    cat > /etc/netplan/01-well.yaml <<NETPLAN
network:
  version: 2
  ethernets:
    enp0s1:
      dhcp4: false
      addresses:
        - ${WELL_STATIC_IP_CIDR}
      routes:
        - to: default
          via: ${WELL_GATEWAY}
      nameservers:
        addresses:
${NS_YAML}
NETPLAN
    chmod 0600 /etc/netplan/01-well.yaml
    netplan generate
    netplan apply
    log "applied static IP: ${WELL_STATIC_IP_CIDR} via ${WELL_GATEWAY}"
fi

# vmnet bridge gateway is always 192.168.64.1 — hardcoded so this
# script doesn't need `ip route show default` (race with networkd).
GATEWAY="${WELL_GATEWAY:-192.168.64.1}"
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
# Wells-managed: exempt the host vmnet bridge from PerSourcePenalties
# and bump MaxStartups for parallel well_exec fan-out from cells.
# All trusted host-side ssh comes from 192.168.64.1.
PerSourcePenaltyExemptList 192.168.64.1
MaxStartups 30:30:100
MaxSessions 100
EOF
systemctl reload ssh || systemctl restart ssh || true

# Drop systemd-networkd-wait-online timeout from 90s default to 5s.
# well-firstboot.service runs After=network-online.target; if networkd
# stalls (failed DHCP race, weird tap state, etc.), the entire boot
# blocks on the 90s ceiling before falling through. 5s is plenty for
# vmnet DHCP — typical successful boot is ~3-4s. Bonus: shaves boot
# time off warming-restart in the success path too, since networkd-
# wait-online sometimes pads its wait beyond the actual link-up event.
# Idempotent: writing the same drop-in twice is a no-op.
# B.0.9.d.4 create+warm latency optimization, option #2.
mkdir -p /etc/systemd/system/systemd-networkd-wait-online.service.d
cat > /etc/systemd/system/systemd-networkd-wait-online.service.d/timeout.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --timeout=5
EOF
# daemon-reload so the override is picked up on the next boot. Doesn't
# affect the currently-running unit (it already ran to completion).
systemctl daemon-reload || true

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
