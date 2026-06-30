// Dummy demo: Roman numeral conversion (plan dummy-fleet-roman-numerals-2026-06-30).
// Pure ESM, no deps. Standard subtractive notation, valid range 1..3999.

const NUMERALS = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

const VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

/**
 * Convert an integer (1..3999) to its standard subtractive Roman numeral.
 * @param {number} n
 * @returns {string}
 * @throws {RangeError} for non-integers or values outside 1..3999.
 */
export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) {
    throw new RangeError(`toRoman: expected an integer in 1..3999, got ${n}`);
  }
  let remaining = n;
  let out = '';
  for (const [value, symbol] of NUMERALS) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

/**
 * Parse a Roman numeral back to its integer value. Case-insensitive.
 * Rejects non-canonical input (e.g. "IIII") by requiring it to round-trip
 * exactly through toRoman.
 * @param {string} s
 * @returns {number}
 * @throws {TypeError} for non-string / empty input.
 * @throws {Error} for invalid characters or non-canonical numerals.
 */
export function fromRoman(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new TypeError(`fromRoman: expected a non-empty string, got ${s}`);
  }
  const upper = s.toUpperCase();
  if (!/^[MDCLXVI]+$/.test(upper)) {
    throw new Error(`fromRoman: invalid Roman numeral "${s}"`);
  }
  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const cur = VALUES[upper[i]];
    const next = VALUES[upper[i + 1]];
    if (next !== undefined && cur < next) total -= cur;
    else total += cur;
  }
  // Canonicality + range check: the only valid spelling is toRoman's output.
  if (total < 1 || total > 3999 || toRoman(total) !== upper) {
    throw new Error(`fromRoman: non-canonical Roman numeral "${s}"`);
  }
  return total;
}
