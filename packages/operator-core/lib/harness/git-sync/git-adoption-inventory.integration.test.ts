/**
 * P-005's maintained inventory-consumer fixture. This exercises the review
 * artifact's pagination/recovery contract; it is not a production inventory
 * service, proof of an upstream patch's benefit, or release evidence.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type Patch = { key: string; source: string; commit: string; exclusion: string | null };
type Source = { name: string; commit: string; positiveControl: string };
type Inventory = { sources: Source[]; members: Patch[]; hash: string };
type Page = { start: number; members: Patch[]; remaining: number; next: string | null };
type Reader = (cursor: string | null) => Page;
const N = 4;
const roots: string[] = [];
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const byKey = <T extends { key: string }>(a: T, b: T) => a.key.localeCompare(b.key);
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'git-adoption-inventory-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function inventory(members: Patch[], sources: Source[]): Inventory {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.key)) throw new Error('duplicate stable patch key');
    seen.add(member.key);
    if (!sources.some(s => s.name === member.source)) throw new Error('unknown source');
  }
  for (const source of sources) {
    if (!members.some(p => p.key === source.positiveControl && p.source === source.name)) {
      throw new Error('missing source positive control');
    }
  }
  const canonical = {
    sources: [...sources].sort((a, b) => a.name.localeCompare(b.name)),
    members: [...members].sort(byKey),
  };
  return { ...canonical, hash: sha(canonical) };
}

function population(count: number): Inventory {
  const members = Array.from({ length: count }, (_, i) => ({
    key: `patch-${String(i).padStart(5, '0')}`,
    source: i === count - 1 ? 'openai/git' : 'git/git',
    commit: sha(`fixture-commit-${i}`),
    exclusion: i % 3 === 0 ? 'outside the declared transport topic' : null,
  }));
  return inventory(members, [
    { name: 'git/git', commit: sha('upstream-head'), positiveControl: members[0].key },
    { name: 'openai/git', commit: sha('fork-head'), positiveControl: members[count - 1].key },
  ]);
}

function reader(source: Inventory, size = N): Reader {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('invalid page size');
  return cursor => {
    let start = 0;
    if (cursor !== null) {
      const token = JSON.parse(cursor) as { hash: string; offset: number };
      if (token.hash !== source.hash) throw new Error('cursor revision mismatch');
      if (!Number.isSafeInteger(token.offset) || token.offset < 0 || token.offset > source.members.length) {
        throw new Error('invalid cursor offset');
      }
      start = token.offset;
    }
    const end = Math.min(start + size, source.members.length);
    return {
      start,
      members: source.members.slice(start, end),
      remaining: source.members.length - end,
      next: end < source.members.length ? JSON.stringify({ hash: source.hash, offset: end }) : null,
    };
  };
}

function atomicWrite(path: string, value: unknown) {
  writeFileSync(`${path}.pending`, JSON.stringify(value));
  renameSync(`${path}.pending`, path);
}

/** A fresh invocation recovers exclusively from the source and durable batches. */
function consume(source: Inventory, dir: string, read: Reader, crashAfter?: number): Patch[] {
  const manifest = join(dir, `${source.hash}.inventory.json`);
  try {
    const prior = JSON.parse(readFileSync(manifest, 'utf8')) as Inventory;
    if (JSON.stringify(prior) !== JSON.stringify(source)) throw new Error('inventory revision overwritten');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    atomicWrite(manifest, source);
  }
  const files = readdirSync(dir).filter(f => f.startsWith(`${source.hash}.batch-`)).sort();
  let cursor: string | null = null;
  let completed = 0;
  const collected: Patch[] = [];
  for (const file of files) {
    const page = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Page;
    validate(page, completed);
    collected.push(...page.members);
    completed += page.members.length;
    cursor = page.next;
  }
  // A checkpoint may lag a durable batch after process death. The contiguous
  // journal, rather than the stale checkpoint, supplies the recovered cursor.
  let batch = files.length;
  while (completed < source.members.length) {
    const page = read(cursor);
    validate(page, completed);
    atomicWrite(join(dir, `${source.hash}.batch-${String(batch).padStart(8, '0')}.json`), page);
    if (crashAfter === batch) throw new Error('process stopped before cursor checkpoint');
    atomicWrite(join(dir, `${source.hash}.checkpoint.json`), { next: page.next, completed: completed + page.members.length });
    collected.push(...page.members);
    completed += page.members.length;
    cursor = page.next;
    batch++;
  }
  if (JSON.stringify(collected) !== JSON.stringify(source.members)) throw new Error('incomplete source partition');
  return collected;

  function validate(page: Page, offset: number) {
    if (page.start !== offset || page.members.length === 0) throw new Error('cursor did not advance');
    const end = offset + page.members.length;
    if (JSON.stringify(page.members) !== JSON.stringify(source.members.slice(offset, end))) throw new Error('source membership mismatch');
    if (page.remaining !== source.members.length - end) throw new Error('missing omission accounting');
    const expected = end < source.members.length ? JSON.stringify({ hash: source.hash, offset: end }) : null;
    if (page.next !== expected) throw new Error('missing or invalid recovery cursor');
  }
}

type Disposition = { key: string; inventoryHash: string; outcome: 'adopted' | 'deferred' | 'rejected'; evidence: string };
function validateDecision(source: Inventory, decisions: Disposition[]) {
  if (decisions.some(d => d.inventoryHash !== source.hash)) throw new Error('stale inventory disposition');
  if (new Set(decisions.map(d => d.key)).size !== decisions.length) throw new Error('duplicate disposition');
  if (JSON.stringify(decisions.map(d => d.key).sort()) !== JSON.stringify(source.members.map(p => p.key).sort())) {
    throw new Error('disposition partition mismatch');
  }
  if (decisions.some(d => d.outcome !== 'adopted' && !d.evidence.trim())) throw new Error('negative disposition needs evidence');
}

describe('Git adoption inventory consumer recovery (P-005)', () => {
  it('consumes the recorded public-source inventory and verifies its complete content hash', () => {
    const recorded = JSON.parse(readFileSync(new URL('./__fixtures__/git-adoption-inventory-2026-11-19.json', import.meta.url), 'utf8')) as Inventory;
    const recomputed = inventory(recorded.members, recorded.sources);
    expect(recomputed.hash).toBe(recorded.hash);
    const dir = root();
    expect(() => consume(recorded, dir, reader(recorded, 1), 0)).toThrow('process stopped');
    expect(consume(recorded, dir, reader(recorded, 1))).toEqual(recorded.members);
    expect(readdirSync(dir).filter(f => f.includes('.batch-'))).toHaveLength(recorded.members.length);
  });

  it.each([N - 1, N, N + 1, 4 * N + 1])('recovers all %i records through the actual returned cursors', count => {
    const source = population(count), dir = root();
    // Replacing the consumer after durable writes exercises multiple successive
    // crashes, including the gap before the cursor checkpoint is saved.
    for (let batch = 0; batch < Math.ceil(count / N); batch++) {
      expect(() => consume(source, dir, reader(source), batch)).toThrow('process stopped');
    }
    const result = consume(source, dir, reader(source));
    expect(result).toEqual(source.members);
    expect(new Set(result.map(p => p.key)).size).toBe(count);
    expect(result.at(-1)?.source).toBe('openai/git');
    const batches = readdirSync(dir).filter(f => f.includes('.batch-'));
    expect(batches).toHaveLength(Math.ceil(count / N));
    const pages = batches.map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Page);
    expect(pages.flatMap(p => p.members)).toEqual(source.members);
    expect(pages.at(-1)).toMatchObject({ remaining: 0, next: null });
  });

  it('preserves stable-key membership and content hashes under source permutations', () => {
    const original = population(4 * N + 1);
    for (const members of [[...original.members].reverse(), [...original.members.slice(N), ...original.members.slice(0, N)]]) {
      const changed = inventory(members, [...original.sources].reverse());
      expect(changed.hash).toBe(original.hash);
      expect(consume(changed, root(), reader(changed))).toEqual(original.members);
    }
  });

  it('fails a consumer that ignores or replays a recovery cursor, and a producer that hides omissions', () => {
    const source = population(N + 1), good = reader(source);
    expect(() => consume(source, root(), () => good(null))).toThrow('cursor did not advance');
    expect(() => consume(source, root(), cursor => ({ ...good(cursor), next: null }))).toThrow('recovery cursor');
    expect(() => consume(source, root(), cursor => ({ ...good(cursor), remaining: 0 }))).toThrow('omission accounting');
  });

  it('retains append-only revisions and rejects stale cursors and dispositions', () => {
    const old = population(N + 1), dir = root();
    consume(old, dir, reader(old));
    const before = readFileSync(join(dir, `${old.hash}.inventory.json`), 'utf8');
    const next = inventory(old.members.map((p, i) => i ? p : { ...p, exclusion: 'revised applicability evidence' }), old.sources);
    expect(next.hash).not.toBe(old.hash);
    consume(next, dir, reader(next));
    expect(readFileSync(join(dir, `${old.hash}.inventory.json`), 'utf8')).toBe(before);
    expect(() => reader(next)(reader(old)(null).next)).toThrow('revision mismatch');
    const decisions = old.members.map(p => ({ key: p.key, inventoryHash: old.hash, outcome: 'deferred' as const, evidence: 'Transport applicability not demonstrated.' }));
    expect(() => validateDecision(old, decisions)).not.toThrow();
    expect(() => validateDecision(next, decisions)).toThrow('stale inventory');
    expect(() => validateDecision(old, decisions.slice(1))).toThrow('partition');
    expect(() => validateDecision(old, [...decisions.slice(1), { ...decisions[0], key: 'outside-the-inventory' }])).toThrow('partition');
    expect(() => validateDecision(old, [...decisions, decisions[0]])).toThrow('duplicate');
    expect(() => validateDecision(old, decisions.map(d => ({ ...d, evidence: '' })))).toThrow('needs evidence');
  });

  it('rejects a missing source control, duplicated identities and a corrupted durable batch', () => {
    const source = population(N + 1), dir = root();
    expect(() => inventory(source.members.slice(0, -1), source.sources)).toThrow('positive control');
    expect(() => inventory([...source.members, source.members[0]], source.sources)).toThrow('duplicate stable');
    expect(() => consume(source, dir, reader(source), 0)).toThrow('process stopped');
    const file = readdirSync(dir).find(f => f.includes('.batch-'))!;
    writeFileSync(join(dir, file), '{broken');
    expect(() => consume(source, dir, reader(source))).toThrow(SyntaxError);
  });
});
