/**
 * K-1 (shared-pot-release-testing Brief K) — Hive-scope revocation is a no-op
 * beyond a local PG write.
 *
 * `revokeHiveContributor`'s default `realPublishRevocation` ONLY calls
 * `addRevokedHivePubkeys` (a PG UPDATE of the owner's own row) and returns
 * `{ live: false }`. It does NOT live-revoke on the booted handle (no `h.revoke`)
 * and does NOT federate the revocation to peers — the comment in the source says the
 * peer-log publish "is wired by the P-004 substrate re-key", i.e. not wired yet.
 *
 * WITNESSED LIVE (findings-K.md): a genuine `revokeHiveContributor` of a member's real
 * device key returned `live:false`, the revoked set never reached the joiner, and the
 * removed member kept reading new owner content (C-001). The integration-layer read
 * guard lives in `sync/hyperbee/__tests__/federation-threat-model.test.ts`
 * ("C-001 — revocation is write-plane only"); THIS file guards the narrower K-1
 * invariant so the no-op-beyond-PG behavior can't silently change.
 *
 * UPDATE (P-004 landed, su-ee7e9 2026-06-19): the gap is CLOSED. `realPublishRevocation`
 * now wires the substrate re-key (`advanceEpochOnHiveBoundary`, flag-gated by
 * `isHiveRekeyEnabled`) — member-remove advances the epoch + distributes the new key to
 * the REMAINING members = the C-001 read cut. This test FLIPPED from "asserts the gap
 * exists" to "asserts the re-key stays wired": a regression guard, so the read cut can't
 * silently be removed from the revoke path. (The cut activates only with the flag on; the
 * wiring is present regardless.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), './hive-revoke-contributor.ts'),
  'utf8',
);

// Scope to the default publish seam's body: from `function realPublishRevocation(`
// to end of file (it is the last function in the module).
const from = src.indexOf('async function realPublishRevocation(');
const realPublish = from > -1 ? src.slice(from) : '';

// Strip line comments so an explanatory comment ("...peer-log publish...wired by P-004")
// can never satisfy a leg assertion — only real CODE tokens count.
const realPublishCode = realPublish.replace(/\/\/[^\n]*/g, '');

describe('K-1 (static): Hive-scope revoke NOW wires the P-004 re-key (the gap is CLOSED)', () => {
  it('locates the default realPublishRevocation seam', () => {
    expect(from).toBeGreaterThan(-1);
  });

  it('still writes the revoked set to PG (addRevokedHivePubkeys) — the write-plane effect', () => {
    expect(/addRevokedHivePubkeys\s*\(/.test(realPublishCode)).toBe(true);
  });

  it('wires the P-004 re-key on revoke (advanceEpochOnHiveBoundary, gated by isHiveRekeyEnabled)', () => {
    // The C-001 fix: member-remove advances the hive epoch + distributes the new key to the
    // REMAINING members (cutOff = the revoked pubkeys) so the removed peer can't decrypt
    // post-boundary content. If this regresses out of the revoke path, the read cut
    // silently stops working — the assertion that guards it.
    expect(/advanceEpochOnHiveBoundary\s*\(/.test(realPublishCode)).toBe(true);
    expect(/isHiveRekeyEnabled\s*\(/.test(realPublishCode)).toBe(true);
  });

  it('computes `live` from the re-key (no hardcoded live:false no-op marker)', () => {
    // Was `return { live: false }` (the K-1 no-op). Now `return { live: applied }` — the
    // removal is live (a read cut) exactly when the flag is on + the re-key distributed.
    expect(/return\s*\{\s*live:\s*applied\s*\}/.test(realPublishCode)).toBe(true);
    expect(/return\s*\{\s*live:\s*false\s*\}/.test(realPublishCode)).toBe(false);
  });
});
