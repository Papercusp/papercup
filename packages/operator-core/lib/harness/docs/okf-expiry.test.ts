/**
 * OKF `stale_after` expiry scan (okf-frontmatter-adoption-2026-08-08 P-005).
 *
 * Every expiry here comes from a SYNTHETIC date written into a temp-dir fixture
 * and judged against an injected `now`. Nothing reads or writes the real corpus:
 * plan D-002 forbids fabricating `stale_after` on a real doc, and the live corpus
 * is deliberately 0/659 + 0/70 on that field — so "the scan reports nothing today"
 * is the CORRECT behaviour, asserted below rather than papered over.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildOkfExpiryDigest,
  claimDailyExpiryScan,
  scanExpiredDocs,
  utcDayKey,
  __resetDailyExpiryScanGate,
  type OkfExpiryScan,
} from './okf-expiry';

const NOW = new Date('2026-08-08T12:00:00Z');

let root: string;

async function write(rel: string, body: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-expiry-'));
  // The corpus's CURRENT shape: OKF type + generated, no stale_after at all.
  await write('typical.mdx', '---\ntitle: T\ntype: Insight\ngenerated:\n  by: agent\n---\n\nbody\n');
  await write('no-frontmatter.md', '# Nothing\n\nbody\n');
  await write('future.mdx', '---\ntitle: F\nstale_after: 2027-01-01\n---\n\nbody\n');
  await write('nested/expired.mdx', '---\ntitle: E\nstale_after: 2026-01-01\n---\n\nbody\n');
  await write('boundary.mdx', '---\ntitle: B\nstale_after: 2026-08-08\n---\n\nbody\n');
  await write('broken.mdx', "---\ntitle: X\nstale_after: 'next tuesday'\n---\n\nbody\n");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scanExpiredDocs', () => {
  it('reports the DENOMINATOR it walked, not just the findings', async () => {
    // D-001's lesson: a scan that silently walked 6 files instead of 659 reads
    // identical to a clean result. The count is the thing that makes it checkable.
    const scan = await scanExpiredDocs(root, NOW);
    expect(scan.scanned).toBe(6);
    expect(scan.withStaleAfter).toBe(4);
  });

  it('finds only the docs that are actually past their date, including nested ones', async () => {
    const scan = await scanExpiredDocs(root, NOW);
    expect(scan.expired.map((d) => d.docId).sort()).toEqual(['boundary.mdx', 'nested/expired.mdx']);
    expect(scan.expired.find((d) => d.docId === 'nested/expired.mdx')?.staleAfter).toBe('2026-01-01');
  });

  it('does NOT count an unparseable stale_after as expired', async () => {
    const scan = await scanExpiredDocs(root, NOW);
    expect(scan.unparseable).toEqual(['broken.mdx']);
    expect(scan.expired.some((d) => d.docId === 'broken.mdx')).toBe(false);
  });

  it('reports NOTHING for a corpus with no stale_after — the live state today', async () => {
    // This is the assertion that keeps P-005 honest: the feature firing on nothing
    // is correct, and must never be "fixed" by backfilling values (D-002).
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-bare-'));
    await fs.writeFile(path.join(bare, 'a.mdx'), '---\ntitle: A\ntype: Insight\n---\n\nbody\n', 'utf8');
    try {
      const scan = await scanExpiredDocs(bare, NOW);
      expect(scan.scanned).toBe(1);
      expect(scan.withStaleAfter).toBe(0);
      expect(scan.expired).toEqual([]);
      expect(buildOkfExpiryDigest('papercusp', scan)).toBeNull();
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('degrades to an empty scan for a docs root that does not exist', async () => {
    const scan = await scanExpiredDocs(path.join(root, 'nope'), NOW);
    expect(scan).toMatchObject({ scanned: 0, expired: [], unparseable: [] });
  });
});

describe('buildOkfExpiryDigest', () => {
  it('names the expired docs with their dates in ONE line', async () => {
    const scan = await scanExpiredDocs(root, NOW);
    const digest = buildOkfExpiryDigest('papercusp', scan);
    expect(digest).toContain('papercusp');
    expect(digest).toContain('nested/expired.mdx (2026-01-01)');
    expect(digest).toContain('NEEDS RE-VERIFY');
    expect(digest).toContain('unparseable stale_after: broken.mdx');
    expect(digest?.split('\n')).toHaveLength(1);
  });

  it('caps the inline names so it can never become a flood (EI-2826)', () => {
    const scan: OkfExpiryScan = {
      scanned: 40,
      withStaleAfter: 20,
      expired: Array.from({ length: 20 }, (_, i) => ({ docId: `d${i}.mdx`, staleAfter: '2026-01-01' })),
      unparseable: [],
    };
    const digest = buildOkfExpiryDigest('h', scan) ?? '';
    expect(digest).toContain('(+12 more)');
    expect(digest).not.toContain('d19.mdx');
  });
});

describe('claimDailyExpiryScan', () => {
  it('allows one scan per UTC day per harness', () => {
    __resetDailyExpiryScanGate();
    expect(claimDailyExpiryScan('a', NOW)).toBe(true);
    expect(claimDailyExpiryScan('a', new Date('2026-08-08T23:59:59Z'))).toBe(false);
    // A different harness is independent…
    expect(claimDailyExpiryScan('b', NOW)).toBe(true);
    // …and the next UTC day re-opens the gate.
    expect(claimDailyExpiryScan('a', new Date('2026-08-09T00:00:01Z'))).toBe(true);
  });

  it('keys on the UTC day, not local time', () => {
    expect(utcDayKey(new Date('2026-08-08T23:59:59Z'))).toBe('2026-08-08');
    expect(utcDayKey(new Date('2026-08-09T00:00:00Z'))).toBe('2026-08-09');
  });
});
