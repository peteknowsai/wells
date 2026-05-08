// Compose a per-well cloud-init user-data document. The static template
// at templates/cloud-init-well.yaml is identity-stripped; this helper
// appends:
//   1. Top-level `ssh_authorized_keys` so the default `ubuntu` user is
//      reachable for debug/fallback.
//   2. A `users:` block that creates a `sprite` user with the same keys
//      and `HOME=/home/sprite`. This is the user cells's birth flow
//      targets — its DNA push, its bashrc.d drops, and its
//      register-site-service.sh all hardcode `/home/sprite/...`. By
//      shipping wells with a `sprite` user that mirrors sprites's
//      shape, cells's existing flow runs unchanged.

export function composeWellUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
): string {
  const ubuntuKeys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  const spriteKeys = sshAuthorizedKeys.map((k) => `      - ${k}`).join("\n");
  return (
    templateYaml +
    `
# Per-well additions (composed at create time)
ssh_authorized_keys:
${ubuntuKeys}

# Sprites-parity user. Cells's birth flow expects /home/sprite/agent,
# /home/sprite/.bashrc.d/, etc. so we provision a sprite user alongside
# the cloud image's default ubuntu user. Same SSH keys; same sudo grant.
users:
  - default
  - name: sprite
    gecos: Sprites parity user
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: [sudo]
    homedir: /home/sprite
    ssh_authorized_keys:
${spriteKeys}
`
  );
}
