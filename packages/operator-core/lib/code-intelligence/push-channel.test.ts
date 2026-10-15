import { describe, expect, it, vi } from 'vitest';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import { codeIntelPushText, CODE_INTEL_PUSH_TURN_CHARS, PUSH_LEG_FLAGS, snapshotFirstTouchLeg, snapshotGrepLeg, grepLookupSubject, type PushChannelDeps, type PushFact } from './push-channel';
import { parsePushSnapshot, PUSH_SNAPSHOT_MAX_AGE_MS } from './push-snapshot';
import { dependencySnapshotPath } from './dependency-snapshot-path';

const now = Date.now();
const raw = () => ({ schema: 'graph-dependency-snapshot-v1', index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
  generatedAt: new Date(now).toISOString(), edges: [
    { importer: 'app/use.ts', imported: 'lib/target.ts', importerSha256: 'b'.repeat(64) },
    { importer: 'lib/target.test.ts', imported: 'lib/target.ts', importerSha256: 'c'.repeat(64) },
  ] });
const snapshot = () => parsePushSnapshot(JSON.stringify(raw()), now)!;
const input = { owner: 'agent-A', workspace: 'ws-A', harness: 'papercusp', calls: [{ tool: 'Read', toolInput: { file_path: 'lib/target.ts' } }] };
const fact: PushFact = { leg: 'first-touch', subject: 'lib/target.ts', text: 'Static consumer: app/use.ts; runtime execution unknown.', citedPaths: ['app/use.ts'] };
function deps(): PushChannelDeps {
  return { snapshot: vi.fn(async () => snapshot()), enabled: vi.fn(async () => true),
    legs: () => new Map([['first-touch', () => [fact]]]),
    commit: vi.fn(async (_input, _snapshot, facts: readonly PushFact[]) => facts.map(f => f.text).join('\n')) };
}

describe('shared snapshot-backed push channel', () => {
  it('indexes static dependencies only and refuses foreign, stale and future snapshots', () => {
    expect(snapshot().importers.get('lib/target.ts')).toEqual(['app/use.ts', 'lib/target.test.ts']);
    for (const over of [
      { index: { ...raw().index, backend: 'gitnexus' } },
      { index: { ...raw().index, lastCommit: '' } },
      { generatedAt: new Date(now - PUSH_SNAPSHOT_MAX_AGE_MS - 1).toISOString() },
      { generatedAt: new Date(now + 300_001).toISOString() },
      { edges: [{ ...raw().edges[0], importer: '../secret.ts' }] },
    ]) expect(parsePushSnapshot(JSON.stringify({ ...raw(), ...over }), now)).toBeNull();
    expect(() => dependencySnapshotPath('../another-repo')).toThrow('Invalid snapshot');
  });

  it('keeps every registered leg ON by default', () => {
    expect(Object.values(PUSH_LEG_FLAGS).map(flag => FLAG_DEFAULTS[flag])).toEqual(Array(6).fill(true));
  });

  it('renders a first-touch snapshot witness while naming unmeasured symbol and runtime evidence', () => {
    const facts = snapshotFirstTouchLeg(input, snapshot());
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toContain('2 static file importers');
    expect(facts[0]?.text).toContain('runtime execution are unknown');
    expect(facts[0]?.suggestedCall).toBe('testing:run {"files":["lib/target.test.ts"],"harness":"papercusp"}');
    expect(snapshotFirstTouchLeg({ ...input, calls: [{ tool: 'Read', toolInput: { file_path: '/outside.ts' } }] }, snapshot())).toEqual([]);
    expect(snapshotFirstTouchLeg({ ...input, root: '/repo', calls: [{ tool: 'Read', toolInput: { file_path: '/repo/lib/target.ts' } }] }, snapshot())).toHaveLength(1);
    expect(snapshotFirstTouchLeg({ ...input, calls: [{ tool: 'mcp__papercusp_su__capability_read', toolInput: { file_path: 'lib/target.ts' } }] }, snapshot())).toHaveLength(1);
  });

  it('delivers immediately from an available snapshot and gives memory its budget first', async () => {
    const d = deps();
    expect(await codeIntelPushText(input, 350, d)).toContain('Static consumer');
    expect(d.commit).toHaveBeenCalledWith(input, expect.objectContaining({ commit: 'a'.repeat(40) }), [fact],
      CODE_INTEL_PUSH_TURN_CHARS - 350, expect.any(AbortSignal));
    vi.mocked(d.commit).mockClear();
    expect(await codeIntelPushText(input, CODE_INTEL_PUSH_TURN_CHARS, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('a cold/missing snapshot or an OFF leg never starts a compiler or writes telemetry', async () => {
    const d = deps();
    vi.mocked(d.snapshot).mockResolvedValueOnce(null);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    vi.mocked(d.enabled).mockResolvedValue(false);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('does not clip oversized facts or persist unsafe paths', async () => {
    const d = deps();
    d.legs = () => new Map([['first-touch', () => [
      { ...fact, text: 'x'.repeat(CODE_INTEL_PUSH_TURN_CHARS) },
      { ...fact, citedPaths: ['/private/file'] },
    ]]]);
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
  });

  it('answers a literal grep with a unique snapshot symbol and aliases, remaining quiet for ambiguous regexes', () => {
    const snap = snapshot();
    snap.symbols = new Map([['target', [{ id: 'target', name: 'target', path: 'lib/target.ts', line: 2, column: 1,
      sha256: 'b'.repeat(64), signature: 'function target()', aliases: ['target'],
      callers: [{ path: 'app/use.ts', line: 3, column: 1, sha256: 'c'.repeat(64), spelling: 'alias' }] }]]]);
    const call = { tool: 'exec_command', toolInput: { cmd: "rg -n 'target\\(' packages" } };
    expect(grepLookupSubject(call)).toBe('target');
    const facts = snapshotGrepLeg({ ...input, calls: [call] }, snap);
    expect(facts[0]?.text).toContain('definition lib/target.ts:2');
    expect(facts[0]?.text).toContain('Aliases a literal grep can miss: alias');
    expect(facts[0]?.text).toContain('At least 1');
    expect(grepLookupSubject({ tool: 'Bash', toolInput: { command: "rg 'target|another'" } })).toBeNull();
    expect(snapshotGrepLeg({ ...input, calls: [{ tool: 'Grep', toolInput: { pattern: 'missing' } }] }, snap)).toEqual([]);
  });

  it('fails open for other context but never runs an abandoned commit after its wall', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    vi.mocked(d.snapshot).mockImplementation(() => new Promise(() => {}));
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(d.commit).not.toHaveBeenCalled();
    vi.mocked(d.snapshot).mockResolvedValue(snapshot());
    vi.mocked(d.commit).mockRejectedValue(new Error('store unavailable'));
    expect(await codeIntelPushText(input, 0, d)).toBe('');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code-intel-push exceeded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
    warn.mockRestore();
  });
});
