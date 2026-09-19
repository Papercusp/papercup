import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { LocalWriteOp } from './boot';

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
    const native = events.filter((e) => e.stage === 'native-encrypt');
    expect(native.map((e) => [e.event, e.boundary])).toEqual([
      ['hop-start', 'sync'],
      ['hop-end', 'sync'],
    ]);
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
      expect(JSON.stringify(events)).not.toContain('private payload');
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
    expect(starts[0].attemptId).not.toBe(starts[1].attemptId);
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
