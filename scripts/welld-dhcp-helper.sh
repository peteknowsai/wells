#!/usr/bin/env bash
# Privileged helper for editing /var/db/dhcpd_leases.
#
# Installed to /usr/local/sbin/welld-dhcp-helper (root:wheel 0755), invoked by
# welld via `sudo -n /usr/local/sbin/welld-dhcp-helper <verb> [args]`. The
# sudoers entry at /etc/sudoers.d/welld-dhcp grants NOPASSWD to the calling
# user for this exact binary — see scripts/install-dhcp-helper.sh.
#
# Blast radius: this helper can ONLY edit /var/db/dhcpd_leases and kick
# bootpd. It cannot do other root things. Reversible via uninstall.
#
# Verbs:
#   release-hostname <name>          Remove every lease block where name=<name>.
#                                    Kicks bootpd (single op).
#   publish-hostname <name> <ip> <mac> [<lease-epoch-hex>]
#                                    Atomic add-or-replace lease entry for the
#                                    triple. Does NOT kick bootpd — caller is
#                                    expected to call `kick-bootpd` after a
#                                    batch of publishes (W.70: prevents the
#                                    bootpd-kick storm under high alive-well
#                                    counts). Used by welld's lease publisher.
#   kick-bootpd                      Standalone `launchctl kickstart -k` for
#                                    the publisher's batch-end signal.
#   flush-all                        Truncate the entire lease table.
#
# After modification, the helper signals bootpd via `launchctl kickstart -k`
# so its in-memory state matches the on-disk file. The kick is best-effort:
# if bootpd isn't loaded (e.g., vmnet inactive), we skip without erroring.
#
# Concurrency: an flock on the leases file serializes concurrent welld
# destroys. The lock is held only across the rewrite (fast: file is ~tens of
# KB and the rewrite is atomic via tmp+rename).

set -euo pipefail

LEASES_FILE="/var/db/dhcpd_leases"
LOCK_DIR="/var/run/welld-dhcp-helper.lockd"

die() {
  echo "welld-dhcp-helper: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<USAGE
Usage:
  welld-dhcp-helper release-hostname <name>
  welld-dhcp-helper publish-hostname <name> <ip> <mac> [<lease-epoch-hex>]
  welld-dhcp-helper kick-bootpd
  welld-dhcp-helper flush-all
USAGE
  exit 64
}

[ "$(id -u)" = "0" ] || die "must run as root (invoke via sudo)"

# Script-scope tmp path (not local) so the EXIT trap can reference it
# after the function returns. Defaults to empty so set -u doesn't trip
# in the trap if mktemp was never called (flush-all path).
tmp=""

# Single EXIT cleanup. Safe to call before either lock or tmp exist.
cleanup() {
  if [ -n "$tmp" ] && [ -f "$tmp" ]; then
    rm -f "$tmp"
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Acquire an exclusive lock via mkdir (atomic on POSIX; works on macOS
# without flock/shlock). Releases on script exit via the cleanup trap.
# Times out at 10s — well past the worst-case rewrite duration.
acquire_lock() {
  local tries=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 100 ]; then
      die "timeout acquiring lock $LOCK_DIR (stale? remove it manually)"
    fi
    sleep 0.1
  done
}

# Refuse on non-Apple-vmnet-shaped lease files (defense in depth: if someone
# tricks the install to point at /etc/passwd or similar, we won't rewrite it).
sanity_check() {
  [ -f "$LEASES_FILE" ] || die "leases file missing: $LEASES_FILE"
  # File is small; sample the first few lines to confirm shape.
  local head
  head=$(head -c 256 "$LEASES_FILE" 2>/dev/null || true)
  if [ -n "$head" ] && ! echo "$head" | grep -qE '^\{|name=|ip_address=|hw_address='; then
    die "leases file shape unrecognized — refusing to rewrite"
  fi
}

kick_bootpd() {
  # Best-effort. bootpd may not be loaded (vmnet inactive); ignore failures.
  launchctl kickstart -k system/com.apple.bootpd 2>/dev/null || true
}

release_hostname() {
  local target="$1"
  [ -n "$target" ] || die "release-hostname requires a name"
  # Validate hostname shape — matches wellPolicy.ts NAME_RE plus a few
  # bake/staging prefixes. Refuses anything with shell metacharacters.
  if ! echo "$target" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$'; then
    die "hostname '$target' has invalid shape"
  fi

  sanity_check
  acquire_lock

  tmp=$(mktemp /tmp/welld-dhcp-leases.XXXXXX) || die "mktemp failed"

  # awk pass: drop every {...} block whose `name=` matches target.
  # Block delimiters are `^{` and `^}`. Inside a block, if we see
  # `name=<target>`, mark for drop. At block end, emit the buffer
  # iff drop=0.
  awk -v target="$target" '
    BEGIN { buf = ""; drop = 0; in_block = 0 }
    /^\{[[:space:]]*$/ {
      buf = $0 "\n"
      drop = 0
      in_block = 1
      next
    }
    /^\}[[:space:]]*$/ {
      buf = buf $0 "\n"
      if (!drop) printf "%s", buf
      buf = ""
      in_block = 0
      next
    }
    in_block {
      buf = buf $0 "\n"
      # Match `name=<target>` with optional leading whitespace.
      if ($0 ~ ("^[[:space:]]*name=" target "[[:space:]]*$")) drop = 1
      next
    }
    { print }
  ' "$LEASES_FILE" > "$tmp"

  # Atomic replace.
  chmod 0644 "$tmp"
  chown root:wheel "$tmp"
  mv "$tmp" "$LEASES_FILE"

  kick_bootpd
  echo "released: $target"
}

flush_all() {
  sanity_check
  acquire_lock
  : > "$LEASES_FILE"
  chmod 0644 "$LEASES_FILE"
  chown root:wheel "$LEASES_FILE"
  kick_bootpd
  echo "flushed: all leases cleared"
}

# Atomic add-or-replace lease entry. Drops any existing entry for the
# hostname or for the (ip, mac) tuple (defense against stale aliases),
# then appends a fresh entry at the end. Used by welld's lease publisher
# (W.68) to keep the leases file consistent with welld's view of alive
# wells.
publish_hostname() {
  local target="$1"
  local target_ip="$2"
  local target_mac="$3"
  local lease_hex="${4:-}"

  [ -n "$target" ] || die "publish-hostname requires <name>"
  [ -n "$target_ip" ] || die "publish-hostname requires <ip>"
  [ -n "$target_mac" ] || die "publish-hostname requires <mac>"

  # Hostname: must match wellPolicy NAME_RE.
  if ! echo "$target" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$'; then
    die "hostname '$target' has invalid shape"
  fi
  # IPv4 dotted-quad. Defense in depth — TS wrapper validates too.
  if ! echo "$target_ip" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    die "ip '$target_ip' has invalid shape"
  fi
  # MAC: six colon-separated hex bytes, 1-2 hex digits each. Apple's
  # lease file emits with leading zeros stripped per byte, so we accept
  # 1-2 digits.
  if ! echo "$target_mac" | grep -qiE '^([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$'; then
    die "mac '$target_mac' has invalid shape"
  fi
  # Optional lease epoch — must be hex. Default to now+24h.
  if [ -z "$lease_hex" ]; then
    local future
    future=$(( $(date +%s) + 86400 ))
    lease_hex=$(printf '%x' "$future")
  else
    if ! echo "$lease_hex" | grep -qiE '^[0-9a-f]+$'; then
      die "lease epoch '$lease_hex' must be hex"
    fi
  fi

  sanity_check
  acquire_lock

  tmp=$(mktemp /tmp/welld-dhcp-leases.XXXXXX) || die "mktemp failed"

  # First pass: drop any block matching target hostname OR target IP.
  # We drop by IP too so a stale alias for the same address gets cleared
  # (e.g., after a fork-and-rename where the lease file still has the
  # old name pointing at this ip).
  awk -v target="$target" -v target_ip="$target_ip" '
    BEGIN { buf = ""; drop = 0; in_block = 0 }
    /^\{[[:space:]]*$/ {
      buf = $0 "\n"; drop = 0; in_block = 1; next
    }
    /^\}[[:space:]]*$/ {
      buf = buf $0 "\n"
      if (!drop) printf "%s", buf
      buf = ""; in_block = 0; next
    }
    in_block {
      buf = buf $0 "\n"
      if ($0 ~ ("^[[:space:]]*name=" target "[[:space:]]*$")) drop = 1
      if ($0 ~ ("^[[:space:]]*ip_address=" target_ip "[[:space:]]*$")) drop = 1
      next
    }
    { print }
  ' "$LEASES_FILE" > "$tmp"

  # Append the new entry. Format matches Apple's bootpd output exactly
  # (tab-indented, hw_address with `01,` prefix = DHCP client-id type
  # 0x01 = ethernet hardware address per RFC 2132 §9.14).
  cat >> "$tmp" <<ENTRY
{
	name=$target
	ip_address=$target_ip
	hw_address=1,$target_mac
	identifier=1,$target_mac
	lease=0x$lease_hex
}
ENTRY

  chmod 0644 "$tmp"
  chown root:wheel "$tmp"
  mv "$tmp" "$LEASES_FILE"
  tmp=""  # cleanup trap should not try to delete the moved file

  # NOTE: deliberately does NOT kick bootpd. Caller batches publishes
  # then issues one `kick-bootpd` at the end. W.70 — prevents the kick
  # storm that broke DHCP for running VMs when sweep ran with N alive
  # wells (each publish = one SIGKILL of bootpd; ~96/min broke
  # in-flight renewals).
  echo "published: $target $target_ip $target_mac"
}

case "${1:-}" in
  release-hostname)
    [ $# -eq 2 ] || usage
    release_hostname "$2"
    ;;
  publish-hostname)
    [ $# -ge 4 ] && [ $# -le 5 ] || usage
    publish_hostname "$2" "$3" "$4" "${5:-}"
    ;;
  kick-bootpd)
    [ $# -eq 1 ] || usage
    kick_bootpd
    echo "kicked: bootpd"
    ;;
  flush-all)
    [ $# -eq 1 ] || usage
    flush_all
    ;;
  *)
    usage
    ;;
esac
