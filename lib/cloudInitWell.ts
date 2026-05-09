// Compose a per-well cloud-init user-data document. The static template
// at templates/cloud-init-well.yaml is identity-stripped; this helper
// appends the dynamic per-well bits:
//   1. Top-level `ssh_authorized_keys` so the default `ubuntu` user is
//      reachable for debug/fallback.
//   2. A `write_files` entry that drops the same keys at
//      /etc/well-authorized-keys for the template's runcmd to consume
//      when it creates the well user.
//   3. Optional `write_files` append into /etc/environment so caller-
//      supplied env vars (e.g. CELLS_PROXY_SECRET) are present on the
//      well from first boot. PAM loads /etc/environment on every
//      session, including SSH non-login.
//
// The actual well-user creation lives in the template's runcmd.
// We can't put it here because YAML doesn't merge two top-level
// `runcmd:` blocks — cloud-init takes the last one and drops the rest.

export function composeWellUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
  env?: Record<string, string>,
): string {
  const ubuntuKeys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  const indentedKeys = sshAuthorizedKeys
    .map((k) => `      ${k}`)
    .join("\n");

  const writeFiles: string[] = [
    `  - path: /etc/well-authorized-keys
    permissions: '0644'
    owner: root:root
    content: |
${indentedKeys}`,
    // The deterministic-netplan-via-write_files approach was tried in
    // ef82895 / ca364ab and removed: my live-verify caught that the
    // first DHCP grant fires BEFORE cloud-init can rewrite the file
    // — the lease lands under the source-image's identity, and the
    // dhcp-identifier:mac swap doesn't take effect until a renewal
    // (~30min later by default). Net effect was: same race, plus a
    // brittle hand-written netplan that systemd-networkd may not
    // accept on every Ubuntu release. The right fix lives lower in
    // the stack — either tracking lease via DUID prefix bytes, or a
    // welld-owned DHCP layer. Until then, cidata's network-config
    // block is the path; old saves (rinsed) get rejected up front.
  ];

  if (env && Object.keys(env).length > 0) {
    const envBlock = Object.entries(env)
      .map(([k, v]) => `      ${k}=${quoteEnvValue(v)}`)
      .join("\n");
    writeFiles.push(
      `  - path: /etc/environment
    append: true
    permissions: '0644'
    owner: root:root
    content: |
${envBlock}`,
    );
  }

  return (
    templateYaml +
    `
# Per-well dynamic additions (composed at create time)
ssh_authorized_keys:
${ubuntuKeys}

write_files:
${writeFiles.join("\n")}
`
  );
}

// /etc/environment quoting: each line is KEY=VALUE; PAM doesn't
// interpret shell metacharacters but does honor quotes around values
// with spaces. We always wrap in double quotes and escape internal
// double quotes + backslashes. Newlines aren't allowed at all.
function quoteEnvValue(value: string): string {
  if (value.includes("\n")) {
    throw new Error("env values cannot contain newlines");
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
