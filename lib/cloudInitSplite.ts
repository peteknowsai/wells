// Compose a per-splite cloud-init user-data document. The static template
// at templates/cloud-init-splite.yaml is identity-stripped; this helper
// appends the host's authorized ssh key so `splite exec` works once the
// guest is up.

export function composeSpliteUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
): string {
  const keys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  return (
    templateYaml +
    `\n# Per-splite additions (composed at create time)\nssh_authorized_keys:\n${keys}\n`
  );
}
