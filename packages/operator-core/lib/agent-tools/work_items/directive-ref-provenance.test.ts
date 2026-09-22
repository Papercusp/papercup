/**
 * P-005 of plan `directive-visibility-and-ownership-2026-09-22` — owner-directive
 * provenance on the WRITE side.
 *
 * Migration 1194 added `harness_shared.work_items.directive_ref` and P-006's
 * derivation reads it, but for a long window NOTHING COULD WRITE IT through an
 * agent-facing surface: the column existed, the reader existed, and both tools
 * named in P-005's acceptance ignored the field. The turn-start Orientation
 * banner meanwhile instructs agents in so many words — "to take it,
 * work_items:create { directiveRef: N } first" — to pass a parameter that did
 * not exist, which `.strict()` would have rejected outright. That is the exact
 * failure this suite pins: an INSTRUCTION and the PARAMETER it names shipping
 * apart, where each half looks finished on its own.
 *
 * Two families here, deliberately:
 *   1. SCHEMA — both tools ACCEPT the field (and refuse a nonsense value).
 *      `.strict()` makes a successful parse load-bearing evidence: an unknown
 *      key is a loud error, so a parse that survives proves the key is declared
 *      rather than tolerated.
 *   2. BEHAVIOUR — `work_items:claim` binds only AFTER the claim lands, never on
 *      a failed claim, and a conflicting bind still claims while reporting it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));
// Same reason as claim.checkpoint-hint.test.ts: the source-citation leg reads the
// real TREE via `git grep` for the claimed id, which no fixture controls.
vi.mock('../../source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: vi.fn(async () => null),
}));
// PARTIAL mock (importOriginal), never a hand-listed factory — a factory returns
// `undefined` for any export claim.ts imports but the list forgot, and the tool
// then crashes on it rather than failing the assertion under test.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
  bindWorkItemDirectiveRef: vi.fn(),
}));
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));

import { bindWorkItemDirectiveRef, claimWorkItem, getWorkItem } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const bindM = vi.mocked(bindWorkItemDirectiveRef);

const claimTool = (await import('./claim')).default;
const createTool = (await import('./create')).default;

type Out = { data: any };
const claimBody = async (args: unknown) =>
  ((await claimTool.handler(args as never, {} as never)) as Out).data;

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  // Typed fixtures throughout (no `as never`): a new required field on WorkItem
  // or BindDirectiveRefResult should be a compile error HERE, not a runtime
  // failure at some peer's green-checkpoint.
  mockImplementationTyped(claimM, async (id) => workItemFixture({ id, harness: 'papercusp', assignee: 'me' }));
  mockResolvedTyped(getWorkItemM, null);
  mockResolvedTyped(bindM, { ok: true, changed: true });
});

describe('P-005 schema: both named tools ACCEPT directiveRef', () => {
  it('work_items:create takes directiveRef on the inline create', () => {
    const parsed = createTool.args.parse({ kind: 'task', title: 't', directiveRef: 125 }) as {
      directiveRef?: number;
    };
    expect(parsed.directiveRef).toBe(125);
  });

  it('work_items:create takes directiveRef per item in a bulk create', () => {
    const parsed = createTool.args.parse({
      items: [
        { kind: 'task', title: 'a', directiveRef: 125 },
        { kind: 'task', title: 'b' },
      ],
    }) as { items: Array<{ directiveRef?: number }> };
    expect(parsed.items[0].directiveRef).toBe(125);
    // Omitted stays omitted — zero linked work-items is the healthy default, so
    // the field must never acquire a fabricated value on the way through.
    expect(parsed.items[1].directiveRef).toBeUndefined();
  });

  it('work_items:claim takes directiveRef at the top level and per item', () => {
    const inline = claimTool.args.parse({ id: 'WI-1', directiveRef: 7 }) as { directiveRef?: number };
    expect(inline.directiveRef).toBe(7);
    const bulk = claimTool.args.parse({ items: [{ id: 'WI-1', directiveRef: 7 }] }) as {
      items: Array<{ directiveRef?: number }>;
    };
    expect(bulk.items[0].directiveRef).toBe(7);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a %s directiveRef on both tools — an orders id is a positive integer', (_label, bad) => {
    expect(() => createTool.args.parse({ kind: 'task', title: 't', directiveRef: bad })).toThrow();
    expect(() => claimTool.args.parse({ id: 'WI-1', directiveRef: bad })).toThrow();
  });
});

describe('P-005 behaviour: work_items:claim binds provenance only when the claim lands', () => {
  it('binds the directive AFTER a successful claim, scoped to the caller workspace', async () => {
    const b = await claimBody({ id: 'WI-1', directiveRef: 125 });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(bindM).toHaveBeenCalledWith('ws-1', 'WI-1', 125);
    expect(b.results[0].directiveBindWarning).toBeUndefined();
  });

  it('does NOT bind when directiveRef is omitted — the common case stays a plain claim', async () => {
    await claimBody({ id: 'WI-1' });
    expect(bindM).not.toHaveBeenCalled();
  });

  it('does NOT bind when the claim itself fails — the link must not outlive the claim', async () => {
    mockResolvedTyped(claimM, null);
    const b = await claimBody({ id: 'WI-1', directiveRef: 125 });
    expect(b.results[0].ok).toBe(false);
    expect(bindM).not.toHaveBeenCalled();
  });

  it('still claims, and WARNS, when the item already carries a different directive', async () => {
    mockResolvedTyped(bindM, { ok: false, error: 'directive_ref_conflict', existing: 99 });
    const b = await claimBody({ id: 'WI-1', directiveRef: 125 });
    // The ownership mutation already committed; swallowing it to report a
    // provenance problem would lose the claim the caller actually made.
    expect(b.results[0].ok).toBe(true);
    expect(b.results[0].directiveBindWarning).toMatch(/already carries directive 99/);
    expect(b.results[0].directiveBindWarning).toMatch(/write-once/i);
  });

  it('carries a per-item directiveRef through the bulk path', async () => {
    await claimBody({ items: [{ id: 'WI-1', directiveRef: 7 }, { id: 'WI-2' }] });
    expect(bindM).toHaveBeenCalledTimes(1);
    expect(bindM).toHaveBeenCalledWith('ws-1', 'WI-1', 7);
  });
});

describe('P-005 pin: the Orientation banner names a parameter that exists', () => {
  // Scoped to ONE file, not a tree walk, so this guard cannot self-match on its
  // own source the way a `grep -r` detector would.
  const bannerSource = readFileSync(
    join(__dirname, '..', '..', 'turn-start-orientation.ts'),
    'utf8',
  );

  it('reads the renderer source it is judging (positive control)', () => {
    // Without this, a moved/renamed file makes every assertion below pass
    // VACUOUSLY on an empty string — the absence would read as agreement.
    expect(bannerSource).toContain('OrientationOwnerDirective');
  });

  it('instructs agents to pass directiveRef, and work_items:create accepts exactly that key', () => {
    const instructed = /work_items:create \{ directiveRef:/.test(bannerSource);
    expect(instructed).toBe(true);
    // The other half of the same claim: the tool really takes the key the
    // banner names. `.strict()` is what makes this a real check.
    expect(() =>
      createTool.args.parse({ kind: 'task', title: 't', directiveRef: 1 }),
    ).not.toThrow();
  });
});
