# Blocked work

Items that need Pete's input or external resources before they can ship. Append-only — when resolved, move to a note in `MVP-PLAN.md` and delete from here.

---

## A.1.3 hot tier — `bin/lume` needs Developer ID signing

**Date raised:** 2026-05-06
**Phase:** A.1.3.f (hot tier wiring)

### What's blocked
Pause/resume of a running splite (the "hot" sleep tier — VM paused in RAM, instant wake). Implementation is done end-to-end in our patched lume (`vendor/lume/`) and the daemon (`lib/lifecycle.ts`, `engine/lume.ts`), but the kernel rejects every VZVirtualMachine instantiation our `bin/lume serve` attempts:

```
ERROR: Failed in VM.run name=pete errorType=NSError
error=Invalid virtual machine configuration. The process doesn't have the
"com.apple.security.virtualization" entitlement.
```

### Root cause
`com.apple.security.virtualization` is a restricted entitlement. macOS only honors it when the binary is signed with an Apple Developer ID **and** carries a matching `embedded.provisionprofile` that authorizes the entitlement. Adhoc signing (`codesign --sign -`) doesn't qualify, even with the entitlement file applied.

The upstream `lume.app` (at `~/.local/share/lume/lume.app/...`) ships with both — that's why `lume run` (which transparently resolves to the upstream binary) works fine for starting splites. Our hot-built `bin/lume` is the same source, but unsigned by Apple, so it can talk HTTP but can't start VMs.

### Resolution path
Pete confirmed (2026-05-06) he has an Apple Developer account. To unblock:

1. Pete creates a Developer ID Application certificate for the splites team and installs it in his keychain (one-time, via Apple Developer portal or Xcode → Settings → Accounts → Manage Certificates).
2. Pete creates an App ID + provisioning profile for the bundle ID we'll ship under (e.g. `md.cells.splites.lume` — must be different from upstream's `com.trycua.lume`). Profile must include `com.apple.security.virtualization`.
3. Save the `.provisionprofile` to `vendor/lume.patches/embedded.provisionprofile` (gitignored) or a path of his choosing.
4. Update `scripts/build-lume.sh` to:
   - Build into a `.app` bundle structure (not flat binary; mirror upstream's `scripts/build/build-release.sh`).
   - Embed the provisioning profile.
   - `codesign --sign "Developer ID Application: <name> (<TEAMID>)" --entitlements ... --options runtime` instead of adhoc.
5. Re-test: `bin/lume.app/Contents/MacOS/lume serve`, then `POST /lume/vms/pete/run` should actually transition pete to running.

### Workaround until then
`startSplite` keeps using the `lume run` subprocess path (which calls the entitled upstream binary). Pause/resume routes exist but return "Virtual machine not running" — the SharedVM cache is empty because the VM was never started by lume serve. Hot tier is documented as "not yet wired" in `state-tiers.md`.

### What's unblocked in parallel
- Activity-detection (A.1.3.d) — pure splited-side, no entitlement needed.
- R2 sync (A.2) — file uploads, no VZ.
- Egress enforcement (A.3) — pfctl on the host, no VZ. **(See A.3 design proposal below — needs decision before code lands.)**
- Retention (A.4) — file pruning.
- Warm-tier patch (A.1.3.e.2) — would also need the same entitlement to actually work, but we can write the patch and merge it; live testing waits for the cert.

---

## A.3 egress enforcement — design needs Pete's call

**Date raised:** 2026-05-06
**Phase:** A.3

`POST /v1/splites/{n}/policy/network` already persists rules. Making `enforced: true` honest needs decisions on (1) privilege model (root vs. helper vs. daemon), (2) DNS strategy (host resolver vs. pf-only), (3) policy expressiveness, (4) UX.

Full proposal with recommendations: [`docs/proposals/A.3-egress-enforcement.md`](proposals/A.3-egress-enforcement.md).

**Pete's input requested before A.3 code starts.** Until then A.3 stays stubbed (current state: rules persist, but `enforced: false` on the wire). Other phase A work is unblocked.
