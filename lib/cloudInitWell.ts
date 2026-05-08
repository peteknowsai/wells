// Compose a per-well cloud-init user-data document. The static template
// at templates/cloud-init-well.yaml is identity-stripped; this helper
// appends the dynamic per-well bits:
//   1. Top-level `ssh_authorized_keys` so the default `ubuntu` user is
//      reachable for debug/fallback.
//   2. A `write_files` entry that drops the same keys at
//      /etc/sprite-authorized-keys for the template's runcmd to consume
//      when it creates the sprite user.
//   3. Optional `write_files` append into /etc/environment so caller-
//      supplied env vars (e.g. CELLS_PROXY_SECRET) are present on the
//      well from first boot. PAM loads /etc/environment on every
//      session, including SSH non-login.
//
// The actual sprite-user creation lives in the template's runcmd.
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
    `  - path: /etc/sprite-authorized-keys
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
