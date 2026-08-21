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
import { SU_ROLES } from '@papercusp/agent-mcp';
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

    // Same status, same machine CODE, AND same prose modulo the name — if any of these
    // diverge, a stranger can enumerate the narrow cells by probing, which is the hazard
    // D-042 closes. The prose is compared via `reason`: `error` now carries a fixed code
    // (P-004), so asserting on it alone would pass for two refusals whose MESSAGES differ,
    // which is precisely the leak this test exists to catch.
    expect(hidden.status).toBe(missing.status);
    expect(hidden.error).toBe(missing.error);
    expect(String(hidden.reason).replace('narrow.cell', 'X')).toBe(String(missing.reason).replace('no.such.cell', 'X'));
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

describe('P-021 — state:subscribe never applies materiality silently', () => {
  const withMateriality = () =>
    spec({
      materiality: {
        path: 'serving.startedSinceCodeChange',
        why: 'the headline follows every commit; this is the question the caller actually has.',
      },
    });

  it('DEFAULTS to the headline path — an existing subscription is unchanged', async () => {
    registerCell(withMateriality());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'eq', value: true } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: { path: string } };
    expect(sent.predicate.path).toBe('positions.deployed');
  });

  it('watches the MATERIALITY path only when explicitly asked', async () => {
    registerCell(withMateriality());

    await subscribeTool.handler(
      { cell: 'test.cell', of: 'material', on: { op: 'eq', value: false } } as never,
      CTX as never,
    );

    const sent = watchHandler.mock.calls[0][0] as { predicate: { path: string }; note: string };
    expect(sent.predicate.path).toBe('serving.startedSinceCodeChange');
    expect(sent.note).toContain('material');
  });

  it('⚠ REFUSES `of:material` on a cell that declares none — never a silent fallback', async () => {
    // The failure this prevents is concrete and severe. Silently re-pointing a
    // caller's condition at a different path does not narrow it, it evaluates it
    // against a DIFFERENT DOMAIN: `{op:'ne', value:'<a sha>'}` aimed at a boolean
    // is true on the first poll, so the agent is woken instantly and told it was
    // a material change. A wake is an interrupt (D-044), and a spurious one is a
    // false all-clear that resumes an agent on a condition never established.
    registerCell(spec());

    const b = body(
      await subscribeTool.handler({ cell: 'test.cell', of: 'material', on: { op: 'exists' } } as never, CTX as never),
    );

    expect(b.ok).toBe(false);
    // The EXPLANATION lives in `reason`; `error` is the machine code the telemetry
    // groups by (P-004). Both are asserted so neither can quietly go missing.
    expect(b.error).toBe('no_materiality');
    expect(String(b.reason)).toContain('no materiality');
    expect(b.watchedPath).toBe('positions.deployed');
    expect(watchHandler).not.toHaveBeenCalled();
  });
});

/**
 * state-plane-adoption-2026-08-02 P-003 / D-005. Every registered cell is a
 * release-pipeline cell, so the role that repairs a red gate must be able to read them
 * and to wait on them. This guards a silent re-narrowing (the same guard
 * dev:pipeline_position keeps over its own allowlist) AND the specific wrong fix:
 * granting reach by adding release-fixer to SU_ROLES would redefine the fleet
 * capability-cutover set (cutover-role-parity.test.ts asserts FLEET_CAPABILITY_ROLES ≡
 * SU_ROLES ∪ {cup}) and confine the role's native file-read/edit/git.
 */
describe('state plane reach — release-fixer (P-003)', () => {
  it('can reach BOTH state tools; reading a cell you cannot wait on is a half-open door', () => {
    expect(new Set(readTool.agentRoles ?? []).has('release-fixer')).toBe(true);
    expect(new Set(subscribeTool.agentRoles ?? []).has('release-fixer')).toBe(true);
  });

  it('is granted at the USE SITE, never by widening SU_ROLES', () => {
    expect((SU_ROLES as readonly string[]).includes('release-fixer')).toBe(false);
  });

  /** The allowlists must not drift apart — that is what produced the half-open door. */
  it('keeps the two allowlists identical', () => {
    expect(new Set(readTool.agentRoles ?? [])).toEqual(new Set(subscribeTool.agentRoles ?? []));
  });
});

/**
 * P-004 — `on` is optional and defaults to `changed`.
 *
 * Measured over all 300 state:subscribe calls in this workspace: 50 failed, and 23 of
 * those 50 were this one intent. 12 passed no `on` at all; 11 invented a spelling for
 * it ('change' / 'changes' / 'changed'). The cells involved were almost entirely
 * `gate.greenCheckpoint.verdict` and `deploy.3070.sha` — the pipeline waits the repo
 * guide itself sends agents here for.
 */
describe('state:subscribe — omitting `on` means "wake me when it moves" (P-004)', () => {
  it('registers op `changed` with NO operand when `on` is omitted', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.op).toBe('changed');
    // The absence of `value` is the whole point: nothing was transcribed, so there is
    // no stale-operand window between the caller's read and this registration.
    expect('value' in sent.predicate).toBe(false);
  });

  it('still takes the resolver triple from the CELL, not from the caller', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell' } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate).toEqual({
      tool: 'dev:pipeline_position',
      args: {},
      path: 'positions.deployed',
      op: 'changed',
    });
  });

  it('does NOT override an explicit `on` — a real threshold still wins', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'gt', value: 3 } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as { predicate: Record<string, unknown> };
    expect(sent.predicate.op).toBe('gt');
    expect(sent.predicate.value).toBe(3);
  });

  it('accepts `changed` passed explicitly, and its auto-note names the op', async () => {
    registerCell(spec());

    await subscribeTool.handler({ cell: 'test.cell', on: { op: 'changed' } } as never, CTX as never);

    const sent = watchHandler.mock.calls[0][0] as Record<string, unknown>;
    expect((sent.predicate as Record<string, unknown>).op).toBe('changed');
    // No trailing operand in the human-readable note either — "changed null" would
    // read as "compared against null", which is not what happened.
    expect(sent.note).toBe('cell test.cell changed');
  });

  it('the tool schema accepts a call with no `on` at all', () => {
    // The guarantee is at the SCHEMA, not just the handler: a required `on` would
    // reject these 12 calls before the handler ever ran.
    expect(subscribeTool.args.safeParse({ cell: 'test.cell' }).success).toBe(true);
    expect(subscribeTool.args.safeParse({ cell: 'test.cell', on: { op: 'changed' } }).success).toBe(true);
  });
});

/**
 * P-004 — every refusal carries a MACHINE code, not a prose sentence.
 *
 * The dispatcher lifts a refusal's `error` field verbatim into
 * `tool_invocations.error_code` (extractRefusalCode, truncated at 80 chars). This tool
 * used to put full sentences there, so every refusal produced a unique unqueryable
 * "code" and the failure taxonomy above had to be reconstructed by hand from
 * error_message prose plus args_json. A distinct short code per class makes it one query.
 */
describe('state:subscribe — refusal codes are queryable (P-004)', () => {
  const codeFor = async (args: Record<string, unknown>, cellSpec: Parameters<typeof registerCell>[0]) => {
    registerCell(cellSpec);
    return body(await subscribeTool.handler(args as never, CTX as never));
  };

  it('cell_absent — out of audience or unregistered', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ visibility: { kind: 'owner', ref: 'su-someone-else' } }));
    expect(b.error).toBe('cell_absent');
    expect(b.reason).toMatch(/subscribable by you/);
  });

  it('cell_event_signalled — the cell pushes, so it has a key', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ changeSignal: { kind: 'event', key: 'deploy:landed' } }));
    expect(b.error).toBe('cell_event_signalled');
    expect(b.eventKey).toBe('deploy:landed');
  });

  it('subject_required — a caller-relative cell with no `as`', async () => {
    const b = await codeFor({ cell: 'test.cell' }, spec({ callerRelativity: { kind: 'parameter', param: 'path' } }));
    expect(b.error).toBe('subject_required');
    expect(b.missingParam).toBe('path');
  });

  it('no_materiality — of:"material" on a cell that declares none', async () => {
    const b = await codeFor({ cell: 'test.cell', of: 'material' }, spec());
    expect(b.error).toBe('no_materiality');
    expect(b.reason).toMatch(/declares no materiality path/);
  });

  it('every code is short, snake_case and stable — i.e. actually groupable in SQL', async () => {
    const codes = ['cell_absent', 'cell_event_signalled', 'subject_required', 'no_materiality'];
    for (const c of codes) {
      // 80 is REFUSAL_CODE_MAX in dispatch-stack.ts; a longer code arrives truncated,
      // which silently splits one class into several rows in the taxonomy query.
      expect(c.length).toBeLessThanOrEqual(80);
      expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });
});
