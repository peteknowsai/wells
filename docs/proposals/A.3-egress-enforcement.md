# Phase A.3 — Egress enforcement: design choices for Pete

This is a design proposal, not a shipped feature. Phase A.3 needs decisions before code lands. The questions cluster around **privilege**, **DNS strategy**, and **ergonomics**. Pick one in each cluster; I'll implement.

---

## What this phase is

Today, `POST /v1/splites/{n}/policy/network` accepts allow/deny rules and persists them to `~/.splites/vms/{n}/policy.json`. The response carries `enforced: false` because nothing actually polices the wire — a splite can still curl anywhere.

Phase A.3 makes `enforced: true` honest. Two layers:

- **IP-level filtering at the host's pf firewall** for IP literals + ranges (and as the backstop for DNS-based rules — once a domain resolves to an IP, that IP must be reachable).
- **DNS-based filtering at the host's resolver** for domain rules. Without DNS-level handling, a denied domain that the guest still resolves leaks the IP into pf rules, and rule-set churns every time the splite re-resolves. Cleaner: NXDOMAIN at the resolver, then the guest never gets an IP at all.

---

## Cluster 1 — Privilege model (the big call)

`pfctl` is root-only on macOS. Splited runs as `pete` today. Three options:

### Option 1A — Splited runs as root (or under sudo)

Simplest mechanically. `splited.ts` calls `pfctl -a splite/<n> -f -` directly. No helper process, no IPC.

- 👍 No extra moving parts.
- 👎 Splited handling untrusted HTTP also runs as root. One bug = full host. Splited is the auth gate for the proxy and exec endpoints — not a small surface.
- 👎 `bun run` as root crosses a line that's hard to walk back. We'd want a launchd-installed root daemon, which is opinionated about install method.

### Option 1B — Privileged helper subprocess (recommended)

Splited stays as `pete`. A small Swift or Bash helper at `~/.splites/bin/splited-pf` runs setuid root (or via `sudoers` NOPASSWD entry scoped to that one binary). Splited shells out to it for every pf change:

```
splited-pf load <splite-name> <policy.json>   # writes anchor's rules
splited-pf clear <splite-name>                # drops anchor entirely
```

- 👍 Privilege blast radius is the helper, which is small and audit-able.
- 👍 No setuid Bun.
- 👎 One more thing in the install flow: helper must land at install time + sudoers entry written. We can ship `scripts/install-egress-helper.sh` that prompts for password once.
- 👎 Pete's the only sudoer on his Mac so the bar is low for him personally; less great if splites ever ships to non-admin users.

**This is the recommended option. Below assumes 1B unless we override.**

### Option 1C — launchd-installed root daemon

A separate `splited-pf` daemon running as root via launchd, listening on a Unix socket. Splited talks to it.

- 👍 Properest model — full process separation, restartable independent of splited.
- 👎 Two moving parts. Restart-coordination becomes a thing to think about.
- 👎 Heavier install (launchd plist + socket auth).

Worth doing later if the helper grows. Overkill for v1.

---

## Cluster 2 — DNS strategy

Two options (we don't need both for v1, but both are common in production fleets):

### Option 2A — Run a resolver per host (recommended)

Run `unbound` or `dnsmasq` on the host on `127.0.0.1:53` (or, since macOS reserves :53 for mDNSResponder, on `127.0.0.1:5353` and bridge via vmnet's NAT mapping). Cloud-init in the splite sets `/etc/resolv.conf` to point at the host.

Splited writes the resolver's "deny these domains" config from `policy.json` and `kill -HUP`s it. Allow rules are no-op (default-allow). The resolver returns NXDOMAIN for denied domains; allowed domains pass through to the system resolver.

- 👍 Truly blocks at the DNS layer — guest sees no IP, can't even attempt a connection.
- 👎 New dependency: `unbound` or `dnsmasq` must be installed (Homebrew). Adds an install-time check.
- 👎 macOS port 53 is taken; we'd run on a side port + vmnet NAT it. Doable but fiddly.

### Option 2B — IP-only enforcement (skip DNS for v1)

Pure pf. For domain rules, splited periodically resolves the domain and updates pf table state. Allow `github.com` → resolve → add IPs to allow table. Re-resolve every N minutes; expire entries after 2*N.

- 👍 Zero new dependencies on the host. Just pfctl.
- 👍 Privilege model is one helper, one tool.
- 👎 Race: between resolve and connect, the guest might hit a stale IP, or a freshly-rotated CDN IP we haven't seen yet. False denies on big CDNs.
- 👎 Doesn't truly stop a deny — the guest still resolves and tries; pf drops the SYN. Some attacks exfil via DNS itself; this misses them.

**Recommendation: 2A in principle, 2B for v1.** The DNS layer is meaningful for production cells deployments but not for pete's single-user dev box. Defer until we hear an actual customer ask for it (or until we have a fleet that needs it).

---

## Cluster 3 — Policy expressiveness

What rules do we honor in v1? Sprites's `policy.network.rules[*]` shape is `{action, domain}`. Cells uses three patterns:

```jsonc
[
  { "action": "allow", "domain": "github.com" },
  { "action": "allow", "domain": "*.amazonaws.com" },
  { "action": "deny",  "domain": "*" }
]
```

Default is permissive (no rules = allow everything). When at least one rule is present, the convention is "explicit allow-list with deny-all at the end". We'll honor that — but only if the rules contain `{action: deny, domain: "*"}` as a sentinel. Without that sentinel, rules are advisory (pf passes everything; we log mismatches but don't block) — useful for staging.

For v1: support `domain` only (no IP/CIDR rules; no protocol/port). Cells doesn't use those. We can grow to it.

---

## Cluster 4 — UX

Three small calls:

- **`enforced: true` flag flips when…?** When the helper successfully `pfctl`-applies the rules. Failure = stays `false` + a `last_error` field. Don't pretend.
- **Removing a splite cleans up its anchor.** `splited-pf clear` runs on destroy.
- **Splited startup re-applies all anchors.** State drift after a host restart is silent and bad. On boot, walk the registry, reapply.

---

## Open questions for Pete

1. **Privilege: 1B (recommended) or another?** If 1B, are you OK installing the sudoers entry once per host? `scripts/install-egress-helper.sh` would prompt for your password and write to `/private/etc/sudoers.d/splites-pf`.
2. **DNS: 2A or 2B for v1?** I'd ship 2B (pf-only) first, document the leaks, defer 2A. Weigh in if you'd rather have 2A from day one — the install-time `brew install unbound` is the only friction.
3. **Policy expressiveness:** confirm domain-only rules are enough for v1 (matches cells's actual usage), and the "no sentinel = advisory mode" semantic.
4. **Enforcement scope:** v1 enforces *outbound from splite to internet*. Inbound is already gated (proxy auth). Do we also want to firewall splite-to-splite traffic? On Pete's single-host setup that's typically fine, but for cells's eventual multi-tenant use it's load-bearing.

---

## Implementation order once you bless a path

Each fire ticks one:

- A.3.1 — `splited-pf` helper skeleton (Bash). Sudoers install script. Smoke against pf anchor.
- A.3.2 — Wire splited's policy.json POST to invoke the helper. `enforced` flag honest.
- A.3.3 — Splited startup reapplies anchors from registry + policy.json.
- A.3.4 — DNS-name-resolution loop (option 2B): periodic resolve into pf tables, with expiry.
- A.3.5 — Smoke test: allow github.com, deny everything; curl from inside splite proves it.

If 2A wins instead of 2B, swap A.3.4 for unbound config + cloud-init resolver pointer.

Total: 5 fires to ship 2B, 4 if we skip the resolution loop and rely on pf tables flat. Or roll all into 8 fires for the full 2A path.

**Until you weigh in, I'm leaving A.3 stubbed and moving on.** Other phase-A work that doesn't need this decision is unblocked.

---

## In plain English

Right now, splites pretends to enforce "this VM can talk to github but not evil.com" but doesn't actually stop anything — it just remembers the rules. Real enforcement needs to write rules into the Mac's firewall, which only `root` can do. Three ways to get there: run splites as root (bad), make a tiny helper that's allowed to run sudo (good — what I'd pick), or run a separate firewall daemon (overkill for v1).

There's also a question of how to handle "domain" rules versus "IP" rules. Domains are what people actually write ("block facebook.com"); IPs are what the firewall actually understands. Either we ask the Mac's DNS server to lie when it sees blocked domains (cleaner, but means installing extra software), or we resolve the domain ourselves and feed its IPs to the firewall (works with what's already there but races).

Recommendation: ship the lighter-weight pf-only version first. It's good enough for Pete's single-Mac setup and for cells's foreseeable usage; the DNS-resolver path is a future upgrade for fleets that genuinely need leakproof denial.

When Pete's awake, he picks: privilege model + DNS strategy. Then I implement.
