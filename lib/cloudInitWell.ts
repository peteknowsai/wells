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
  pinnedIp?: string,
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

  if (pinnedIp) {
    // Drop a HIGHER-priority netplan file alongside cloud-init's own
    // 50-cloud-init.yaml. Netplan reads /etc/netplan/*.yaml in lexical
    // order and the last config to define a key wins, so 99-wells-
    // pinned.yaml's static settings override the base image's DHCP
    // config without us having to overwrite cloud-init's managed file.
    //
    // Why not write_files /etc/netplan/50-cloud-init.yaml: cloud-init's
    // network module rewrites that file from cidata's network-config
    // during local-init (before user-data is parsed), so a write_files
    // entry on the same path either races or gets clobbered. A separate
    // file at 99- guarantees ours lives outside that loop.
    //
    // 'addresses:' adds to whatever else is configured, which is fine —
    // the cell ends up with both the DHCP-assigned IP (briefly) and
    // the pinned one until the runcmd's `netplan apply` rebuilds.
    writeFiles.push(
      `  - path: /etc/netplan/99-wells-pinned.yaml
    permissions: '0600'
    owner: root:root
    content: |
      network:
        version: 2
        ethernets:
          all:
            match:
              name: "*"
            dhcp4: false
            addresses:
              - ${pinnedIp}/24
            routes:
              - to: default
                via: 192.168.64.1
            nameservers:
              addresses:
                - 1.1.1.1
                - 1.0.0.1`,
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
