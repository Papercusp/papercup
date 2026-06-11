/**
 * P-021: tests for parsePlanBlock + applyPlanBlock.
 *
 * parsePlanBlock is a pure parser — no mocks needed.
 * applyPlanBlock calls handleHttpToolRequest; we mock that.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Stub operator-side deps that can't resolve in vitest — plan-block-handler.ts
// imports these only for the tool-registration path, not the pure parser logic.
vi.mock('../../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
vi.mock('../plans/runner', () => ({
  SU_ROLES: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'operator'],
}));

import { parsePlanBlock } from '../plan-block-handler';

/* ── Fixtures ─────────────────────────────────────────────────────── */

const MINIMAL_BLOCK = `\
TITLE: Add dark-mode toggle
STATUS: draft
SUMMARY: Adds a dark-mode preference toggle to the settings page.
---
## Now

**State:** Nothing started yet.
**Next:** Human reviews and accepts.

## Phase 1 — Settings UI

- [ ] P-001 Add toggle to settings page
- [ ] P-002 Persist preference to localStorage
`;

const FULL_BLOCK = `\
TITLE: Realtime notifications
STATUS: draft
SUMMARY: Delivers push notifications to mobile clients via Firebase.
---
## Now

**State:** Socket infra exists but notifications are not wired.
**Next:** Wire the event emitter to the push gateway.

## Phase 1 — Backend

- [ ] P-001 Add push gateway service
- [ ] P-002 Wire event emitter (blockedBy P-001)
- [ ] P-003 Write migration for device tokens

## Phase 2 — Mobile

- [ ] P-004 Register FCM token on login (blockedBy P-003)
- [ ] P-005 Handle notification tap

## Decisions

### D-001: Use Firebase over APNs directly
Firebase handles both Android and iOS; APNs is iOS-only. Rejected direct APNs integration.

### D-002: Store tokens in per-harness schema
Keeps tenancy boundary clean; no cross-harness leakage risk.
`;

/* ── parsePlanBlock ───────────────────────────────────────────────── */

describe('parsePlanBlock', () => {
  it('parses a minimal block', () => {
    const result = parsePlanBlock(MINIMAL_BLOCK);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Add dark-mode toggle');
    expect(result!.status).toBe('draft');
    expect(result!.summary).toBe('Adds a dark-mode preference toggle to the settings page.');
    expect(result!.nowState).toBe('Nothing started yet.');
    expect(result!.nowNext).toBe('Human reviews and accepts.');
    expect(result!.phases).toHaveLength(1);
    expect(result!.phases[0].items).toHaveLength(2);
    expect(result!.decisions).toHaveLength(0);
  });

  it('parses phases and items correctly', () => {
    const result = parsePlanBlock(FULL_BLOCK);
    expect(result).not.toBeNull();
    expect(result!.phases).toHaveLength(2);
    expect(result!.phases[0].name).toContain('Phase 1');
    expect(result!.phases[0].name).toContain('Backend');
    expect(result!.phases[0].items[0].text).toBe('Add push gateway service');
    expect(result!.phases[0].items[0].blockedBy).toHaveLength(0);
    expect(result!.phases[0].items[1].text).toBe('Wire event emitter');
    expect(result!.phases[0].items[1].blockedBy).toEqual(['P-001']);
  });

  it('parses decisions correctly', () => {
    const result = parsePlanBlock(FULL_BLOCK);
    expect(result!.decisions).toHaveLength(2);
    expect(result!.decisions[0].title).toBe('Use Firebase over APNs directly');
    expect(result!.decisions[0].body).toContain('Firebase handles both Android and iOS');
    expect(result!.decisions[1].title).toBe('Store tokens in per-harness schema');
  });

  it('returns null when TITLE is missing', () => {
    const block = MINIMAL_BLOCK.replace('TITLE: Add dark-mode toggle\n', '');
    expect(parsePlanBlock(block)).toBeNull();
  });

  it('returns null when --- separator is missing', () => {
    const block = MINIMAL_BLOCK.replace('\n---\n', '\n\n');
    expect(parsePlanBlock(block)).toBeNull();
  });

  it('returns empty nowState/nowNext when ## Now is absent', () => {
    const block = MINIMAL_BLOCK.replace(/## Now[\s\S]*?(?=## Phase)/, '');
    const result = parsePlanBlock(block);
    expect(result).not.toBeNull();
    expect(result!.nowState).toBe('');
    expect(result!.nowNext).toBe('');
  });

  it('ignores phase sections with no items', () => {
    const block = `\
TITLE: Empty phase test
STATUS: draft
SUMMARY: Test.
---
## Now

**State:** Pending.
**Next:** Start.

## Phase 1 — Empty

No items here, just prose.

## Phase 2 — Has items

- [ ] P-001 Do something
`;
    const result = parsePlanBlock(block);
    expect(result!.phases).toHaveLength(1);
    expect(result!.phases[0].items[0].text).toBe('Do something');
  });

  it('strips checked-checkbox items the same as unchecked', () => {
    const block = `\
TITLE: Mixed checkbox test
STATUS: draft
SUMMARY: Test.
---
## Now

**State:** Partly done.
**Next:** Finish.

## Phase 1 — Work

- [x] P-001 Already done item
- [ ] P-002 Pending item
`;
    const result = parsePlanBlock(block);
    expect(result!.phases[0].items).toHaveLength(2);
    expect(result!.phases[0].items[0].text).toBe('Already done item');
    expect(result!.phases[0].items[1].text).toBe('Pending item');
  });

  it('handles multiple blockedBy refs', () => {
    const block = `\
TITLE: Multi-blocker test
STATUS: draft
SUMMARY: Test.
---
## Now

**State:** Waiting.
**Next:** Unblock.

## Phase 1 — Work

- [ ] P-001 First task
- [ ] P-002 Second task
- [ ] P-003 Third task (blockedBy P-001, P-002)
`;
    const result = parsePlanBlock(block);
    expect(result!.phases[0].items[2].blockedBy).toEqual(['P-001', 'P-002']);
  });

  it('uses SUMMARY when present, empty string when absent', () => {
    const block = MINIMAL_BLOCK.replace('SUMMARY: Adds a dark-mode preference toggle to the settings page.\n', '');
    const result = parsePlanBlock(block);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('');
  });
});

/* ── applyPlanBlock (integration via mocked handleHttpToolRequest) ── */

// Stub for @papercusp/agent-mcp — used by the applyPlanBlock tests
// via vi.doMock after vi.resetModules() so each test gets a fresh
// handleHttpToolRequest spy. defineTool is stubbed as a no-op so the
// module-level registration call in plan-block-handler.ts doesn't fail.
function makeMcpStub(
  handleHttpToolRequest: (req: { pathname: string; body: Record<string, unknown> }) => Promise<unknown>,
): Record<string, unknown> {
  return {
    defineTool: (cfg: unknown) => cfg,
    handleHttpToolRequest,
    SU_ROLES: ['scoper', 'architect', 'worker', 'validator', 'reviewer', 'debugger', 'operator', 'documenter', 'curator'],
  };
}

describe('applyPlanBlock', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls plans:new → set-now → add-item × N → add-decision × N in order', async () => {
    const calls: Array<{ verb: string; body: Record<string, unknown> }> = [];

    vi.doMock('@papercusp/agent-mcp', () =>
      makeMcpStub(async (req: { pathname: string; body: Record<string, unknown> }) => {
        const verb = req.pathname.split('/').pop()!;
        calls.push({ verb, body: req.body });
        if (verb === 'new') {
          return {
            status: 200,
            body: { content: [{ type: 'text', text: JSON.stringify({ ok: true, slug: 'realtime-notifications-2026-05-24' }) }] },
          };
        }
        return {
          status: 200,
          body: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        };
      }),
    );

    const { parsePlanBlock: parse, applyPlanBlock } = await import('../plan-block-handler');
    const parsed = parse(FULL_BLOCK)!;
    const { slug } = await applyPlanBlock(parsed);

    expect(slug).toBe('realtime-notifications-2026-05-24');

    expect(calls[0].verb).toBe('new');
    expect(calls[0].body).toMatchObject({ title: 'Realtime notifications', status: 'draft' });

    expect(calls[1].verb).toBe('set-now');
    expect(calls[1].body).toMatchObject({
      slug: 'realtime-notifications-2026-05-24',
      state: 'Socket infra exists but notifications are not wired.',
    });

    const itemCalls = calls.filter((c) => c.verb === 'add-item');
    expect(itemCalls).toHaveLength(5);
    expect(itemCalls[0].body).toMatchObject({ text: 'Add push gateway service', slug: 'realtime-notifications-2026-05-24' });
    expect(itemCalls[1].body).toMatchObject({ text: 'Wire event emitter', blockedBy: ['P-001'] });

    const decCalls = calls.filter((c) => c.verb === 'add-decision');
    expect(decCalls).toHaveLength(2);
    expect(decCalls[0].body).toMatchObject({ title: 'Use Firebase over APNs directly' });
  });

  it('throws when plans:new returns ok:false', async () => {
    vi.doMock('@papercusp/agent-mcp', () =>
      makeMcpStub(async () => ({
        status: 200,
        body: { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'slug_conflict' }) }] },
      })),
    );

    const { parsePlanBlock: parse, applyPlanBlock } = await import('../plan-block-handler');
    const parsed = parse(MINIMAL_BLOCK)!;
    await expect(applyPlanBlock(parsed)).rejects.toThrow('slug_conflict');
  });

  it('throws when plans:new returns non-200', async () => {
    vi.doMock('@papercusp/agent-mcp', () =>
      makeMcpStub(async () => ({ status: 500, body: { error: 'internal error' } })),
    );

    const { parsePlanBlock: parse, applyPlanBlock } = await import('../plan-block-handler');
    const parsed = parse(MINIMAL_BLOCK)!;
    await expect(applyPlanBlock(parsed)).rejects.toThrow();
  });

  it('R21: throws if plans:add-item returns ok:false in a 200 envelope', async () => {
    // plans:new succeeds, set-now succeeds, add-item returns ok:false.
    // Before R21 this was silently swallowed; now must throw so the user
    // sees the partial-failure state instead of "plan created" success.
    vi.doMock('@papercusp/agent-mcp', () =>
      makeMcpStub(async (req) => {
        const verb = req.pathname.split('/').pop()!;
        if (verb === 'new') {
          return {
            status: 200,
            body: {
              content: [{ type: 'text', text: JSON.stringify({ ok: true, slug: 'demo-2026-05-25' }) }],
            },
          };
        }
        if (verb === 'add-item') {
          return {
            status: 200,
            body: {
              content: [
                { type: 'text', text: JSON.stringify({ ok: false, error: 'plan_locked', code: 'busy' }) },
              ],
            },
          };
        }
        // set-now passes silently
        return {
          status: 200,
          body: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        };
      }),
    );

    // Need a block with at least one item so add-item is invoked.
    const blockWithItem = `TITLE: Demo
SUMMARY: x
---

## Now

**State:** placeholder
**Next:** placeholder

## Phase 1 — Stuff

- [ ] P-001 First item
`;
    const { parsePlanBlock: parse, applyPlanBlock } = await import('../plan-block-handler');
    const parsed = parse(blockWithItem)!;
    expect(parsed.phases.length).toBeGreaterThan(0);
    await expect(applyPlanBlock(parsed)).rejects.toThrow(/plan_locked/);
  });
});
