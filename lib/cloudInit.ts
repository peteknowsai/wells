// Helpers for composing cloud-init user-data from the static template plus
// per-build (and later per-well) additions.

// B.0.9.d.4: bake well-firstboot files into the base image via cloud-
// init's write_files. After the bake completes, runcmd in
// cloud-init-base.yaml runs `systemctl enable well-firstboot.service`
// then apt-purges cloud-init — the saved disk has our identity-
// injection mechanism instead. Per-well forks rely on this, not on
// cloud-init.
//
// Indents the file content so it sits inside YAML's block-literal scalar
// (`|` mode) properly. Each line gets prefixed with the YAML indent.
function indentBlock(content: string, indent: string): string {
  return content
    .split("\n")
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join("\n");
}

export interface FirstbootArtifacts {
  // Contents of well-firstboot.sh (the bash script).
  shellScript: string;
  // Contents of well-firstboot.service (the systemd unit).
  serviceUnit: string;
}

export function composeBaseUserData(
  templateYaml: string,
  sshAuthorizedKeys: string[],
  firstboot?: FirstbootArtifacts,
): string {
  const keys = sshAuthorizedKeys.map((k) => `  - ${k}`).join("\n");
  // YAML write_files block-literal: 6-space indent (4 inside the list
  // item + 2 inside the `content: |` scalar). Only emit if caller
  // supplies firstboot artifacts — older code paths (and tests) that
  // don't pass them get the unchanged base template.
  const writeFiles = firstboot
    ? `
# B.0.9.d.4: install well-firstboot artifacts. cloud-init runs once at
# bake time, places them, runcmd enables + purges cloud-init at end.
write_files:
  - path: /usr/local/sbin/well-firstboot
    permissions: '0755'
    owner: root:root
    content: |
${indentBlock(firstboot.shellScript, "      ")}
  - path: /etc/systemd/system/well-firstboot.service
    permissions: '0644'
    owner: root:root
    content: |
${indentBlock(firstboot.serviceUnit, "      ")}
`
    : "";
  return (
    templateYaml +
    writeFiles +
    `\n# Build-time additions (composed)\nssh_authorized_keys:\n${keys}\n`
  );
}
