/**
 * K-1 (shared-hive-release-testing Brief K) — Hive-scope revocation is a no-op
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
 * Same proven static-source idiom as
 * `sync/hyperbee/visibility-content-topic-separation.test.ts`'s
 * "E-001 (static): the public→private flip has NO federation-cutoff leg": a source
 * assertion that the lever does NOT reach for the substrate. When the P-004 wiring
 * lands (live-revoke + peer-log federation — the real fix), one of the cutoff/federate
 * tokens appears in `realPublishRevocation` and this flips RED: the signal the gap closed.
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

describe('K-1 (static): Hive-scope revoke is PG-write-only — no live-revoke, no federation', () => {
  it('locates the default realPublishRevocation seam', () => {
    expect(from).toBeGreaterThan(-1);
  });

  it('writes the revoked set to PG (addRevokedHivePubkeys) — the local effect', () => {
    expect(/addRevokedHivePubkeys\s*\(/.test(realPublishCode)).toBe(true);
  });

  it('reports live:false — it does NOT apply the revoke on a booted handle', () => {
    // The hardcoded `return { live: false }` is the no-op marker. A real fix that
    // live-revokes computes `live` (e.g. after `h.revoke`) and this literal disappears.
    expect(/return\s*\{\s*live:\s*false\s*\}/.test(realPublishCode)).toBe(true);
  });

  it('references NO live-revoke or peer-log federation leg (no h.revoke / publishContributorRow / booted-handle publish)', () => {
    // Contrast sync/hyperbee/revoke-contributor.ts (harness scope), whose
    // realPublishRevocation DOES call `await h.revoke(pk)` + `publishContributorRow`.
    // When P-004 wires the Hive-scope live-revoke + peer-log publish (closing K-1/K-2),
    // one of these CODE tokens appears here and this assertion flips RED.
    const federateOrLiveRevokeLeg =
      /\.revoke\s*\(|publishContributorRow\s*\(|publishHiveContributorRow\s*\(|getBootedHive\w*\s*\(|\bh\.revoke\b/;
    expect(federateOrLiveRevokeLeg.test(realPublishCode)).toBe(false);
  });
});
