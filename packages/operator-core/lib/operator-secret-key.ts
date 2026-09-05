/**
 * Decoding secrets out of `harness_shared.operator_secrets`.
 *
 * WHY THIS EXISTS — `Buffer.from(value, 'base64')` NEVER THROWS.
 *
 * Given an empty string, whitespace, a truncated value, or non-base64 garbage it
 * silently returns a SHORTER (often zero-length) buffer instead of failing. Node's
 * `createHmac` then accepts that degenerate key without complaint. Because the
 * signing path and the verifying path both load the SAME degenerate key, every
 * signature still verifies and every probe still reports green — while the actual
 * security property (an unguessable 32-byte secret) is gone.
 *
 * That is the failure mode this module exists to make impossible: not an outage,
 * but a silent downgrade that looks exactly like health. Measured on this tree:
 *
 *   Buffer.from('', 'base64').length                  === 0
 *   Buffer.from('   ', 'base64').length               === 0
 *   Buffer.from('!!!!not base64!!!!', 'base64').length === 6
 *   Buffer.from('AAAA', 'base64').length              === 3
 *
 * ...and `createHmac('sha256', Buffer.alloc(0))` signs happily.
 *
 * The rest of this codebase already asserts 32 bytes when it decodes key material
 * (ed25519 pubkeys, epoch keys, gossip topics, hosted-connector entropy). The
 * `operator_secrets` HMAC holders were the outliers that skipped it; this helper is
 * how they stop being outliers.
 *
 * FAILS LOUD, DOES NOT SELF-HEAL. Re-minting a replacement on read would silently
 * invalidate every live signed spawn URL and power-user token — precisely the blast
 * radius `rotateSpawnSigningKey()` exists to measure and report BEFORE it happens.
 * A corrupt key is an operator decision (restore, or deliberately rotate), so this
 * throws and names both options rather than quietly choosing one.
 */

/** Every `operator_secrets` HMAC key on this path is 32 random bytes. */
export const OPERATOR_SECRET_KEY_BYTES = 32;

/**
 * Greppable marker leading every corruption failure, so the cause is searchable
 * from a log line alone rather than inferred from a downstream signature error.
 */
export const OPERATOR_SECRET_KEY_CORRUPT = 'OPERATOR_SECRET_KEY_CORRUPT';

/**
 * Decode a base64 secret and assert it is exactly the size it was minted at.
 *
 * @param valueB64     the stored `operator_secrets.value_b64`
 * @param keyName      the row's `name`, echoed into the error so the failure names
 *                     WHICH secret is corrupt without a second lookup
 * @param expectedBytes defaults to {@link OPERATOR_SECRET_KEY_BYTES}
 * @throws if the value is absent, undecodable, or decodes to the wrong size
 */
export function decodeOperatorSecretKey(
  valueB64: string | null | undefined,
  keyName: string,
  expectedBytes: number = OPERATOR_SECRET_KEY_BYTES,
): Buffer {
  if (typeof valueB64 !== 'string' || valueB64.length === 0) {
    throw new Error(
      `${OPERATOR_SECRET_KEY_CORRUPT}: operator_secrets row '${keyName}' has an empty or missing ` +
        `value_b64. Buffer.from() would have silently produced a 0-byte key that still signs and ` +
        `verifies, so this fails instead. Restore the row from backup, or rotate the key ` +
        `deliberately (which invalidates live spawns/tokens — see rotateSpawnSigningKey()).`,
    );
  }

  const buf = Buffer.from(valueB64, 'base64');

  if (buf.length !== expectedBytes) {
    throw new Error(
      `${OPERATOR_SECRET_KEY_CORRUPT}: operator_secrets row '${keyName}' decoded to ${buf.length} ` +
        `byte(s), expected ${expectedBytes}. base64 decoding does not throw on corrupt input — it ` +
        `truncates — so this row would otherwise have yielded a short, guessable key that signs and ` +
        `verifies normally. Restore the row from backup, or rotate the key deliberately ` +
        `(which invalidates live spawns/tokens — see rotateSpawnSigningKey()).`,
    );
  }

  return buf;
}
