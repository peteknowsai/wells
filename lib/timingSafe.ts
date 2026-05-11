// Constant-time string compare for security-sensitive tokens. Defeats
// timing attacks where an attacker could otherwise probe a secret byte-
// by-byte by measuring how long the comparison takes to fail.
//
// Always inspects every byte of `a` before returning. Length mismatch
// returns false immediately — leaking the length is acceptable in our
// threat model (tokens are fixed-shape `randomBytes(32).toString("hex")`,
// always 64 chars) and avoids a much slower equality check.

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
