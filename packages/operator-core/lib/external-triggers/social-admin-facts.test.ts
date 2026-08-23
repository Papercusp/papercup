/**
 * `socialAdminFacts` unit tests, focused on the write-only platform case (P-021).
 *
 * The function is pure and exported "for direct testing", but until now was
 * only exercised through the admin snapshot integration test — which needs a
 * database and therefore did not run on the fast lane. The behaviour under test
 * here is a UI-correctness rule that has already been got wrong once at a lower
 * level (D-050), so it is worth pinning where it is cheap to run.
 */
import { describe, expect, it } from 'vitest';
import { socialAdminFacts } from './admin';
import { getSocialPlatform } from './social/platform-registry';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');

describe('socialAdminFacts', () => {
  it('returns null for a kind the registry does not know', () => {
    // The pane's correctness rests on this: a gmail or slack source must never
    // pick up a social platform's rate budget by accident.
    expect(socialAdminFacts('gmail', {}, NOW)).toBeNull();
    expect(socialAdminFacts('slack', {}, NOW)).toBeNull();
  });

  describe('a write-only platform (linkedin)', () => {
    it('reports the cursor as not-readable rather than never-synced', () => {
      // THE D-050 rule applied one level up. LinkedIn will NEVER reconcile,
      // because no content read scope is available to us at any tier — so
      // `never-synced` would be permanently true, permanently alarming on the
      // owner's pane, and not actionable by anyone. The two states look
      // identical to a reader and mean opposite things: "nobody has run this
      // yet" versus "this can never run".
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts).not.toBeNull();
      expect(facts!.cursor.state).toBe('not-readable');
      expect(facts!.cursor.at).toBeNull();
      expect(facts!.cursor.ageMs).toBeNull();
      expect(facts!.cursor.detail).toMatch(/write-only/i);
    });

    it('reports a null readTransport, distinct from an unknown one', () => {
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.readTransport).toBeNull();
    });

    it('stays not-readable even when a cursor somehow got persisted', () => {
      // Defensive, and not hypothetical: a source row is created with `{}` and
      // could be written by a future code path before anyone notices the
      // platform cannot be read. The PLATFORM fact must win over the row's
      // contents, or the pane would start reporting sync health for a stream
      // that does not exist.
      const facts = socialAdminFacts('linkedin', { watermark: '2026-08-23T11:00:00.000Z' }, NOW);
      expect(facts!.cursor.state).toBe('not-readable');
    });

    it('still reports the write half, which is the half that works', () => {
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.writeVerified).toBe(true);
      expect(facts!.writeVerbs).toEqual(['post', 'delete']);
      // Reply is absent — the platform limitation, surfaced to the owner.
      expect(facts!.writeVerbs).not.toContain('reply');
    });

    it('surfaces the owner-facing wall', () => {
      const facts = socialAdminFacts('linkedin', {}, NOW);
      expect(facts!.blockedOn).toBeTruthy();
      // The recurring 60-day re-authorisation is the operational surprise most
      // worth showing an owner, so it must reach the pane rather than living
      // only in a code comment.
      expect(facts!.blockedOn).toMatch(/60-day|re-authorisation/i);
    });
  });

  describe('a readable platform still behaves as before', () => {
    it('reports never-synced for a cold readable source', () => {
      // The control for the write-only case above: if this ALSO returned
      // not-readable, the new branch would be swallowing every platform and the
      // assertions above would pass for the wrong reason.
      const facts = socialAdminFacts('reddit', {}, NOW);
      expect(facts).not.toBeNull();
      expect(facts!.cursor.state).toBe('never-synced');
      expect(facts!.readTransport).toBe('poll-cursor');
    });

    it('reports position-only for a reddit cursor carrying no instant', () => {
      // D-050's original case, kept here so the new branch cannot regress it.
      const facts = socialAdminFacts('reddit', { newestFullname: 't3_abc' }, NOW);
      expect(facts!.cursor.state).toBe('position-only');
    });
  });

  it('keeps the registry as the single source of the read/write split', () => {
    // Guards against the two facts drifting apart in different files: the pane
    // must report exactly what the row declares.
    const row = getSocialPlatform('linkedin')!;
    expect(row.read).toBeNull();
    const facts = socialAdminFacts('linkedin', {}, NOW);
    expect(facts!.writeVerbs).toEqual(row.write.verbs);
  });
});
