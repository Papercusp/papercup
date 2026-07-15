import { describe, expect, it } from 'vitest';
import {
  gradeColdBootDrill,
  reportColdBootDrills,
  startColdBootDrill,
  type ColdBootDrillLedgerEvent,
} from './cold-boot-drill-live';
import type { RespawnLaunchSpec } from './carry-respawn';
import type { ReplayTranscript, ReplayTurn } from './replay/types';

const NOW = Date.parse('2026-07-15T06:00:00.000Z');
const HOST = {
  ownerId: 'su-1',
  advSessionId: 'adv-1',
  pid: 10,
  ptyPid: 11,
  sock: '/tmp/su-1.sock',
  command: 'claude',
  startedAt: NOW,
  caps: ['carry-respawn'],
};
const SPEC: RespawnLaunchSpec = {
  systemPromptAddendum: '## Identity\nownerId: su-1\n## Plan state (your claimed / in-flight items)\nWI-4852',
  firstPrompt: null,
  budgetChars: 80_000,
  openOwnerQuestion: { crossesOpenOwnerMessage: false },
};

function startHarness(seed: ColdBootDrillLedgerEvent[] = []) {
  const ledger = [...seed];
  const injected: Array<{ sock: string; msg: Record<string, unknown> }> = [];
  return {
    ledger,
    injected,
    deps: {
      now: () => NOW,
      newId: () => 'drill-1',
      findHost: () => HOST,
      resolveTranscriptPath: async () => '/tmp/current.jsonl',
      resolveEffectiveWindow: async () => 200_000,
      buildBrief: async () => null,
      flushGate: async () => ({ verdict: 'clear' as const, tripwires: [] }),
      buildSpec: async () => SPEC,
      inject: async (sock: string, msg: Record<string, unknown>) => {
        injected.push({ sock, msg });
        return true;
      },
      readLedger: async () => ledger,
      appendLedger: async (event: ColdBootDrillLedgerEvent) => {
        ledger.push(event);
        return true;
      },
    },
  };
}

describe('startColdBootDrill — explicit/default-off live cut', () => {
  it('queues the existing carry-respawn verb with a durable id and grading marker', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1', workspaceId: 'ws', sessionClass: 'claude-su' },
      h.deps,
    );
    expect(result).toMatchObject({ ok: true, drillId: 'drill-1', sessionClass: 'claude-su', queued: true });
    expect(h.ledger.map((event) => event.kind)).toEqual(['carry-drill-requested', 'carry-drill-queued']);
    expect(h.injected).toHaveLength(1);
    expect(h.injected[0]).toMatchObject({
      sock: HOST.sock,
      msg: {
        mode: 'carry-respawn',
        drillId: 'drill-1',
        sessionClass: 'claude-su',
        systemPromptAddendum: SPEC.systemPromptAddendum,
      },
    });
    expect(String(h.injected[0].msg.data)).toContain('⟦carry-drill:drill-1⟧');
    expect(String(h.injected[0].msg.data)).toContain('session:carry-drill { op: "grade"');
  });

  it('rate-limits a second destructive cut from the persisted ledger', async () => {
    const h = startHarness([
      { ts: new Date(NOW - 5 * 60_000).toISOString(), kind: 'carry-drill-queued', drillId: 'prior', ownerId: 'su-1', sessionClass: 'claude-su' },
    ]);
    const result = await startColdBootDrill({ ownerId: 'su-1', ownerLabel: 'su · 1' }, h.deps);
    expect(result).toMatchObject({ ok: false, error: 'drill_rate_limited' });
    expect(h.injected).toHaveLength(0);
  });

  it('honors the flush gate and open-owner gate before registering or cutting', async () => {
    const flush = startHarness();
    const flushResult = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      {
        ...flush.deps,
        flushGate: async () => ({ verdict: 'refuse' as const, tripwires: [{ kind: 'missing-checkpoint' as const, subject: 'WI-1', detail: 'flush it' }], refusalText: 'flush it' }),
      },
    );
    expect(flushResult).toMatchObject({ ok: false, error: 'flush_required' });
    expect(flush.ledger).toEqual([]);

    const owner = startHarness();
    const ownerResult = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...owner.deps, buildSpec: async () => ({ ...SPEC, openOwnerQuestion: { crossesOpenOwnerMessage: true } }) },
    );
    expect(ownerResult).toMatchObject({ ok: false, error: 'open_owner_message' });
    expect(owner.ledger).toEqual([]);
  });

  it('records a socket failure and leaves it out of the active rate-limit set', async () => {
    const h = startHarness();
    const result = await startColdBootDrill(
      { ownerId: 'su-1', ownerLabel: 'su · 1' },
      { ...h.deps, inject: async () => false },
    );
    expect(result).toMatchObject({ ok: false, error: 'carry_respawn_inject_failed' });
    expect(h.ledger.map((event) => event.kind)).toEqual(['carry-drill-requested', 'carry-drill-request-failed']);
  });
});

describe('gradeColdBootDrill — host event + successor transcript', () => {
  const requested: ColdBootDrillLedgerEvent = {
    ts: new Date(NOW).toISOString(),
    kind: 'carry-drill-requested',
    drillId: 'drill-1',
    ownerId: 'su-1',
    sessionClass: 'claude-su',
  };
  const tool = (index: number, toolName: string, input: unknown): ReplayTurn => ({
    index,
    role: 'tool_use',
    toolName,
    text: JSON.stringify(input),
  });
  const transcript: ReplayTranscript = {
    ref: '/tmp/fresh.jsonl',
    backend: 'claude-code',
    turns: [
      { index: 0, role: 'user', text: '⟦carry-drill:drill-1⟧\ncontinue' },
      tool(1, 'coord:orient', { afterCompaction: true }),
      { index: 2, role: 'tool_result', text: '{"recall":[{"text":"facts","similarity":0.03}]}' },
      tool(3, 'work_items:get', { id: 'WI-4852' }),
      tool(4, 'functions.exec', { cmd: 'sed -n 1,40p source.ts' }),
      tool(5, 'session:carry-drill', { op: 'grade', drillId: 'drill-1' }),
    ],
  };

  it('mechanically records only explicit recovery lookups and returns the class report', async () => {
    const ledger = [requested];
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => ledger,
      appendLedger: async (event) => { ledger.push(event); return true; },
      readHostEvents: async () => [{ kind: 'carry-drill-respawned', drillId: 'drill-1', nativeId: 'native-2', launchContextPath: '/safe/carry.md' }],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW + 1000,
    });
    expect(result).toMatchObject({
      ok: true,
      alreadyGraded: false,
      transcriptPath: transcript.ref,
      sample: {
        sessionClass: 'claude-su',
        lookups: [
          { kind: 'orient-recall-fold', targetClass: 'facts', similarity: 0.03 },
          { kind: 'reread-state', targetClass: 'held-wi', recoveredInCarry: true },
        ],
      },
      report: { perClass: [{ sessionClass: 'claude-su', drills: 1, gaps: 0, surfacingGaps: 1, sufficient: false }] },
    });
    expect(ledger.at(-1)?.kind).toBe('carry-drill-graded');
  });

  it('is idempotent once a sample is graded', async () => {
    const graded: ColdBootDrillLedgerEvent = {
      ...requested,
      kind: 'carry-drill-graded',
      lookups: [],
      transcriptPath: transcript.ref,
    };
    let appendCalls = 0;
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested, graded],
      appendLedger: async () => { appendCalls += 1; return true; },
      readHostEvents: async () => [],
      readCarry: async () => null,
      loadTranscript: async () => null,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true, alreadyGraded: true, sample: { lookups: [] } });
    expect(appendCalls).toBe(0);
  });

  it('does not guess when the host has not recorded a successor', async () => {
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested],
      appendLedger: async () => true,
      readHostEvents: async () => [],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, error: 'respawn_not_observed' });
  });

  it('surfaces a durable host preparation failure instead of reporting an ambiguous wait', async () => {
    const result = await gradeColdBootDrill('su-1', 'drill-1', {
      readLedger: async () => [requested],
      appendLedger: async () => true,
      readHostEvents: async () => [{ kind: 'carry-drill-respawn-failed', drillId: 'drill-1', reason: 'argv-build-failed' }],
      readCarry: async () => SPEC.systemPromptAddendum,
      loadTranscript: async () => transcript,
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: false, error: 'respawn_failed' });
  });
});

describe('reportColdBootDrills', () => {
  it('deduplicates drill ids and requires the pinned ten clean samples', async () => {
    const rows: ColdBootDrillLedgerEvent[] = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(NOW + i).toISOString(),
      kind: 'carry-drill-graded',
      drillId: `d-${i}`,
      ownerId: `su-${i}`,
      sessionClass: 'claude-su',
      lookups: [],
    }));
    rows.push({ ...rows[0], ts: new Date(NOW + 99).toISOString() });
    const report = await reportColdBootDrills(async () => rows);
    expect(report.perClass[0]).toMatchObject({ drills: 10, gaps: 0, surfacingGaps: 0, sufficient: true });
    expect(report.sufficientClasses).toEqual(['claude-su']);
  });
});
