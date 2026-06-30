// Self-contained RFC 4648 Base64 codec — pure ESM, no deps, no Buffer.
//
// encode(str): UTF-8 string -> standard Base64 string (alphabet A-Z a-z 0-9 + /,
//   '=' padding). Handles empty string, ASCII, and multibyte UTF-8.
// decode(b64): standard Base64 string -> original UTF-8 string. Throws RangeError
//   on malformed input (out-of-alphabet chars, bad length, misplaced/excess padding).
//
// Invariant: decode(encode(x)) === x for every string x.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// charCode -> 6-bit value, or -1 for any byte not in the alphabet.
const LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Encode a JS string to standard Base64 (its UTF-8 byte representation).
 * @param {string} input
 * @returns {string}
 */
export function encode(input) {
  if (typeof input !== 'string') {
    throw new TypeError('encode expects a string');
  }
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b0 = bytes[i];
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triple >> 18) & 0x3f];
    out += ALPHABET[(triple >> 12) & 0x3f];
    out += has1 ? ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += has2 ? ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

/**
 * Decode a standard Base64 string back to the original UTF-8 string.
 * @param {string} input
 * @returns {string}
 * @throws {RangeError} on malformed Base64 input.
 */
export function decode(input) {
  if (typeof input !== 'string') {
    throw new TypeError('decode expects a string');
  }
  if (input.length % 4 !== 0) {
    throw new RangeError('invalid base64: length must be a multiple of 4');
  }
  if (input.length === 0) {
    return '';
  }

  // Padding rules: '=' may only appear as a contiguous run at the very end,
  // at most 2 chars, and only within the final 4-char group.
  const padIndex = input.indexOf('=');
  if (padIndex !== -1) {
    for (let i = padIndex; i < input.length; i++) {
      if (input[i] !== '=') {
        throw new RangeError('invalid base64: misplaced padding');
      }
    }
    const padCount = input.length - padIndex;
    if (padCount > 2) {
      throw new RangeError('invalid base64: too much padding');
    }
  }

  const out = [];
  for (let i = 0; i < input.length; i += 4) {
    const pad2 = input[i + 2] === '=';
    const pad3 = input[i + 3] === '=';
    const e0 = LOOKUP[input.charCodeAt(i)];
    const e1 = LOOKUP[input.charCodeAt(i + 1)];
    const e2 = pad2 ? 0 : LOOKUP[input.charCodeAt(i + 2)];
    const e3 = pad3 ? 0 : LOOKUP[input.charCodeAt(i + 3)];
    if (e0 === -1 || e1 === -1 || e2 === -1 || e3 === -1) {
      throw new RangeError('invalid base64: character outside alphabet');
    }
    const triple = (e0 << 18) | (e1 << 12) | (e2 << 6) | e3;
    out.push((triple >> 16) & 0xff);
    if (!pad2) out.push((triple >> 8) & 0xff);
    if (!pad3) out.push(triple & 0xff);
  }

  // fatal:true => malformed UTF-8 byte sequences throw rather than emit U+FFFD.
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(out));
}
