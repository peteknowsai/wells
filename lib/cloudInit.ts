// Helpers for composing cloud-init user-data from the static template plus
// per-build (and later per-splite) additions.

export function composeBaseUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
): string {
  const keys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  return (
    templateYaml +
    `\n# Build-time additions (composed)\nssh_authorized_keys:\n${keys}\n`
  );
}
