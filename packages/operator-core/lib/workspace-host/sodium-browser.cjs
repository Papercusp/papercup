/** Browser backend for the existing Ed25519 Noise XX wire.
 * sodium-javascript supplies the symmetric primitives but omits Ed25519 DH.
 * Reuse the declared noble implementation for that one native-compatible API.
 */
const sodium = require('sodium-javascript');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { abytes, bytesToNumberLE } = require('@noble/curves/utils.js');

function crypto_scalarmult_ed25519_noclamp(out, scalar, publicKey) {
  abytes(out, 32); abytes(scalar, 32); abytes(publicKey, 32);
  // libsodium clears bit 255 even for its unclamped operation.
  const bytes = Uint8Array.from(scalar);
  bytes[31] &= 127;
  const n = ed25519.Point.Fn.create(bytesToNumberLE(bytes));
  const point = ed25519.Point.fromBytes(publicKey, false);
  if (n === 0n || point.isSmallOrder() || !point.isTorsionFree()) {
    throw new Error('Invalid Ed25519 scalar multiplication');
  }
  const result = point.multiply(n);
  if (result.is0()) throw new Error('Invalid Ed25519 scalar multiplication');
  out.set(result.toBytes());
}

module.exports = { ...sodium, crypto_scalarmult_ed25519_BYTES: 32,
  crypto_scalarmult_ed25519_SCALARBYTES: 32, crypto_scalarmult_ed25519_noclamp };
