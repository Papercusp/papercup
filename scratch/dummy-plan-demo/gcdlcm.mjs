/**
 * gcd(a, b) — Greatest Common Divisor via Euclid's algorithm.
 * Handles negative inputs via Math.abs.
 */
export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * lcm(a, b) — Least Common Multiple.
 * Returns 0 if either argument is 0.
 */
export function lcm(a, b) {
  if (a === 0 || b === 0) return 0;
  return Math.abs(a * b) / gcd(a, b);
}
