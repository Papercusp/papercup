import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { PresenceRecord } from '../agent-tools/coordination/presence';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { pruneRunsWithReport, pruneStaleForeign } from '../../../../libs/generic/verification-harness/src/runner';
import { isLeaseLive, readRetentionLeases } from '../release-cut-reclaim';
import { createRetentionPin, pinProtectsPath, readOpenWorkItemEvidenceReferences, readRetentionPins, readRetentionPinsAsync, removeRetentionPin, renewWorkItemEvidencePins, withWorkItemEvidenceRetention } from './retention-pins';
import { withRetentionPinProtection as withPortablePinProtection } from '../../../../scripts/lib/retention-pins.mjs';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'retention-pin-')); roots.push(root);
  const dir = join(root, 'leases'); const target = join(root, 'agent-output'); mkdirSync(target);
  const nowMs = Date.UTC(2026, 9, 15);
  const presence: PresenceRecord = {
    ownerId: 'consumer', ownerLabel: 'Fixture consumer', workspaceId: 'fixture', source: 'fixture',
    intent: '', currentPlanSlug: null, currentFiles: [], host: 'fixture-host', pid: null, tty: null,
    startedAt: new Date(nowMs).toISOString(), heartbeatAt: new Date(nowMs).toISOString(),
    lastActiveAt: null, intentDeclaredAt: null, agentRole: 'su', potSlug: null,
    capabilityTags: [], stale: false, userId: null, revoked: false,
  };
  return { root, dir, target, nowMs, presence, expiresAt: new Date(nowMs + 3600_000).toISOString() };
}

describe('agent retention pins in the existing lease store', () => {
  it.each(['live', 'parked', 'recorded', 'dead', 'abandoned', 'revoked', 'missing'] as const)(
    'only renews an open item with an authorized actionable consumer (%s)', async state => {
      const f = fixture();
      const reference = { harness_slug: 'fixture', work_item_id: 'WI-consumer', evidence_ref: 'docs/evidence/consumer.json' };
      const sql = vi.fn(async () => [{ ...reference, taken_by: state === 'abandoned' ? null : 'consumer' }]) as unknown as Sql;
      const listPresence = vi.fn(async () => state === 'missing' ? [] : [{ ...f.presence, revoked: state === 'revoked' }]);
      const references = await readOpenWorkItemEvidenceReferences(sql, 'fixture', {
        nowMs: f.nowMs, listPresence,
        resolveSessionStates: (subjects, options) => resolveSessionStates(subjects, { ...options,
          fetchWakeabilityFn: async ids => new Map(ids.map(id => [id, {
            wakeable: state === 'parked', liveTurn: state === 'live' || state === 'revoked',
          }])),
          fetchRecordedLiveFn: async () => new Set(state === 'recorded' ? ['consumer'] : []),
          fetchRecordedEndedFn: async () => new Set(), probePidFn: () => null,
        }),
      });
      expect(references).toEqual(['live', 'parked', 'recorded'].includes(state) ? [reference] : []);
      if (state === 'abandoned') expect(listPresence).not.toHaveBeenCalled();
    });

  it('refuses an unknown liveness measurement instead of treating it as expired authority', async () => {
    const f = fixture();
    const sql = vi.fn(async () => [{ harness_slug: 'fixture', work_item_id: 'WI-unknown',
      evidence_ref: 'docs/evidence/unknown.json', taken_by: 'consumer' }]) as unknown as Sql;
    await expect(readOpenWorkItemEvidenceReferences(sql, 'fixture', {
      nowMs: f.nowMs, listPresence: async () => [f.presence],
      resolveSessionStates: (subjects, options) => resolveSessionStates(subjects, { ...options,
        fetchWakeabilityFn: async () => new Map(), fetchRecordedLiveFn: async () => new Set(),
        fetchRecordedEndedFn: async () => new Set(), probePidFn: () => null,
      }),
    })).rejects.toThrow('consumer liveness unknown');
  });

  it('renews one finite pin for an open item receipt and lets it expire when renewal stops', async () => {
    const f = fixture(); const repository = join(f.root, 'repo'), home = join(f.root, 'home');
    mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const path = join(home, '.papercusp/evidence/WI-10004735-native'); mkdirSync(path, { recursive: true });
    const evidence_ref = 'docs/evidence/native.json';
    writeFileSync(join(repository, evidence_ref), JSON.stringify({ retainedEvidence: {
      root: '.papercusp/evidence/WI-10004735-native', pathBase: 'Operating account home directory; outside the checkout',
    } }));
    const refs = [{ harness_slug: 'fixture', work_item_id: 'WI-10004735', evidence_ref }];
    const options = { ...f, home, repositories: new Map([['fixture', repository]]) };
    const preview = await renewWorkItemEvidencePins(refs, { ...options, dryRun: true });
    expect(pinProtectsPath(path, preview.pins, f.nowMs)).toBe(true);
    expect(existsSync(f.dir)).toBe(false);
    const first = await renewWorkItemEvidencePins(refs, options);
    expect(first.missing).toEqual([]); expect(first.pins).toHaveLength(1);
    expect(pinProtectsPath(path, first.pins, f.nowMs)).toBe(true);
    expect(pinProtectsPath(`${path}-unrelated`, first.pins, f.nowMs)).toBe(false);
    const nowMs = f.nowMs + 48 * 3_600_000;
    const next = await renewWorkItemEvidencePins(refs, { ...options, nowMs });
    expect(next.pins[0]!.id).toBe(first.pins[0]!.id);
    expect(Date.parse(next.pins[0]!.expiresAt)).toBeGreaterThan(Date.parse(first.pins[0]!.expiresAt));
    expect(readRetentionPins({ ...f, nowMs }).pins).toEqual(next.pins);
    expect(readdirSync(f.dir).filter(name => name.startsWith('lease-agent-pin-'))).toHaveLength(1);
    await renewWorkItemEvidencePins([], { ...options, nowMs: nowMs + 24 * 3_600_000 });
    expect(readRetentionPins({ ...f, nowMs: Date.parse(next.pins[0]!.expiresAt) }).pins).toEqual([]);
  });

  it('reports missing declared evidence instead of manufacturing an ineffective pin', async () => {
    const f = fixture(); const repository = join(f.root, 'repo'); mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const ref = { harness_slug: 'fixture', work_item_id: 'WI-missing', evidence_ref: 'docs/evidence/missing.json' };
    const options = { ...f, home: f.root, repositories: new Map([['fixture', repository]]) };
    expect((await renewWorkItemEvidencePins([ref], options)).missing).toEqual([
      { workItemId: ref.work_item_id, evidenceRef: ref.evidence_ref, path: join(repository, ref.evidence_ref) },
    ]);
    writeFileSync(join(repository, ref.evidence_ref), JSON.stringify({ retainedEvidence: {
      root: '.papercusp/evidence/missing', pathBase: 'Operating account home directory',
    } }));
    expect((await renewWorkItemEvidencePins([ref], options)).missing[0]!.path).toBe(join(f.root, '.papercusp/evidence/missing'));
    expect(readRetentionPins(f).pins).toEqual([]);
  });

  it.each(['home', 'repository'])('renews retained release publication custody under the %s', async location => {
    const f = fixture(), repository = join(f.root, 'repo'), home = join(f.root, 'home');
    mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const relativeRoot = '.papercusp/release-artifacts/signed-publication';
    const target = join(location === 'home' ? home : repository, relativeRoot);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manifest.json'), '{"immutable":true}');
    const reference = { harness_slug: 'fixture', work_item_id: 'WI-release', evidence_ref: 'docs/evidence/custody.json' };
    writeFileSync(join(repository, reference.evidence_ref), JSON.stringify({ retainedEvidence: {
      root: relativeRoot, pathBase: location === 'home' ? 'Operating account home directory' : 'Repository root',
    } }));
    const options = { ...f, home, repositories: new Map([['fixture', repository]]) };
    const first = await renewWorkItemEvidencePins([reference], options);
    expect(first.missing).toEqual([]);
    expect(pinProtectsPath(join(target, 'manifest.json'), first.pins, f.nowMs)).toBe(true);
    const renewed = await renewWorkItemEvidencePins([reference], { ...options, nowMs: f.nowMs + 48 * 3_600_000 });
    expect(renewed.pins[0]!.id).toBe(first.pins[0]!.id);
    expect(Date.parse(renewed.pins[0]!.expiresAt)).toBeGreaterThan(Date.parse(first.pins[0]!.expiresAt));
    expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe('{"immutable":true}');
    expect(pinProtectsPath(target, renewed.pins, Date.parse(renewed.pins[0]!.expiresAt))).toBe(false);
    rmSync(target, { recursive: true });
    expect((await renewWorkItemEvidencePins([reference], options)).missing).toEqual([
      { workItemId: reference.work_item_id, evidenceRef: reference.evidence_ref, path: target },
    ]);
  });

  it('pins evidence before accepting a binding and refuses intake after its retained root is gone', async () => {
    const f = fixture(), repository = join(f.root, 'repo'), home = join(f.root, 'home');
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const target = join(home, '.papercusp/evidence/native'); mkdirSync(target, { recursive: true });
    mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const reference = { harness_slug: 'fixture', work_item_id: 'WI-intake', evidence_ref: 'docs/evidence/intake.json' };
    writeFileSync(join(repository, reference.evidence_ref), JSON.stringify({ retainedEvidence: {
      root: '.papercusp/evidence/native', pathBase: 'Operating account home directory',
    } }));
    const options = { ...f, home, repositories: new Map([['fixture', repository]]) };
    const accept = vi.fn(async () => {
      expect(pinProtectsPath(target, readRetentionPins(f).pins, f.nowMs)).toBe(true);
      return 'accepted';
    });
    expect(await withWorkItemEvidenceRetention(reference, options, accept)).toBe('accepted');
    rmSync(target, { recursive: true });
    await expect(withWorkItemEvidenceRetention(reference, options, accept)).rejects.toThrow('missing declared evidence');
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it.each(['renewal-first', 'reclaim-first'] as const)('serializes evidence custody with cleanup (%s)', async order => {
    const f = fixture(), repository = join(f.root, 'repo'), home = join(f.root, 'home');
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const target = join(home, '.papercusp/evidence/race'); mkdirSync(target, { recursive: true });
    mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const reference = { harness_slug: 'fixture', work_item_id: 'WI-race', evidence_ref: 'docs/evidence/race.json' };
    writeFileSync(join(repository, reference.evidence_ref), JSON.stringify({ retainedEvidence: {
      root: '.papercusp/evidence/race', pathBase: 'Operating account home directory',
    } }));
    const options = { ...f, home, repositories: new Map([['fixture', repository]]) };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const accept = vi.fn(async () => 'accepted');
    if (order === 'renewal-first') {
      const intake = withWorkItemEvidenceRetention(reference, options, async () => {
        entered(); await proceed; return accept();
      });
      await started;
      const reclaim = withPortablePinProtection(isPinned => {
        if (!isPinned(target)) rmSync(target, { recursive: true });
      }, f);
      release(); await Promise.all([intake, reclaim]);
      expect(accept).toHaveBeenCalledTimes(1); expect(existsSync(target)).toBe(true);
    } else {
      const reclaim = withPortablePinProtection(async isPinned => {
        expect(isPinned(target)).toBe(false); entered(); await proceed;
        rmSync(target, { recursive: true });
      }, f);
      await started;
      const intake = withWorkItemEvidenceRetention(reference, options, accept);
      const refused = expect(intake).rejects.toThrow('missing declared evidence');
      release(); await Promise.all([reclaim, refused]);
      expect(accept).not.toHaveBeenCalled(); expect(existsSync(target)).toBe(false);
    }
  });

  it('serializes active renewal expiry and cleanup without reclaiming authorized evidence', async () => {
    for (const order of ['renewal-first', 'cleanup-first'] as const) {
      const f = fixture(), repository = join(f.root, 'repo'), home = join(f.root, 'home');
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
      const target = join(home, '.papercusp/evidence/boundary');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'original.txt'), 'original retained evidence');
      mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
      const reference = { harness_slug: 'fixture', work_item_id: 'WI-boundary', evidence_ref: 'docs/evidence/boundary.json' };
      writeFileSync(join(repository, reference.evidence_ref), JSON.stringify({ retainedEvidence: {
        root: '.papercusp/evidence/boundary', pathBase: 'Operating account home directory',
      } }));
      const options = { ...f, home, repositories: new Map([['fixture', repository]]) };
      const initial = await withWorkItemEvidenceRetention(reference, options, async () => readRetentionPins(f).pins[0]!);
      const boundary = Date.parse(initial.expiresAt);
      expect(pinProtectsPath(target, [initial], boundary - 1)).toBe(true);
      expect(pinProtectsPath(target, [initial], boundary)).toBe(false);
      let entered!: () => void, release!: () => void, queued!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const proceed = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { queued = resolve; });
      const read = vi.fn(() => readFileSync(join(target, 'original.txt'), 'utf8'));

      if (order === 'renewal-first') {
        const intake = withWorkItemEvidenceRetention(reference, { ...options, nowMs: boundary - 1 }, async () => {
          entered(); await proceed; return read();
        });
        await started;
        const cleanup = withPortablePinProtection(isPinned => {
          expect(isPinned(target)).toBe(true);
          if (!isPinned(target)) rmSync(target, { recursive: true });
        }, { ...f, nowMs: boundary, onWaiting: queued });
        try { await waiting; } finally { release(); }
        const [bytes] = await Promise.all([intake, cleanup]);
        expect(bytes).toBe('original retained evidence');
        expect(read).toHaveBeenCalledTimes(1);
        const renewed = readRetentionPins({ ...f, nowMs: boundary }).pins[0]!;
        expect(renewed.id).toBe(initial.id);
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(boundary);
        expect(existsSync(target)).toBe(true);
        expect(() => removeRetentionPin(renewed.id, 'foreign-consumer', f)).toThrow('only the pin owner');
        expect(readRetentionPins({ ...f, nowMs: boundary }).pins).toEqual([renewed]);
        await withPortablePinProtection(() => {
          expect(removeRetentionPin(renewed.id, renewed.owner, f)).toBe(true);
        }, { ...f, nowMs: boundary });
        await withPortablePinProtection(isPinned => {
          expect(isPinned(target)).toBe(false);
          if (!isPinned(target)) rmSync(target, { recursive: true });
        }, { ...f, nowMs: boundary });
      } else {
        const cleanup = withPortablePinProtection(async isPinned => {
          expect(isPinned(target)).toBe(false);
          entered(); await proceed;
          if (!isPinned(target)) rmSync(target, { recursive: true });
        }, { ...f, nowMs: boundary });
        await started;
        const intake = withWorkItemEvidenceRetention(reference, { ...options, nowMs: boundary }, async () => read());
        const refused = expect(intake).rejects.toThrow('missing declared evidence');
        // Cleanup already owns the mutex. A queued renewal must re-resolve the
        // artifact after deletion, rather than resurrecting authority over it.
        release();
        await Promise.all([cleanup, refused]);
        expect(read).not.toHaveBeenCalled();
      }
      expect(existsSync(target)).toBe(false);
      const lateRead = vi.fn(async () => read());
      await expect(withWorkItemEvidenceRetention(reference, { ...options, nowMs: boundary + 1 }, lateRead))
        .rejects.toThrow('missing declared evidence');
      expect(lateRead).not.toHaveBeenCalled();
    }
  });

  it.each(['ambiguous', 'outside', 'symlink'])('refuses an unsafe %s evidence receipt', async kind => {
    const f = fixture(); const repository = join(f.root, 'repo'); mkdirSync(join(repository, 'docs/evidence'), { recursive: true });
    const path = join(repository, 'docs/evidence/unsafe.json');
    const receipt = { retainedEvidence: { root: kind === 'outside' ? '../../owner-data' : '.papercusp/evidence/run',
      pathBase: kind === 'ambiguous' ? 'unknown' : 'Operating account home directory' } };
    if (kind === 'symlink') { writeFileSync(join(f.root, 'outside.json'), JSON.stringify(receipt)); symlinkSync(join(f.root, 'outside.json'), path); }
    else writeFileSync(path, JSON.stringify(receipt));
    await expect(renewWorkItemEvidencePins([{ harness_slug: 'fixture', work_item_id: 'WI-unsafe', evidence_ref: 'docs/evidence/unsafe.json' }],
      { ...f, home: f.root, repositories: new Map([['fixture', repository]]) })).rejects.toThrow();
    expect(readRetentionPins(f).pins).toEqual([]);
  });

  it('keeps caller-registry descendant pins when a privileged reader resolves the store alias', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const child = join(f.target, 'review'); mkdirSync(child);
    createRetentionPin({ path: child, owner: 'a', reason: 'retained rootful artifact', expiresAt: f.expiresAt }, f);
    const alias = join(f.root, 'rootful-store');
    const resolvePath = vi.fn((path: string) => path === alias ? f.target : path);
    await withPortablePinProtection(isPinned => {
      expect(isPinned(alias)).toBe(true);
      expect(isPinned(`${alias}-other`)).toBe(false);
    }, { dir: f.dir, nowMs: f.nowMs, resolvePath });
    expect(resolvePath).toHaveBeenCalledWith(alias);
  });

  it('fails closed when the privileged path reader is refused', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    await expect(withPortablePinProtection(isPinned => isPinned(f.target), {
      dir: f.dir, nowMs: f.nowMs,
      resolvePath: () => { throw Object.assign(new Error('privileged read refused'), { code: 'EACCES' }); },
    })).rejects.toThrow('privileged read refused');
  });

  it('refuses corrupt caller pins before admitting a privileged path reader', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    mkdirSync(f.dir); writeFileSync(join(f.dir, 'lease-agent-pin-broken.tsv'), 'broken');
    const resolvePath = vi.fn((path: string) => path);
    await expect(withPortablePinProtection(isPinned => isPinned(f.target), {
      dir: f.dir, nowMs: f.nowMs, resolvePath,
    })).rejects.toThrow('retention pins unreadable');
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it('VH count and pressure passes retain pinned runs through a physical alias and expiry restores eligibility', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', f.dir);
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const names = ['20261001T000000Z-1', '20261002T000000Z-2', '20261003T000000Z-3'];
    for (const name of names) {
      const dir = join(f.target, name); mkdirSync(dir);
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date(f.nowMs).toISOString(), verdict: 'pass' }));
    }
    const held = join(f.target, names[0]!); const child = join(held, 'review'); mkdirSync(child);
    createRetentionPin({ path: child, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    const alias = join(f.root, 'alias'); symlinkSync(f.target, alias);
    const options = { measureDisk: async () => ({ totalBytes: 100, availableBytes: 0 }), reserveBytes: () => 1 };
    const preview = await pruneRunsWithReport(alias, 1, f.nowMs, { ...options, dryRun: true });
    expect(preview.preview?.kept).toContainEqual({ path: join(alias, names[0]!), reason: 'retention-pin' });
    const report = await pruneRunsWithReport(alias, 1, f.nowMs, options);
    expect(report.removed).toContain(names[1]);
    expect(report.removed).not.toContain(names[0]); expect(existsSync(held)).toBe(true);
    expect((await pruneRunsWithReport(alias, 1, Date.parse(f.expiresAt), options)).removed).toContain(names[0]);
  });

  it('VH foreign retention honors descendant pins, expiry, and corrupt-store refusal', async () => {
    const f = fixture();
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', f.dir);
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));
    const held = join(f.target, 'held'); const other = join(f.target, 'other');
    mkdirSync(held); mkdirSync(other); const child = join(held, 'review'); writeFileSync(child, 'evidence');
    for (const path of [child, held, other]) utimesSync(path, new Date(0), new Date(0));
    createRetentionPin({ path: child, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect((await pruneStaleForeign(f.target, { maxAgeHours: 72, now: f.nowMs })).removed).toEqual(['other']);
    expect(existsSync(held)).toBe(true);
    writeFileSync(join(f.dir, 'lease-broken.tsv'), 'broken');
    await expect(pruneStaleForeign(f.target, { maxAgeHours: 72, now: f.nowMs })).rejects.toThrow(/retention pins unreadable/);
    await expect(pruneRunsWithReport(f.target, 1, f.nowMs)).rejects.toThrow(/retention pins unreadable/);
    expect(existsSync(held)).toBe(true);
    rmSync(join(f.dir, 'lease-broken.tsv'));
    expect((await pruneStaleForeign(f.target, { maxAgeHours: 72, now: Date.parse(f.expiresAt) })).removed).toEqual(['held']);
  });

  it('async reads share sync metadata validation, expiry and malformed-store protection', async () => {
    const f = fixture();
    expect(await readRetentionPinsAsync(f)).toEqual(readRetentionPins(f));
    createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(await readRetentionPinsAsync(f)).toEqual(readRetentionPins(f));
    const expired = { ...f, nowMs: Date.parse(f.expiresAt) };
    expect(await readRetentionPinsAsync(expired)).toEqual({ pins: [], errors: [] });
    writeFileSync(join(f.dir, 'lease-agent-pin-corrupt.tsv'), 'broken');
    expect((await readRetentionPinsAsync(f)).errors).toHaveLength(1);
  });

  it('round-trips owner, reason and finite expiry while existing deleters recognize the same lease', () => {
    const f = fixture();
    const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'Avi’s review\nretain evidence', expiresAt: f.expiresAt }, f);
    expect(readRetentionPins(f)).toEqual({ pins: [pin], errors: [] });
    const leases = readRetentionLeases(f.dir);
    expect(leases.errors).toEqual([]); expect(leases.leases).toHaveLength(1);
    expect(isLeaseLive(leases.leases[0]!, f.nowMs)).toBe(true);
    expect(leases.leases[0]!.paths).toEqual([f.target]);
    expect(readdirSync(f.dir)).toEqual([`lease-agent-pin-${pin.id}.tsv`]);
  });

  it('protects ancestors and descendants, with no sibling-prefix collision, and stops exactly at expiry', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(pinProtectsPath(join(f.target, 'report.json'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(f.root, [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(`${f.target}-other`, [pin], f.nowMs)).toBe(false);
    expect(pinProtectsPath(f.target, [pin], Date.parse(f.expiresAt))).toBe(false);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt) }).pins).toEqual([]);
    expect(readRetentionPins({ ...f, nowMs: Date.parse(f.expiresAt), includeExpired: true }).pins).toEqual([pin]);
  });

  it('protects both the logical alias and the physical offloaded path', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.target, alias);
    const pin = createRetentionPin({ path: alias, owner: 'a', reason: 'offloaded evidence', expiresAt: f.expiresAt }, f);
    expect(pin.paths).toEqual([alias, f.target]);
    expect(pinProtectsPath(join(alias, 'x'), [pin], f.nowMs)).toBe(true);
    expect(pinProtectsPath(join(f.target, 'x'), [pin], f.nowMs)).toBe(true);
  });

  it('refuses missing paths, nonfinite/past expiries and newline injection without creating a lease', () => {
    const f = fixture(); const base = { path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt };
    for (const input of [{ ...base, path: join(f.root, 'missing') }, { ...base, path: `${f.target}\npath=/` },
      { ...base, expiresAt: 'never' }, { ...base, expiresAt: new Date(f.nowMs).toISOString() }, { ...base, reason: ' ' }]) {
      expect(() => createRetentionPin(input, f)).toThrow();
    }
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });

  it('reports corrupt pin metadata instead of silently dropping protection', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'a', reason: 'review', expiresAt: f.expiresAt }, f);
    const file = join(f.dir, `lease-agent-pin-${pin.id}.tsv`);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^tag=.*$/m, 'tag=agent-pin-invalid'));
    expect(readRetentionPins(f).errors).toHaveLength(1);
    // The existing lease reader still protects its path: damaged descriptive metadata cannot enable deletion.
    expect(readRetentionLeases(f.dir).leases[0]!.paths).toEqual([f.target]);
  });

  it('permits only the pin owner to release an exact id', () => {
    const f = fixture(); const pin = createRetentionPin({ path: f.target, owner: 'agent-a', reason: 'review', expiresAt: f.expiresAt }, f);
    expect(() => removeRetentionPin(pin.id, 'agent-b', f)).toThrow(/only the pin owner/);
    expect(readRetentionPins(f).pins).toEqual([pin]);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(true);
    expect(removeRetentionPin(pin.id, 'agent-a', f)).toBe(false);
    expect(readRetentionPins(f)).toEqual({ pins: [], errors: [] });
  });
});
