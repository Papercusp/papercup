// caesar.mjs — self-contained Caesar cipher module
// encode(text, shift): shift each a-z / A-Z letter forward by `shift` positions.
// decode(text, shift): reverse the shift (equivalent to encode with -shift).
// Non-letter characters are passed through untouched.
// `shift` is normalized mod 26 so negative and large values work correctly.
// Throws TypeError when shift is not an integer.

/**
 * Normalize shift to [0, 25] range, supporting negative and large values.
 * @param {number} shift
 * @returns {number}
 */
function normalizeShift(shift) {
  if (!Number.isInteger(shift)) {
    throw new TypeError(`shift must be an integer, got: ${JSON.stringify(shift)}`);
  }
  return ((shift % 26) + 26) % 26;
}

/**
 * Shift a single character by `shift` positions (0-25, already normalized).
 * @param {string} char  single character
 * @param {number} shift  already-normalized 0-25
 * @returns {string}
 */
function shiftChar(char, shift) {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) {
    // A-Z
    return String.fromCharCode(((code - 65 + shift) % 26) + 65);
  }
  if (code >= 97 && code <= 122) {
    // a-z
    return String.fromCharCode(((code - 97 + shift) % 26) + 97);
  }
  return char;
}

/**
 * Encode `text` with a Caesar cipher shift.
 * @param {string} text
 * @param {number} shift  integer (negative and > 26 are normalised mod 26)
 * @returns {string}
 */
export function encode(text, shift) {
  const s = normalizeShift(shift);
  return [...text].map((c) => shiftChar(c, s)).join('');
}

/**
 * Decode `text` that was encoded with the given shift.
 * @param {string} text
 * @param {number} shift  integer (negative and > 26 are normalised mod 26)
 * @returns {string}
 */
export function decode(text, shift) {
  // Decoding is encoding with the inverse shift.
  return encode(text, -shift);
}
