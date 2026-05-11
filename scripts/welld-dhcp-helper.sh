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
#   release-hostname <name>   Remove every lease block where name=<name>.
#   flush-all                 Truncate the entire lease table to zero entries.
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

case "${1:-}" in
  release-hostname)
    [ $# -eq 2 ] || usage
    release_hostname "$2"
    ;;
  flush-all)
    [ $# -eq 1 ] || usage
    flush_all
    ;;
  *)
    usage
    ;;
esac
