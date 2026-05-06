// Single-quote shell-escape. Used wherever we forward an argv to ssh —
// openssh joins post-host args with spaces and re-parses on the remote
// side, so any metacharacter (`;`, pipes, `$`, quotes, spaces) needs to
// be quoted before it reaches the wire.
//
// Pattern: pass through safe-by-default chars (alnum + a few safe
// punctuation), single-quote everything else with the standard `'\''`
// trick for embedded single quotes.

export function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_/.@:=+-]+$/.test(s) && s.length > 0) return s;
  return "'" + s.replaceAll("'", "'\\''") + "'";
}
