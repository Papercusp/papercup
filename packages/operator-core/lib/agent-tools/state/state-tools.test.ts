/**
 * P-004 / D-058 — the TOOL layer of the state plane (`state:read`, `state:subscribe`).
 *
 * `cell-read.test.ts` covers the composition BELOW these tools (`readCell`: dispatch,
 * path projection, the three-way value/unknown/absent split). This suite covers what
 * only exists at the tool boundary, and it is not a formality — `state:subscribe`
 * carries three real gates of its own, and each one fails OPEN if it regresses:
 *
 *   1. the audience check (D-042 / P-028). Subscribing IS reading — it observes the
 *      value on a schedule — so a cell outside the reader's audience must be ABSENT
 *      here too. A regression makes `state:subscribe` a bypass of `canReadCell` that
 *      returns the value one poll later, which is exactly the silent leak D-042 closes.
 *   2. the event-signalled refusal. Registering a poller for a cell that PUSHES would
 *      poll a value that already has a key.
 *   3. caller-relativity (axis 3). Watching a relative cell with no subject is not a
 *      narrower question, it is no question at all.
 *
 * And one POSITIVE contract: the delegation to `watch:create`. R4 says this tool
 * registers nothing itself; the test that keeps it honest is that the cell supplies
 * the (tool, args, path) triple and the caller supplies only the comparator — because
 * the moment a hand-copied path appears here, the transcription defect P-017 (c)
 * detects has been re-introduced at the very surface built to remove it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const watchHandler = vi.fn();
const readCellMock = vi.fn();

// Only `handler` is faked. `watchTool.args` stays REAL so that `state:subscribe`'s
// parse-through (its deliberate choice over hand-building args) keeps failing loudly
// here if watch:create's schema moves — which is the whole point of parsing through it.
vi.mock('../events/watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../events/watch')>();
  return {
    ...actual,
    default: { ...actual.default, handler: (...a: unknown[]) => watchHandler(...a) },
  };
});

vi.mock('../../cell-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cell-read')>();
  return { ...actual, readCell: (...a: unknown[]) => readCellMock(...a) };
});

vi.mock('../coordination/identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/identity')>();
  return {
    ...actual,
    resolveAgentIdentity: () => ({
      ownerId: 'su-me',
      ownerLabel: 'su · me',
      source: 'test',
      workspaceId: 'default',
      userId: null,
    }),
  };
});

import readTool from './read';
import subscribeTool from './subscribe';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from '../../cell-registry';

const CTX = { role: 'su', harnessSlug: 'papercusp', workspaceId: 'default' };

/** A registrable spec — every axis satisfied, so the registry never refuses for a
 *  reason unrelated to what the test under it is about. */
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'positions.deployed',
    falsifier: {
      field: 'serving.startedSinceCodeChange',
      measurement: 'process start time vs code mtime',
      kills: '"deployed ✓" read as "the running process executes my code"',
    },
    nullable: false,
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

type Out = { content: { type: 'text'; text: string }[]; isError?: boolean };
function body(r: unknown): Record<string, unknown> {
  return JSON.parse((r as Out).content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  __resetCellRegistryForTests();
  watchHandler.mockReset();
  watchHandler.mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true,"watch_id":"w1"}' }] });
  readCellMock.mockReset();
});

describe('state:subscribe — gate 1, the audience check (D-042 / P-028)', () => {
  it('refuses a cell outside the reader audience as ABSENT, registering no watch', async () => {
    registerCell(spec({ visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.status).toBe('absent');
    // The leak this prevents: a refusal that still started the poller would deliver the
    // value one wake later, having "refused" it.
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('is a NON-ORACLE: out-of-audience and never-registered are indistinguishable', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const hidden = body(await subscribeTool.handler({ cell: 'narrow.cell', on: { op: 'exists' } } as never, CTX as never));
    const missing = body(await subscribeTool.handler({ cell: 'no.such.cell', on: { op: 'exists' } } as never, CTX as never));

    // Same status AND same message modulo the name — if these ever diverge, a stranger
    // can enumerate the narrow cells by probing, which is the hazard D-042 closes.
    expect(hidden.status).toBe(missing.status);
    expect(String(hidden.error).replace('narrow.cell', 'X')).toBe(String(missing.error).replace('no.such.cell', 'X'));
  });
});

describe('state:subscribe — gate 2, an event-signalled cell is not pollable', () => {
  it('refuses and names the key to await instead of starting a poller', async () => {
    registerCell(spec({ changeSignal: { kind: 'event', key: 'deploy:landed' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.eventKey).toBe('deploy:landed');
    expect(watchHandler).not.toHaveBeenCalled();
  });
});

describe('state:subscribe — gate 3, caller-relativity (axis 3)', () => {
  it('refuses a parameter-relative cell with no subject, naming the missing parameter', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' } } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.missingParam).toBe('path');
    expect(watchHandler).not.toHaveBeenCalled();
  });

  it('passes the subject through as the resolver argument under its declared name', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    await subscribeTool.handler(
      { cell: 'test.cell', on: { op: 'exists' }, as: 'apps/operator/x.ts' } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: { args: Record<string, unknown> } };
    expect(sent.predicate.args).toEqual({ path: 'apps/operator/x.ts' });
  });

  it('treats a blank `as` as missing rather than as a subject', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));

    const b = body(await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' }, as: '   ' } as never, CTX as never));

    expect(b.ok).toBe(false);
    expect(b.missingParam).toBe('path');
  });
});

describe('state:subscribe — R4, it DELEGATES to watch:create and registers nothing', () => {
  it('takes the (tool, args, path) triple from the CELL and only the comparator from the caller', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never);

    expect(watchHandler).toHaveBeenCalledTimes(1);
    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    // The cell is the single source of the triple. A hand-copied path here would be a
    // transcription — the exact defect this tool exists to remove.
    expect(sent.predicate).toEqual({
      tool: 'dev:pipeline_position',
      args: {},
      path: 'positions.deployed',
      op: 'eq',
      value: true,
    });
    expect(sent.wake).toBe(true);
    expect(sent.once).toBe(true); // one-shot default
  });

  it('omits `value` entirely for a valueless operand like `exists`', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'exists' } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    // Not `value: undefined` — a key that exists with an undefined value compares
    // differently in the dedupe path than one that is absent.
    expect('value' in sent.predicate).toBe(false);
  });

  it('passes once:false and interval_sec through to the one registration path', async () => {
    registerCell(spec());

    await subscribeTool.handler(
      { cell: 'test.cell', on: { op: 'gt', value: 3 }, once: false, interval_sec: 120 } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.once).toBe(false);
    expect(sent.interval_sec).toBe(120);
  });
});

describe('state:read — the directory is audience-filtered, not audience-annotated', () => {
  it('OMITS a cell the reader may not see rather than marking it', async () => {
    registerCell(spec({ cell: 'open.cell' }));
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const b = body(await readTool.handler({} as never, CTX as never));

    const names = (b.cells as { cell: string }[]).map((c) => c.cell);
    expect(names).toContain('open.cell');
    // Listing it as "3 cells you may not see" would enumerate exactly what `absent`
    // exists to hide.
    expect(names).not.toContain('narrow.cell');
    expect(b.count).toBe(1);
  });

  it('marks an event-signalled cell as not directly readable', async () => {
    registerCell(spec({ cell: 'polled.cell' }));
    registerCell(spec({ cell: 'pushed.cell', changeSignal: { kind: 'event', key: 'k' } }));

    const b = body(await readTool.handler({} as never, CTX as never));

    const byName = Object.fromEntries((b.cells as { cell: string; readable: boolean }[]).map((c) => [c.cell, c.readable]));
    expect(byName['polled.cell']).toBe(true);
    expect(byName['pushed.cell']).toBe(false);
  });
});

describe('state:read — the unknown stays branchable, and the role fails CLOSED', () => {
  it('renders prose for a human WITHOUT dropping the branchable code', async () => {
    readCellMock.mockResolvedValue({
      status: 'unknown',
      cell: 'test.cell',
      unknown: { code: 'resolver-failed', detail: 'the probe timed out' },
    });

    const b = body(await readTool.handler({ cell: 'test.cell' } as never, CTX as never));

    expect(b.summary).toBe('the probe timed out');
    // Prose cannot be branched on — losing `code` here is the defect cell-contract.ts exists for.
    expect((b.unknown as { code: string }).code).toBe('resolver-failed');
  });

  it('tells an absent reader NOT to reconstruct the value from another surface', async () => {
    readCellMock.mockResolvedValue({ status: 'absent', cell: 'test.cell' });

    const b = body(await readTool.handler({ cell: 'test.cell' } as never, CTX as never));

    expect(String(b.summary)).toMatch(/do NOT reconstruct/i);
  });

  it('passes an EMPTY role when the caller presented none, so the second gate cannot widen', async () => {
    readCellMock.mockResolvedValue({ status: 'value', cell: 'test.cell', value: true });

    await readTool.handler({ cell: 'test.cell' } as never, { harnessSlug: 'papercusp', workspaceId: 'default' } as never);

    const env = readCellMock.mock.calls[0][2] as { role: string };
    // Substituting a real default here (a 'su', say) would widen the resolver's own role
    // gate for a caller who never presented a role — an access default that fails OPEN.
    expect(env.role).toBe('');
  });

  it('forwards the subject to readCell as the fourth argument', async () => {
    readCellMock.mockResolvedValue({ status: 'value', cell: 'test.cell', value: 1 });

    await readTool.handler({ cell: 'test.cell', as: 'su-peer' } as never, CTX as never);

    expect(readCellMock.mock.calls[0][3]).toBe('su-peer');
  });
});
