// Compose a per-well cloud-init user-data document. The static template
// at templates/cloud-init-well.yaml is identity-stripped; this helper
// appends the dynamic per-well bits:
//   1. Top-level `ssh_authorized_keys` so the default `ubuntu` user is
//      reachable for debug/fallback.
//   2. A `write_files` entry that drops the same keys at
//      /etc/sprite-authorized-keys for the template's runcmd to consume
//      when it creates the sprite user.
//
// The actual sprite-user creation lives in the template's runcmd.
// We can't put it here because YAML doesn't merge two top-level
// `runcmd:` blocks — cloud-init takes the last one and drops the rest.

export function composeWellUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
): string {
  const ubuntuKeys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  const indentedKeys = sshAuthorizedKeys
    .map((k) => `      ${k}`)
    .join("\n");

  return (
    templateYaml +
    `
# Per-well dynamic additions (composed at create time)
ssh_authorized_keys:
${ubuntuKeys}

write_files:
  - path: /etc/sprite-authorized-keys
    permissions: '0644'
    owner: root:root
    content: |
${indentedKeys}
`
  );
}
