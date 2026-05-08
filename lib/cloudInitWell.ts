// Compose a per-well cloud-init user-data document. The static template
// at templates/cloud-init-well.yaml is identity-stripped; this helper
// appends the host's authorized ssh key so `well exec` works once the
// guest is up.

export function composeWellUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
): string {
  const keys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  return (
    templateYaml +
    `\n# Per-well additions (composed at create time)\nssh_authorized_keys:\n${keys}\n`
  );
}
