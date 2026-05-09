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
    // Always emit a fresh /etc/netplan/50-cloud-init.yaml via user-data,
    // not via cidata's network-config block. cloud-init does not reapply
    // network-config on instance-id change for already-configured saved
    // images — forks from cell-base (or any image where cells's old
    // `clean:true` rinse wiped /var/lib/cloud/) inherited a broken
    // /etc/netplan/ and never got DHCP. Writing the file ourselves +
    // `netplan apply` in runcmd is the deterministic path that's
    // independent of cloud-init's reapply heuristics. See cells-team
    // punchlist 2026-05-08.
    `  - path: /etc/netplan/50-cloud-init.yaml
    permissions: '0600'
    owner: root:root
    content: |
      network:
        version: 2
        ethernets:
          all:
            match:
              name: "*"
            dhcp4: true`,
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
