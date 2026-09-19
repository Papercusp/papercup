import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LocalWriteOp } from './boot';
import type { StageDiagnosticName } from './stage-stall-log';

const seams = vi.hoisted(() => {
  let releaseNative!: () => void;
  const nativeReady = new Promise<void>((resolve) => {
    releaseNative = resolve;
  });
  return {
    scope: vi.fn(),
    sql: vi.fn(),
    keychain: vi.fn(),
    nativeReady,
    releaseNative,
    // Permanent test-only mutants: never edit the swept production tree to
    // demonstrate that a regression assertion can actually reject bad behavior.
    fault: null as null | 'collapse-attempts' | 'premature-native' | 'sync-as-await' | 'leak-payload',
    omitStage: null as StageDiagnosticName | null,
  };
});
vi.mock('./stage-stall-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stage-stall-log')>();
  return {
    ...actual,
    createStageAttempt: (options: Parameters<typeof actual.createStageAttempt>[0]) =>
      actual.createStageAttempt({
        ...options,
        onEvent: options.onEvent && ((event) => options.onEvent!({
          ...event,
          ...(seams.fault === 'collapse-attempts' ? { attemptId: 'same-attempt' } : {}),
          ...(seams.fault === 'sync-as-await' && event.boundary === 'sync' ? { boundary: 'await' as const } : {}),
          ...(seams.fault === 'leak-payload' ? { payload: 'private payload' } : {}),
        })),
      }),
    traceStageAwait: <T>(stage: StageDiagnosticName, run: () => PromiseLike<T>) => {
      if (seams.fault === 'premature-native' && stage === 'epoch-query') {
        actual.currentStageAttempt()?.begin('native-encrypt', 'sync');
      }
      return stage === seams.omitStage ? run() : actual.traceStageAwait(stage, run);
    },
  };
});
vi.mock('../../federated-pot-scope', () => ({ resolveFederatedPotScope: seams.scope }));
vi.mock('../../identity/keychain', () => ({
  keychainLoad: seams.keychain,
  keychainStore: vi.fn(),
}));
vi.mock('sodium-native', async (importOriginal) => {
  await seams.nativeReady;
  const actual = await importOriginal<typeof import('sodium-native')>();
  const sodium = (actual as unknown as { default?: typeof actual }).default ?? actual;
  // Fixed nonce is ONLY a test fixture: the real native AEAD still runs, so two
  // diagnostic modes must produce identical ciphertext for the same key and AAD.
  return { default: { ...sodium, randombytes_buf: (out: Buffer) => out.fill(7) } };
});

import { createStageAttempt, withStageAttempt, type StageAttempt, type StageDiagnosticEvent } from './stage-stall-log';
import { buildEpochEncryptCapability, buildEpochKeyResolver } from './hive-epoch-op-gate';
import { createHiveEpochCrypto } from './hive-epoch-crypto-impl';
import { getHiveEpoch } from './hive-epoch-state';
import { buildOpAAD } from './hive-epoch-serving';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import { drainOutboxOnce } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';
import * as epochState from './hive-epoch-state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const attempts: StageAttempt[] = [];
function observation(rowId = 1, sink?: 'disabled' | 'throwing') {
  const events: StageDiagnosticEvent[] = [];
  const attempt = createStageAttempt({
    rowId,
    enabled: sink !== 'disabled',
    onEvent: (event) => {
      if (sink === 'throwing') throw new Error('observer failed');
      events.push(event);
    },
  });
  attempts.push(attempt);
  return { attempt, events };
}
const starts = (events: StageDiagnosticEvent[]) => events.filter((e) => e.event === 'hop-start').map((e) => e.stage);
function assertPendingOnly(events: StageDiagnosticEvent[], stage: StageDiagnosticName) {
  expect(starts(events), `missing actual pending stage: ${stage}`).toContain(stage);
  expect(starts(events), `premature serialization while ${stage} is pending`).not.toContain('serialize');
  expect(starts(events), `premature native work while ${stage} is pending`).not.toContain('native-encrypt');
}
function assertUniqueAttempts(events: StageDiagnosticEvent[]) {
  const ids = events.filter((event) => event.event === 'attempt-start').map((event) => event.attemptId);
  expect(ids, 'two attempts actually ran').toHaveLength(2);
  expect(new Set(ids).size, 'retry identities must be distinct').toBe(2);
}
function assertNativeBoundary(events: StageDiagnosticEvent[]) {
  expect(events.filter((event) => event.stage === 'native-encrypt').map((event) => [event.event, event.boundary]),
    'native boundaries must remain synchronous').toEqual([['hop-start', 'sync'], ['hop-end', 'sync']]);
}
function assertPrivate(events: StageDiagnosticEvent[]) {
  expect(JSON.stringify(events), 'diagnostics must not retain plaintext').not.toContain('private payload');
}
// Expose the same wrong-behavior assertion to the runner for a deliberate red
// probe. Normal CI requires the exact rejection. This never changes production
// source, and a test-name filter never changes a test's behavior.
function rejectsWrong(check: () => void, message: string) {
  if (process.env.PAPERCUSP_P002_RED_CONTROL === '1') check();
  else expect(check).toThrow(message);
}
const op: LocalWriteOp = {
  type: 'put',
  table: 'features-by-id',
  hbKey: 'F-secret',
  ts: 1,
  writerPubkey: 'author',
  schema_version: 1,
  value: { title: 'private payload' },
};
const key = Buffer.alloc(32, 4);
function makeGate(
  options: {
    owner?: () => Promise<boolean>;
    provider?: () => Promise<never>;
    epoch?: number;
    baseline?: () => Promise<boolean>;
  } = {},
) {
  const crypto = createHiveEpochCrypto();
  const resolveKey = buildEpochKeyResolver({
    crypto,
    isOwner: options.owner ?? (async () => true),
    provider: {
      keyForEpoch:
        options.provider ??
        (async () => {
          throw new Error('provider miss');
        }),
    },
  });
  const cap = buildEpochEncryptCapability({
    crypto,
    resolveKey,
    potId: 'diagnostic-pot',
    getCurrentEpoch: () =>
      options.epoch === undefined
        ? getHiveEpoch('diagnostic-ws', 'diagnostic-pot', { unsafe: seams.sql } as unknown as Sql)
        : Promise.resolve(options.epoch),
    hasRekeyEvidence: options.baseline,
  });
  return { cap, crypto };
}
beforeEach(() => {
  seams.fault = null;
  seams.omitStage = null;
  seams.scope.mockReset().mockResolvedValue('diagnostic-pot');
  seams.sql.mockReset().mockResolvedValue([
    {
      workspace_id: 'diagnostic-ws',
      harness_slug: 'diagnostic-pot',
      setting_key: 'epoch',
      value: '3',
      created_at: 1,
      updated_at: 1,
    },
  ]);
  seams.keychain.mockReset().mockResolvedValue({ kind: 'ok', value: key });
});
afterEach(() => {
  for (const attempt of attempts.splice(0)) attempt.finish();
  seams.fault = null;
  seams.omitStage = null;
  vi.restoreAllMocks();
});

describe('P-002 actual encrypt dependencies with local diagnostic context', () => {
  it('holds the actual native import before any synchronous native encryption', async () => {
    const { attempt, events } = observation();
    const { cap } = makeGate();
    const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
    try {
      await vi.waitFor(() => expect(starts(events)).toContain('native-loader'));
      expect(starts(events)).not.toContain('native-encrypt');
      expect(attempt.snapshot().activeHops.map((hop) => hop.stage)).toContain('native-loader');
    } finally {
      seams.releaseNative();
    }
    expect((await pending)?.epoch).toBe(3);
    assertNativeBoundary(events);
  });

  it.each(['scope-query', 'epoch-query'] as const)(
    'holds %s without reporting unreached key or crypto work',
    async (stage) => {
      const held = deferred<unknown>();
      const expectedRows = [
        {
          workspace_id: 'diagnostic-ws',
          harness_slug: 'diagnostic-pot',
          setting_key: 'epoch',
          value: '3',
          created_at: 1,
          updated_at: 1,
        },
      ];
      (stage === 'scope-query' ? seams.scope : seams.sql).mockReturnValueOnce(held.promise);
      const { cap } = makeGate();
      const { attempt, events } = observation();
      const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
      try {
        await vi.waitFor(() => expect(attempt.snapshot().activeHops.map((h) => h.stage)).toContain(stage));
        assertPendingOnly(events, stage);
        expect(starts(events)).not.toContain('owner-check');
        expect(starts(events)).not.toContain('native-loader');
        expect(starts(events)).not.toContain('native-encrypt');
        if (stage === 'scope-query') expect(seams.sql).not.toHaveBeenCalled();
      } finally {
        held.resolve(stage === 'scope-query' ? 'diagnostic-pot' : expectedRows);
      }
      await pending;
    },
  );

  it('holds baseline evidence and preserves the fail-closed rejection', async () => {
    const held = deferred<boolean>();
    const { cap } = makeGate({ epoch: 0, baseline: () => held.promise });
    const { attempt, events } = observation();
    const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
    const rejected = expect(pending).rejects.toBeInstanceOf(EpochKeyUnavailableError);
    try {
      await vi.waitFor(() => expect(starts(events)).toContain('baseline-evidence'));
      assertPendingOnly(events, 'baseline-evidence');
      expect(starts(events)).not.toContain('owner-check');
      expect(starts(events)).not.toContain('serialize');
    } finally {
      held.resolve(true);
    }
    await rejected;
  });

  it.each(['owner-check', 'key-provider', 'keychain'] as const)(
    'holds %s independently without starting serialization',
    async (stage) => {
      const held = deferred<never>();
      const { cap } = makeGate({
        owner: stage === 'owner-check' ? () => held.promise : undefined,
        provider: stage === 'key-provider' ? () => held.promise : undefined,
      });
      if (stage === 'keychain') seams.keychain.mockReturnValueOnce(held.promise);
      const { attempt, events } = observation();
      const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
      try {
        await vi.waitFor(() => expect(attempt.snapshot().activeHops.map((h) => h.stage)).toContain(stage));
        assertPendingOnly(events, stage);
        expect(starts(events)).not.toContain('serialize');
        expect(starts(events)).not.toContain('native-encrypt');
      } finally {
        held.resolve(
          (stage === 'owner-check' ? true : stage === 'key-provider' ? key : { kind: 'ok', value: key }) as never,
        );
      }
      await pending;
    },
  );

  it('keeps ciphertext and AAD identical with enabled, disabled and throwing consumers', async () => {
    const outputs = [];
    for (const sink of [undefined, 'disabled', 'throwing'] as const) {
      const { cap, crypto } = makeGate();
      const { attempt, events } = observation(42, sink);
      const result = await withStageAttempt(attempt, () => cap.encryptOp(op));
      attempt.finish();
      outputs.push(result);
      const ciphertext = Buffer.from((result!.value as { __rekey: string }).__rekey, 'base64');
      const aad = buildOpAAD('diagnostic-pot', 3, {
        tableTag: op.table,
        rowKey: op.hbKey,
        authorPubkey: op.writerPubkey,
      });
      expect(Buffer.from(await crypto.decryptOp(ciphertext, key as never, aad)).toString()).toBe(
        JSON.stringify(op.value),
      );
      await expect(crypto.decryptOp(ciphertext, key as never, { ...aad, opId: 'wrong-row' })).rejects.toThrow();
      assertPrivate(events);
      expect(JSON.stringify(events)).not.toContain('SELECT');
      if (sink) expect(events).toEqual([]);
    }
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
    expect(Object.keys(outputs[0]!)).toEqual(['epoch', 'value']);
  });

  it('retries the actual outbox and encrypt gate with distinct identities and identical authenticated operations', async () => {
    const original = new Error('append failed');
    let drained = false;
    const row = {
      id: 22,
      table_name: 'harness_features_consolidated',
      op: 'put',
      key: 'F-secret',
      ts: 1,
      op_hlc: null,
      row: {
        workspace_id: 'diagnostic-ws',
        harness_slug: 'diagnostic-pot',
        feature_id: 'F-secret',
        title: 'private payload',
        summary: '',
        status: 'todo',
        attempts: 0,
        ts: 1,
        created_ts: 1,
        updated_ts: 1,
      },
    };
    const pg = ((strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('WITH priority AS')) return Promise.resolve(drained ? [] : [row]);
      if (query.includes('UPDATE harness_shared.substrate_outbox')) drained = true;
      return Promise.resolve([]);
    }) as unknown as Sql;
    const operations: LocalWriteOp[] = [];
    const append = vi.fn(async (value: LocalWriteOp) => {
      operations.push(value);
      if (operations.length === 1) throw original;
    });
    const handle = {
      workspaceId: 'diagnostic-ws',
      harnessSlug: 'diagnostic-pot',
      append,
    } as unknown as BootedHarnessHandle;
    const events: StageDiagnosticEvent[] = [];
    const { cap } = makeGate();
    const options = {
      epochEncrypt: cap,
      onDiagnosticEvent: (event: StageDiagnosticEvent) => {
        events.push(event);
      },
    };
    await expect(drainOutboxOnce(handle, pg, options)).rejects.toBe(original);
    expect(drained).toBe(false);
    await expect(drainOutboxOnce(handle, pg, options)).resolves.toBe(1);
    const starts = events.filter((event) => event.event === 'attempt-start');
    expect(starts).toHaveLength(2);
    assertUniqueAttempts(events);
    expect(starts.map((event) => event.rowId)).toEqual(['22', '22']);
    expect(operations[1]).toEqual(operations[0]);
    expect(JSON.stringify(operations)).not.toContain(starts[0].attemptId);
    expect(events.filter((event) => event.event === 'attempt-end').map((event) => event.outcome)).toEqual([
      'rejected',
      'fulfilled',
    ]);
  });

  it('invalidates a shared load by generation and measures TTL from completion with diagnostics enabled', async () => {
    let generation = 0;
    vi.spyOn(epochState, 'getEpochGeneration').mockImplementation(() => generation);
    let now = 100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const firstLoad = deferred<number>();
    const getCurrentEpoch = vi.fn().mockReturnValueOnce(firstLoad.promise).mockResolvedValue(4);
    const crypto = createHiveEpochCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: async () => key as never,
      potId: 'diagnostic-pot',
      workspaceId: 'diagnostic-ws',
      getCurrentEpoch,
    });
    const first = observation(1),
      second = observation(2);
    const pending = withStageAttempt(first.attempt, () => cap.encryptOp(op));
    generation = 1;
    expect((await withStageAttempt(second.attempt, () => cap.encryptOp(op)))?.epoch).toBe(4);
    now += 10_000;
    firstLoad.resolve(3);
    await pending;
    // The old load's late completion cannot replace generation 1's cached epoch.
    expect((await withStageAttempt(second.attempt, () => cap.encryptOp(op)))?.epoch).toBe(4);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(3);
    now += 4_999;
    await withStageAttempt(second.attempt, () => cap.encryptOp(op));
    expect(getCurrentEpoch).toHaveBeenCalledTimes(3);
    now += 1;
    await withStageAttempt(second.attempt, () => cap.encryptOp(op));
    expect(getCurrentEpoch).toHaveBeenCalledTimes(4);
  });
});

describe('P-002 calibrated counterexamples (local diagnostic proof only)', () => {
  // Same assertions as the production-entry tests above. Each wrong behavior
  // is injected only at the diagnostic module boundary, while the real gate,
  // settings and crypto path still execute. This proves the oracle detects
  // these named faults; it is not a claim about live runtime causality.
  it('rejects diagnostic identity entering authenticated bytes at the real crypto seam', async () => {
    seams.releaseNative();
    const control = makeGate();
    const expected = await control.cap.encryptOp(op);
    const aad = buildOpAAD('diagnostic-pot', 3, {
      tableTag: op.table,
      rowKey: op.hbKey,
      authorPubkey: op.writerPubkey,
    });
    for (const faulty of [false, true]) {
      const { cap, crypto } = makeGate();
      const { attempt, events } = observation(42);
      // Wrong implementation at the actual dependency seam, not a modified
      // result fixture: encrypt with local diagnostic identity in the AAD.
      // The real native AEAD still executes, with the fixed test nonce above.
      if (faulty) {
        const encrypt = crypto.encryptOp.bind(crypto);
        vi.spyOn(crypto, 'encryptOp').mockImplementation((payload, epochKey, associated) =>
          encrypt(payload, epochKey, { ...associated, opId: attempt.context.attemptId }),
        );
      }
      const result = await withStageAttempt(attempt, () => cap.encryptOp(op));
      attempt.finish();
      const ciphertext = Buffer.from((result!.value as { __rekey: string }).__rekey, 'base64');
      const unchanged = () => {
        expect(result, 'diagnostics must preserve authenticated operation bytes').toEqual(expected);
      };
      if (faulty) {
        // An independent decrypt under the original row identity confirms the
        // mutation really changed authentication, before testing the oracle.
        await expect(crypto.decryptOp(ciphertext, key as never, aad)).rejects.toThrow();
        rejectsWrong(unchanged, 'diagnostics must preserve authenticated operation bytes');
      } else {
        expect(unchanged).not.toThrow();
        expect(Buffer.from(await crypto.decryptOp(ciphertext, key as never, aad)).toString())
          .toBe(JSON.stringify(op.value));
      }
      assertPrivate(events);
    }
  });

  it.each([
    ['collapse-attempts', assertUniqueAttempts, 'retry identities must be distinct'],
    ['sync-as-await', assertNativeBoundary, 'native boundaries must remain synchronous'],
    ['leak-payload', assertPrivate, 'diagnostics must not retain plaintext'],
  ] as const)('rejects %s and accepts the production path with the same assertion', async (fault, check, message) => {
    seams.releaseNative();
    async function exercise() {
      const { cap } = makeGate();
      const first = observation(22);
      const second = observation(22);
      await withStageAttempt(first.attempt, () => cap.encryptOp(op));
      await withStageAttempt(second.attempt, () => cap.encryptOp(op));
      first.attempt.finish();
      second.attempt.finish();
      return fault === 'collapse-attempts' ? [...first.events, ...second.events] : first.events;
    }
    const good = await exercise();
    expect(() => check(good)).not.toThrow();
    seams.fault = fault;
    const bad = await exercise();
    rejectsWrong(() => check(bad), message);
  });

  it.each(['scope-query', 'epoch-query', 'baseline-evidence', 'owner-check', 'key-provider', 'keychain'] as const)(
    'rejects an omitted %s label at the real held dependency, not merely an empty fixture',
    async (stage) => {
      seams.releaseNative();
      for (const omitted of [false, true]) {
        const held = deferred<unknown>();
        const entered = deferred<void>();
        const wait = () => {
          entered.resolve();
          return held.promise;
        };
        if (stage === 'scope-query') seams.scope.mockImplementationOnce(wait);
        if (stage === 'epoch-query') seams.sql.mockImplementationOnce(wait);
        if (stage === 'keychain') seams.keychain.mockImplementationOnce(wait);
        const { cap } = makeGate({
          ...(stage === 'baseline-evidence' ? { epoch: 0, baseline: () => wait() as Promise<boolean> } : {}),
          ...(stage === 'owner-check' ? { owner: () => wait() as Promise<boolean> } : {}),
          ...(stage === 'key-provider' ? { provider: () => wait() as Promise<never> } : {}),
        });
        seams.omitStage = omitted ? stage : null;
        const { attempt, events } = observation();
        const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
        try {
          // Reaching the BUSINESS seam establishes the held point independently
          // of the diagnostic whose correctness is being tested.
          await entered.promise;
          if (omitted) {
            rejectsWrong(() => assertPendingOnly(events, stage), `missing actual pending stage: ${stage}`);
          } else {
            expect(() => assertPendingOnly(events, stage)).not.toThrow();
          }
        } finally {
          held.resolve(stage === 'scope-query' ? 'diagnostic-pot'
            : stage === 'epoch-query' ? [{ value: '3' }]
            : stage === 'baseline-evidence' ? false
            : stage === 'owner-check' ? true
            : stage === 'key-provider' ? key
            : { kind: 'ok', value: key });
          await pending;
          attempt.finish();
        }
      }
    },
  );

  it('rejects premature native attribution while the actual epoch query is still held', async () => {
    seams.releaseNative();
    for (const faulty of [false, true]) {
      const held = deferred<unknown>();
      const entered = deferred<void>();
      seams.sql.mockImplementationOnce(() => {
        entered.resolve();
        return held.promise;
      });
      const { cap } = makeGate();
      seams.fault = faulty ? 'premature-native' : null;
      const { attempt, events } = observation();
      const pending = withStageAttempt(attempt, () => cap.encryptOp(op));
      try {
        await entered.promise;
        if (faulty) {
          rejectsWrong(() => assertPendingOnly(events, 'epoch-query'), 'premature native work');
        } else {
          expect(() => assertPendingOnly(events, 'epoch-query')).not.toThrow();
        }
      } finally {
        held.resolve([{ value: '3' }]);
        await pending;
        attempt.finish();
      }
    }
  });

  it('rejects a per-row gate that loses single-flight and accepts one genuinely shared load', async () => {
    seams.releaseNative();
    for (const faulty of [false, true]) {
      const held = deferred<number>();
      const getCurrentEpoch = vi.fn(() => held.promise);
      const deps = { crypto: createHiveEpochCrypto(), resolveKey: async () => key as never,
        potId: 'diagnostic-pot', getCurrentEpoch };
      const shared = buildEpochEncryptCapability(deps);
      // Deliberately wrong construction: rebuilding the gate per row discards
      // the cache/single-flight state. The real gate itself remains untouched.
      const encrypt = () => (faulty ? buildEpochEncryptCapability(deps) : shared).encryptOp(op);
      const first = observation(1), second = observation(2);
      const a = withStageAttempt(first.attempt, encrypt);
      const b = withStageAttempt(second.attempt, encrypt);
      const assertShared = () => {
        expect(getCurrentEpoch.mock.calls.length, 'one actual epoch lookup for concurrent rows').toBe(1);
        const aLoad = first.events.find((e) => e.event === 'cache' && e.stage === 'epoch-load');
        const bLoad = second.events.find((e) => e.event === 'cache' && e.stage === 'epoch-load');
        expect(aLoad?.cacheState).toBe('miss');
        expect(bLoad?.cacheState).toBe('shared');
        expect(aLoad?.sharedWorkId).toBeTypeOf('string');
        expect(bLoad?.sharedWorkId).toBe(aLoad?.sharedWorkId);
        assertUniqueAttempts([...first.events, ...second.events]);
      };
      try {
        if (faulty) rejectsWrong(assertShared, 'one actual epoch lookup for concurrent rows');
        else expect(assertShared).not.toThrow();
      } finally {
        held.resolve(3);
        await Promise.all([a, b]);
        first.attempt.finish();
        second.attempt.finish();
      }
      if (!faulty) {
        const hit = observation(3);
        await withStageAttempt(hit.attempt, encrypt);
        expect(getCurrentEpoch).toHaveBeenCalledTimes(1);
        expect(hit.events).toContainEqual(expect.objectContaining({ event: 'cache', stage: 'epoch-load', cacheState: 'hit' }));
        expect(starts(hit.events)).not.toContain('epoch-load');
        hit.attempt.finish();
      }
    }
  });
});
