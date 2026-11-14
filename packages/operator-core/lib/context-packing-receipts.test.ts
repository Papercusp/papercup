import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { packContextCandidates, type ContextCandidate } from './context-doors';
import { captureContextPackingAttribution, loadContextPackingReceipt, pageContextPackingReceipt, saveContextPackingReceipt, saveMcpContextPreparation,
  type ContextPackingAttribution, type ContextPackingScope } from './context-packing-receipts';
import { memoryFragmentOffer } from './memory/session-epoch-ledger';
import { contextSourceVersion } from './memory/temporal-render';
import { canonicalJson } from './external-bench/reproducibility/canonical-json';

const { artifacts, indexes } = vi.hoisted(() => ({ artifacts: new Map<string, string>(), indexes: new Map<string, string>() }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-a' }));
vi.mock('./serving-host-identity', () => ({ getServingHostIdentity: () => ({ host: 'port-test', processId: null, buildSha: null }) }));
vi.mock('./text-artifacts', () => ({
  saveImmutableTextArtifact: async (harness: string, content: string) => {
    const sha256 = createHash('sha256').update(content).digest('hex');
    artifacts.set(`${harness}/${sha256}`, content); return { sha256, relPath: `immutable/sha256/${sha256}.json` };
  },
  loadImmutableTextArtifact: async (harness: string, sha256: string) => artifacts.get(`${harness}/${sha256}`) ?? null,
  claimImmutableTextArtifact: async (harness: string, path: string, content: string) => {
    const key = `${harness}/${path}`;
    if (indexes.has(key)) {
      if (indexes.get(key) !== content) throw new Error('text_artifact_immutable_claim_conflict');
      return false;
    }
    indexes.set(key, content); return true;
  },
  loadImmutableTextArtifactClaim: async (harness: string, path: string) => indexes.get(`${harness}/${path}`) ?? null,
}));
const scope: ContextPackingScope = { ownerId: 'owner-a', workspaceId: 'workspace-a', harness: 'papercusp', port: 'turn-start', client: 'codex' };
const packed = () => packContextCandidates({ attemptId: 'attempt-1', budgetBytes: 0, candidates: [
  { sourceRef: 'control:1', revision: 'r1', class: 'control', required: true, text: '⟦CTRL⟧' },
] }).receipt;

beforeEach(() => { artifacts.clear(); indexes.clear(); });
describe('content-free durable MCP preparations', () => {
  const mcpScope = { ...scope, port: 'mcp-result' as const };
  const createdAt = '2026-11-12T15:00:00.000Z';
  const attribution: ContextPackingAttribution = { observedAt: createdAt, epoch: null, epochEvidenceRef: null,
    nativeSession: null, unknown: ['epoch-unavailable', 'native-session-unavailable'] };

  it('retains selected and omitted manifests, exact response hash and canonical source identity without result plaintext', async () => {
    const source = contextSourceVersion({ namespace: 'corpus', ref: 'plan:1', fullText: 'SECRET recalled prose', revision: 'r1',
      updatedAt: null, validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const a = memoryFragmentOffer('corpus', 'plan:1', 3, 'orient', 'SECRET recalled prose', source);
    const b = memoryFragmentOffer('memory', 'm2', 3, 'orient', 'SECRET omitted prose');
    const response = { content: [{ type: 'text', text: 'SECRET tool result and ' + a.rendered }] };
    const input = { attemptId: 'mcp-1', createdAt, attribution, staging: 'staged' as const, response,
      offers: [Object.assign(a, { arbitrary: 'SECRET injected metadata' }), b], selected: [a] };
    const ref = await saveMcpContextPreparation(mcpScope, input);
    expect(await saveMcpContextPreparation(mcpScope, input)).toEqual(ref);
    const bytes = artifacts.get(`papercusp/${ref.sha256}`)!;
    expect(bytes).not.toContain('SECRET');
    const stored = JSON.parse(bytes);
    expect(stored.preparedResponse).toEqual({ sha256: createHash('sha256').update(canonicalJson(response)).digest('hex'),
      bytes: Buffer.byteLength(canonicalJson(response), 'utf8'), encoding: 'canonical-json-v1' });
    expect(stored.fragments.map((row: { selected: boolean }) => row.selected)).toEqual([true, false]);
    expect(stored.fragments[0].sourceVersion).toEqual(source);
    expect(stored.emission).toBe('UNKNOWN');
    await expect(saveMcpContextPreparation(mcpScope, { ...input, response: {} })).rejects.toThrow('immutable_claim_conflict');
    expect(indexes.size).toBe(1);
  });

  it('hashes native SDK object key reorderings equally while preserving array and exact string bytes', async () => {
    const input = { attemptId: 'key-order', createdAt, attribution, staging: 'empty' as const, offers: [], selected: [] };
    const ref = await saveMcpContextPreparation(mcpScope, { ...input,
      response: { content: [{ type: 'text', text: '☃ exact' }], _meta: { b: 2, a: ['first', 'second'] } } });
    expect(await saveMcpContextPreparation(mcpScope, { ...input,
      response: { _meta: { a: ['first', 'second'], b: 2 }, content: [{ text: '☃ exact', type: 'text' }] } })).toEqual(ref);
    for (const response of [{ content: [{ type: 'text', text: '☃ changed' }], _meta: { b: 2, a: ['first', 'second'] } },
      { content: [{ type: 'text', text: '☃ exact' }], _meta: { b: 2, a: ['second', 'first'] } }]) {
      await expect(saveMcpContextPreparation(mcpScope, { ...input, response })).rejects.toThrow('immutable_claim_conflict');
    }
  });

  it.each(['empty', 'failed'] as const)('retains a %s attempt with no emission claim', async staging => {
    const ref = await saveMcpContextPreparation(mcpScope, { attemptId: staging, createdAt, attribution,
      staging, response: { content: [] }, offers: [], selected: [] });
    expect(JSON.parse(artifacts.get(`papercusp/${ref.sha256}`)!)).toMatchObject({ staging, fragments: [], emission: 'UNKNOWN' });
  });

  it('rejects foreign workspace and malformed source manifests before storing any artifact', async () => {
    const input = { attemptId: 'bad', createdAt, attribution, staging: 'staged' as const, response: {},
      offers: [memoryFragmentOffer('memory', 'm1', 3, 'orient', 'body')], selected: [] as ReturnType<typeof memoryFragmentOffer>[] };
    input.selected = input.offers;
    await expect(saveMcpContextPreparation({ ...mcpScope, workspaceId: 'foreign' }, input)).rejects.toThrow('scope_invalid');
    input.offers[0]!.bodyBytes = -1;
    await expect(saveMcpContextPreparation(mcpScope, input)).rejects.toThrow('preparation_invalid');
    expect(artifacts.size).toBe(0);
  });
});
describe('packing attempt attribution', () => {
  const observedAt = '2026-11-12T15:00:00.000Z';
  const row = () => ({ observed_at_ms: String(Date.parse(observedAt)), epoch: 0, bumped_at_ms: String(Date.parse(observedAt)), live_count: 1,
    adv_id: '42', agent: 'codex', native_id: 'native-a', event_id: '9', event_adv_id: '42', event_native_id: 'native-a', generation: '3' });
  const sqlFor = (value: unknown) => vi.fn(async () => value) as unknown as Sql;

  it('distinguishes an observed zero epoch from a missing row and binds the exact applied incarnation', async () => {
    const result = await captureContextPackingAttribution(scope, sqlFor([row()]));
    expect(result).toEqual({ observedAt, epoch: 0,
      epochEvidenceRef: JSON.stringify(['memory_session_epochs', scope.ownerId, 0, observedAt]),
      nativeSession: { backend: 'codex', sessionId: 'native-a', advSessionId: '42', activationEventId: '9', controlGeneration: 3 }, unknown: [] });
    const missing = await captureContextPackingAttribution(scope, sqlFor([{ ...row(), epoch: null, bumped_at_ms: null }]));
    expect(missing.epoch).toBeNull(); expect(missing.epochEvidenceRef).toBeNull();
    expect(missing.unknown).toEqual(['epoch-unavailable']);
  });

  it.each([{ live_count: 2 }, { native_id: 'reanchored' }, { event_adv_id: 'other' }, { agent: 'claude' },
    { event_id: null }, { generation: null }])('leaves conflicting native identity unknown: %j', async changes => {
    const result = await captureContextPackingAttribution(scope, sqlFor([{ ...row(), ...changes }]));
    expect(result.nativeSession).toBeNull(); expect(result.epoch).toBe(0);
    expect(result.unknown).toEqual(['native-session-unavailable']);
  });

  it('preserves unknowns on a failed read and never reads a foreign workspace', async () => {
    const sql = vi.fn(async () => { throw new Error('private connection detail'); }) as unknown as Sql;
    const result = await captureContextPackingAttribution(scope, sql);
    expect(result).toMatchObject({ epoch: null, nativeSession: null,
      unknown: ['epoch-unavailable', 'native-session-unavailable', 'attribution-read-failed'] });
    vi.mocked(sql).mockClear();
    await captureContextPackingAttribution({ ...scope, workspaceId: 'foreign' }, sql);
    expect(sql).not.toHaveBeenCalled();
  });

  it('bounds a stuck attribution read and cancels it without turning absence into zero', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => {});
      const pending = Object.assign(new Promise(() => {}), { cancel });
      const sql = vi.fn(() => pending) as unknown as Sql;
      const result = captureContextPackingAttribution(scope, sql);
      await vi.advanceTimersByTimeAsync(151);
      expect(await result).toMatchObject({ epoch: null, nativeSession: null,
        unknown: ['epoch-unavailable', 'native-session-unavailable', 'attribution-read-failed'] });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('freezes the requested workspace and recipient before yielding to the database', async () => {
    const mutableScope = { ...scope };
    const calls: unknown[][] = [];
    const sql = ((_chunks: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values); return Promise.resolve([row()]);
    }) as unknown as Sql;
    const pending = captureContextPackingAttribution(mutableScope, sql);
    mutableScope.workspaceId = 'foreign'; mutableScope.ownerId = 'foreign-owner';
    const result = await pending;
    expect(calls.flat()).not.toContain('foreign'); expect(calls.flat()).not.toContain('foreign-owner');
    expect(result.epochEvidenceRef).toContain('owner-a');
    expect(result.unknown).toEqual([]);
  });
});
describe('context packing evidence', () => {
  const source = (budgetBytes = 40) => {
    const candidates: ContextCandidate[] = [
      { sourceRef: 'owner:1', revision: 'r1', class: 'owner', required: true, text: 'Keep the whole ☃ duty' },
      { sourceRef: 'memory:1', revision: 'r2', class: 'memory', required: false, text: 'An omitted condition '.repeat(20) },
    ];
    const packed = packContextCandidates({ attemptId: 'prepared-1', budgetBytes, candidates,
      carrier: { client: 'codex', port: 'turn-start' } });
    return { packed, preparation: { createdAt: '2026-11-12T15:00:00.000Z', text: packed.text,
      selectedIndexes: packed.selectedIndexes, candidates } };
  };

  it('retains an unknown attempt epoch without replacing it with a later reading or zero', async () => {
    const { packed, preparation } = source();
    const attribution: ContextPackingAttribution = { observedAt: preparation.createdAt, epoch: null, epochEvidenceRef: null,
      nativeSession: null, unknown: ['epoch-unavailable', 'native-session-unavailable'] };
    await saveContextPackingReceipt(scope, packed.receipt, { ...preparation, attribution });
    attribution.epoch = 99;
    expect((await loadContextPackingReceipt(scope, packed.receipt.attemptId))?.preparation?.attribution).toMatchObject({ epoch: null, nativeSession: null });
  });

  it('rejects malformed attribution before storing bytes', async () => {
    const { packed, preparation } = source();
    await expect(saveContextPackingReceipt(scope, packed.receipt, { ...preparation, attribution: {
      observedAt: preparation.createdAt, epoch: 0, epochEvidenceRef: null, nativeSession: null,
      unknown: ['epoch-unavailable', 'native-session-unavailable'],
    } })).rejects.toThrow('source_attribution_invalid');
    expect(artifacts.size).toBe(0);
  });

  it.each([0, 40, 1000])('retains replayable selected and omitted bytes at B=%i without declaring emission', async budgetBytes => {
    const { packed, preparation } = source(budgetBytes);
    const ref = await saveContextPackingReceipt(scope, packed.receipt, preparation);
    expect(await saveContextPackingReceipt(scope, packed.receipt, preparation)).toEqual(ref);
    const stored = await loadContextPackingReceipt(scope, packed.receipt.attemptId);
    expect(stored?.preparation).toEqual({ ...preparation, schemaVersion: 'context-packing-source-v1',
      runtime: { host: 'port-test', processId: null, buildSha: null }, emission: 'UNKNOWN' });
    expect(stored?.preparation?.candidates).toHaveLength(2);
    expect(stored).not.toHaveProperty('receipts');
  });

  it.each(['text', 'candidate', 'selection', 'time', 'scope'] as const)('refuses a mismatched %s source before writing any artifact', async field => {
    const { packed, preparation } = source();
    const inputScope = { ...scope };
    if (field === 'text') preparation.text += ' invented';
    if (field === 'candidate') preparation.candidates[1]!.text = 'different omitted bytes';
    if (field === 'selection') preparation.selectedIndexes = [];
    if (field === 'time') preparation.createdAt = '2026-11-12';
    if (field === 'scope') inputScope.client = 'claude';
    await expect(saveContextPackingReceipt(inputScope, packed.receipt, preparation)).rejects.toThrow('context_packing_source_');
    expect(artifacts.size).toBe(0); expect(indexes.size).toBe(0);
  });

  it('freezes source and receipt before the caller can change an in-flight write', async () => {
    const { packed, preparation } = source();
    const mutableScope = { ...scope };
    const pending = saveContextPackingReceipt(mutableScope, packed.receipt, preparation);
    preparation.candidates[0]!.text = 'late mutation';
    packed.receipt.candidates[0]!.sourceRef = 'late mutation';
    packed.receipt.attemptId = 'late-attempt';
    mutableScope.harness = 'foreign-harness'; mutableScope.ownerId = 'foreign-owner';
    const ref = await pending;
    const saved = JSON.parse(artifacts.get(`${scope.harness}/${ref.sha256}`)!);
    expect(saved.preparation.candidates[0].text).toBe('Keep the whole ☃ duty');
    expect(saved.receipt.candidates[0].sourceRef).toBe('owner:1');
    expect(ref.attemptId).toBe('prepared-1');
    expect((await loadContextPackingReceipt(scope, 'prepared-1'))?.scope).toEqual(scope);
  });

  it.each([0, 1000])('withholds privately granted candidate bytes even when omitted at B=%i', async budgetBytes => {
    const candidates: ContextCandidate[] = [{ sourceRef: 'private:grant', revision: 'private-r1',
      class: 'granted', required: false, text: 'private granted source content' }];
    const packed = packContextCandidates({ attemptId: 'private-attempt', budgetBytes, candidates });
    const ref = await saveContextPackingReceipt(scope, packed.receipt, {
      createdAt: '2026-11-12T15:00:00.000Z', text: packed.text, candidates, selectedIndexes: packed.selectedIndexes,
    });
    const stored = await loadContextPackingReceipt(scope, packed.receipt.attemptId);
    expect(stored?.preparation).toBeUndefined();
    expect(stored?.preparationWithheld).toMatchObject({ reason: 'granted-context', createdAt: '2026-11-12T15:00:00.000Z' });
    expect(artifacts.get(`${scope.harness}/${ref.sha256}`)).not.toContain('private granted source content');
  });

  it('retains a mandatory-overflow receipt keyed by attempt independently of zero context bytes', async () => {
    const receipt = packed();
    const ref = await saveContextPackingReceipt(scope, receipt);
    expect(ref.path).toMatch(/^immutable\/claims\/[a-f0-9]{64}\.json$/);
    expect((await loadContextPackingReceipt(scope, receipt.attemptId))?.receipt).toEqual(receipt);
    expect(await saveContextPackingReceipt(scope, receipt)).toEqual(ref);
    await expect(saveContextPackingReceipt(scope, { ...receipt, budgetBytes: 1 })).rejects.toThrow('attempt_conflict');
    expect((await loadContextPackingReceipt(scope, receipt.attemptId))?.receipt.budgetBytes).toBe(0);
  });

  it('separates recipients and rejects a workspace outside the authenticated context', async () => {
    await saveContextPackingReceipt(scope, packed());
    expect(await loadContextPackingReceipt({ ...scope, ownerId: 'other' }, 'attempt-1')).toBeNull();
    await expect(loadContextPackingReceipt({ ...scope, workspaceId: 'foreign' }, 'attempt-1')).rejects.toThrow('scope_invalid');
  });

  it.each([512, 5999, 6000])('pages the complete ledger including long multibyte identities within D=%i', maxBytes => {
    const receipt = packed();
    receipt.candidates = Array.from({ length: 8 }, (_, index) => ({ ...receipt.candidates[0], index,
      sourceRef: `source-${index}-` + '字'.repeat(2100) }));
    const stored = { scope, receipt };
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    do {
      const pageText = pageContextPackingReceipt(stored, offset, maxBytes);
      expect(Buffer.byteLength(pageText)).toBeLessThanOrEqual(maxBytes);
      const page = JSON.parse(pageText);
      expect(page.offset).toBe(offset);
      chunks.push(Buffer.from(page.data, 'base64'));
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset!);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(stored);
  });
});
