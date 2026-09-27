/**
 * WI-1194246 — the backup↔migration rendezvous must be unbounded in BOTH timeout
 * dimensions. See `rendezvous-unbounded-timeouts.ts` for the measurement behind it.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the doc-claims siblings state:
 * once the live assertion goes green it stops being evidence that the detector works
 * at all. Control #1 reproduces the EXACT pre-fix shape of both real files —
 * `lock_timeout = 0` alone — which is the half opt-out this claim exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeRendezvousTimeouts, stripCommentsForClaim } from './rendezvous-unbounded-timeouts';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// WI-10003357: db-boot-migrate no longer BLOCKS on the rendezvous — it polls
// pg_try_advisory_lock and re-proves relation safety each iteration, so it has
// zero blocking acquisitions and is pinned by its own assertion below.
const BOOT_MIGRATE_SITE = 'packages/operator-core/lib/db-boot-migrate.ts';

const RENDEZVOUS_SITES = [
  'packages/operator-core/lib/backup/configure.ts',
  'packages/operator-core/lib/agent-tools/db/migrate.ts',
] as const;

describe('WI-1194246 rendezvous-unbounded-timeouts claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the real pre-fix shape: lock_timeout reset alone', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SET lock_timeout = 0\`;
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.acquisitions).toBe(1);
      expect(verdict.unguarded[0].missing).toEqual(['statement_timeout']);
      expect(verdict.violations.join('\n')).toMatch(/statement_timeout/);
    });

    it('catches statement_timeout reset alone (the mirror half opt-out)', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SET statement_timeout = 0\`;
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.unguarded[0].missing).toEqual(['lock_timeout']);
    });

    it('catches an acquisition with no opt-out at all', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.unguarded[0].missing).toEqual(['lock_timeout', 'statement_timeout']);
    });

    it('is NOT satisfied by a comment that merely mentions the reset', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SET lock_timeout = 0\`;
        // we should also SET statement_timeout = 0 here one day
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(false);
      expect(verdict.unguarded[0].missing).toEqual(['statement_timeout']);
    });

    it('accepts both resets', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SET lock_timeout = 0\`;
        await client\`SET statement_timeout = 0\`;
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(true);
      expect(verdict.acquisitions).toBe(1);
    });

    it('accepts PostgreSQL string-literal zero resets', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SET lock_timeout = '0'\`;
        await client\`SET statement_timeout = "0"\`;
        await client\`SELECT pg_advisory_lock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(true);
      expect(verdict.acquisitions).toBe(1);
    });

    it('does not require an opt-out for a RELEASE', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SELECT pg_advisory_unlock(hashtext(\${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))\`;
      `);
      expect(verdict.ok).toBe(true);
      expect(verdict.acquisitions).toBe(0);
    });

    it('ignores an unrelated advisory lock on a different key', () => {
      const verdict = judgeRendezvousTimeouts(`
        await client\`SELECT pg_advisory_lock(hashtext(\${SOME_OTHER_KEY}))\`;
      `);
      expect(verdict.acquisitions).toBe(0);
      expect(verdict.ok).toBe(true);
    });

    it('stripCommentsForClaim preserves line numbering', () => {
      const stripped = stripCommentsForClaim('a\n/* x\ny */\nb');
      expect(stripped.split('\n')).toHaveLength(4);
    });
  });

  describe('live sources', () => {
    it(`${BOOT_MIGRATE_SITE} polls the rendezvous instead of blocking on it`, () => {
      const source = readFileSync(join(ROOT, BOOT_MIGRATE_SITE), 'utf8');
      const verdict = judgeRendezvousTimeouts(source);
      // A blocking acquisition re-added here must reset both timeouts; the
      // poll itself needs no opt-out because pg_try_advisory_lock never waits.
      expect(verdict.violations).toEqual([]);
      expect(verdict.acquisitions).toBe(0);
      expect(stripCommentsForClaim(source)).toMatch(
        /pg_try_advisory_lock\(hashtext\(\$\{BACKUP_MIGRATION_ADVISORY_LOCK_KEY\}\)\)/,
      );
    });

    it.each(RENDEZVOUS_SITES)('%s resets BOTH timeouts before acquiring', (rel) => {
      const verdict = judgeRendezvousTimeouts(readFileSync(join(ROOT, rel), 'utf8'));
      expect(verdict.acquisitions).toBeGreaterThan(0);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });
});
