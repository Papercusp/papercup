/**
 * agent-facts store — unit tests for the pure parts (queen-memory-hybrid L1b):
 * scope validation per D-001 (harness/work_item optional; workspace ref-less)
 * and the deterministic fold rendering. SQL paths are exercised by the tools'
 * live-verify (the store is a thin tagged-template layer over one table).
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { InvalidInputError } from '@papercusp/tooldef';
import {
  assertFact,
  parseFactSourceProvenance,
  renderFactSrc,
  renderFactsFold,
  resolveFactScopeRef,
  resolveFederationWorkspace,
  retractFact,
  validateAudienceScope,
  validateFactScope,
  type AgentFact,
  type FactSourceProvenance,
} from './store';

describe('resolveFederationWorkspace (F1-4 / WI-1564)', () => {
  it('returns the workspace when it federates', () => {
    expect(resolveFederationWorkspace('papercusp-workspace')).toBe('papercusp-workspace');
    expect(resolveFederationWorkspace('  oddsmith-ws  ')).toBe('oddsmith-ws');
  });

  it('returns undefined for the non-federating coordination / wildcard / empty partitions', () => {
    expect(resolveFederationWorkspace('default')).toBeUndefined(); // DEFAULT_COORD_WORKSPACE
    expect(resolveFederationWorkspace('*')).toBeUndefined();
    expect(resolveFederationWorkspace('')).toBeUndefined();
    expect(resolveFederationWorkspace('   ')).toBeUndefined();
    expect(resolveFederationWorkspace(null)).toBeUndefined();
    expect(resolveFederationWorkspace(undefined)).toBeUndefined();
  });
});

describe('assertFact WI-1564 stranding guard (F1-4)', () => {
  // A stub that throws if the SQL layer is ever reached — proves whether the
  // guard refuses BEFORE any write (a refused shareable assert must never touch
  // the table) vs. lets a private assert through to SQL.
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — the WI-1564 guard must refuse first');
  }) as unknown as Sql;

  it('refuses a SHAREABLE fact on the non-federating coordination partition (loud, not stranded)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: 'default' },
        failSql,
      ),
    ).rejects.toThrow(/WI-1564/);
  });

  it('refuses a shareable fact whose workspace resolves to the wildcard partition', async () => {
    await expect(
      assertFact(
        { scope: 'role', scopeRef: 'mug', key: 'k', body: 'b', createdBy: 'su-test', shareable: true, workspaceId: '*' },
        failSql,
      ),
    ).rejects.toThrow(/never federates/);
  });

  it('lets a hive-PRIVATE fact through the guard on any partition (reaches SQL)', async () => {
    // shareable !== true ⇒ never rides the wire ⇒ the coordination partition is
    // fine; the assert must get PAST the guard (and hit the failSql stub).
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', workspaceId: 'default' },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('validateFactScope (D-001 scoping)', () => {
  it('workspace scope is global — carries NO ref', () => {
    expect(validateFactScope('workspace', null)).toBeNull();
    expect(validateFactScope('workspace', 'papercusp')).toMatch(/no scope_ref/);
  });

  it('every other scope requires a ref', () => {
    for (const scope of ['role', 'owner', 'harness', 'work_item']) {
      expect(validateFactScope(scope, 'x')).toBeNull();
      expect(validateFactScope(scope, '')).toMatch(/requires scope_ref/);
      expect(validateFactScope(scope, null)).toMatch(/requires scope_ref/);
    }
  });

  it('rejects unknown scopes', () => {
    expect(validateFactScope('galaxy', 'x')).toMatch(/unknown scope/);
  });
});

describe('EI-7463 — a caller-side scope/ref validation failure throws InvalidInputError, not a plain Error', () => {
  // The dispatcher (dispatch-stack.ts) codes InvalidInputError as `invalid_input`
  // (400) and any other thrown Error as `handler_error` (500) — so a facts:assert
  // arg mistake (omitted scope_ref for a non-workspace scope) must NOT surface as
  // a plain Error, or it inflates the tool's structural error-rate telemetry
  // (the false "tool is broken" signal this ticket fixes).
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — validation must refuse before any write');
  }) as unknown as Sql;

  it('assertFact: a missing scope_ref for scope "harness" throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'harness', key: 'k', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: a missing scope_ref for scope "owner" throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'owner', key: 'k', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: an empty key (post-trim) throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'workspace', key: '   ', body: 'b', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('assertFact: an empty body (post-clamp) throws InvalidInputError', async () => {
    await expect(
      assertFact({ scope: 'workspace', key: 'k', body: '   ', createdBy: 'su-test' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('retractFact: a missing scope_ref for scope "role" throws InvalidInputError', async () => {
    await expect(
      retractFact({ scope: 'role', key: 'k' }, failSql),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('a genuinely valid assert is unaffected — still reaches SQL (the stub throw proves it)', async () => {
    await expect(
      assertFact(
        { scope: 'harness', scopeRef: 'papercusp', key: 'k', body: 'b', createdBy: 'su-test', workspaceId: 'papercusp-workspace' },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('resolveFactScopeRef (EI-7517 — self-scoped default)', () => {
  const defaults = { ownerId: 'su-me', harnessSlug: 'papercusp', role: 'su' };

  it('defaults an OMITTED ref for the self-scoped scopes from ctx', () => {
    expect(resolveFactScopeRef('owner', undefined, defaults)).toBe('su-me');
    expect(resolveFactScopeRef('owner', null, defaults)).toBe('su-me');
    expect(resolveFactScopeRef('owner', '  ', defaults)).toBe('su-me'); // blank counts as omitted
    expect(resolveFactScopeRef('harness', undefined, defaults)).toBe('papercusp');
    expect(resolveFactScopeRef('role', undefined, defaults)).toBe('su');
  });

  it('the defaulted owner ref then PASSES validateFactScope (the fix — no more structural error)', () => {
    // The bug: facts:assert { scope: 'owner' } with no ref returned the
    // "scope 'owner' requires scope_ref" structural error the watchdog flagged.
    expect(validateFactScope('owner', undefined)).toMatch(/requires scope_ref/);
    const filled = resolveFactScopeRef('owner', undefined, defaults);
    expect(validateFactScope('owner', filled)).toBeNull();
  });

  it('an EXPLICIT ref always wins over the ctx default', () => {
    expect(resolveFactScopeRef('owner', 'su-other', defaults)).toBe('su-other');
    expect(resolveFactScopeRef('harness', 'other-harness', defaults)).toBe('other-harness');
    expect(resolveFactScopeRef('role', 'mug', defaults)).toBe('mug');
  });

  it('leaves workspace ref-less and does NOT invent a work_item ref', () => {
    expect(resolveFactScopeRef('workspace', undefined, defaults)).toBeUndefined();
    // work_item has no caller-context default — still requires an explicit id.
    expect(resolveFactScopeRef('work_item', undefined, defaults)).toBeUndefined();
    expect(validateFactScope('work_item', resolveFactScopeRef('work_item', undefined, defaults))).toMatch(
      /requires scope_ref/,
    );
  });

  it('falls back to the passed ref when a ctx default is missing', () => {
    expect(resolveFactScopeRef('harness', undefined, { ownerId: 'su-me' })).toBeUndefined();
    expect(resolveFactScopeRef('role', null, { ownerId: 'su-me' })).toBeNull();
  });
});

describe('renderFactsFold', () => {
  const fact = (over: Partial<AgentFact>): AgentFact => ({
    scope: 'role',
    scopeRef: 'mug',
    key: 'k',
    body: 'WI-1439 is owner-residue — exclude from the placeable frontier',
    sourceRef: 'WI-1574',
    audienceScope: null,
    sourceProvenance: null,
    createdBy: 'su-test',
    updatedAt: new Date(0).toISOString(),
    expiresAt: new Date(3 * 86_400_000).toISOString(),
    ...over,
  });

  it('renders one deterministic line per fact with scope, expiry and source', () => {
    const out = renderFactsFold([fact({})], 0);
    expect(out).toContain('### Standing facts');
    expect(out).toContain('[role:mug] WI-1439 is owner-residue');
    expect(out).toContain('expires ~3d');
    expect(out).toContain('src WI-1574');
  });

  it('workspace-scoped facts render without a ref; empty set renders nothing', () => {
    const out = renderFactsFold([fact({ scope: 'workspace', scopeRef: null, sourceRef: null })], 0);
    expect(out).toContain('[workspace]');
    expect(out).not.toContain('src ');
    expect(renderFactsFold([])).toBe('');
  });

  it('P-007: renders the audience tag and the verified provenance quote', () => {
    const out = renderFactsFold(
      [
        fact({
          audienceScope: 'fleet:backend',
          sourceRef: 'msg:m-1',
          sourceProvenance: { kind: 'msg', verified: true, quote: 'origin words', verifiedAt: 't' },
        }),
      ],
      0,
    );
    expect(out).toContain('[role:mug ⊸fleet:backend]');
    expect(out).toContain('src msg:m-1 ✓ "origin words"');
  });
});

// ── coord-authority-hardening-2026-07-11 P-007 (H3+C) — the pure halves ─────────

describe('validateAudienceScope (P-007 v1 grammar)', () => {
  it('accepts absent/blank (unrestricted) and fleet:<slug>', () => {
    expect(validateAudienceScope(undefined)).toBeNull();
    expect(validateAudienceScope(null)).toBeNull();
    expect(validateAudienceScope('')).toBeNull();
    expect(validateAudienceScope('   ')).toBeNull();
    expect(validateAudienceScope('fleet:p2p-git')).toBeNull();
    expect(validateAudienceScope('fleet:Backend_2.x')).toBeNull();
  });

  it('rejects unknown grammars LOUDLY — a stored-but-unmatchable audience would hide the fact from everyone', () => {
    for (const bad of ['fleet:', 'squad:x', 'fleet:@nope', 'owner:su-1', 'fleet:x y', 'FLEETbackend']) {
      expect(validateAudienceScope(bad)).toMatch(/grammar/);
    }
  });
});

describe('assertFact audienceScope guard (P-007 — refuse before any write)', () => {
  const failSql = (() => {
    throw new Error('SQL SHOULD NOT BE REACHED — validation must refuse before any write');
  }) as unknown as Sql;

  it('an unknown audience grammar throws InvalidInputError (never stored unmatchable)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', audienceScope: 'squad:x' },
        failSql,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('a valid fleet audience passes the guard (reaches SQL)', async () => {
    await expect(
      assertFact(
        { scope: 'workspace', key: 'k', body: 'b', createdBy: 'su-test', audienceScope: 'fleet:backend' },
        failSql,
      ),
    ).rejects.toThrow(/SQL SHOULD NOT BE REACHED/);
  });
});

describe('parseFactSourceProvenance (defensive jsonb round-trip read)', () => {
  it('round-trips a valid stamp and drops unknown extras', () => {
    expect(
      parseFactSourceProvenance({
        kind: 'owner-turn',
        verified: true,
        quote: 'the owner words',
        label: 'owner turn 2026-07-11T00:00:00Z',
        verifiedAt: '2026-07-11T00:00:01Z',
        forged: 'junk',
      }),
    ).toEqual({
      kind: 'owner-turn',
      verified: true,
      quote: 'the owner words',
      label: 'owner turn 2026-07-11T00:00:00Z',
      verifiedAt: '2026-07-11T00:00:01Z',
    });
  });

  it('rejects absent/malformed/forged shapes → null, never throws', () => {
    for (const junk of [
      null,
      undefined,
      'string',
      42,
      {},
      { kind: 'god-mode', verified: true, verifiedAt: 't' }, // forged kind
      { kind: 'msg', verified: 'yes', verifiedAt: 't' }, // non-bool verified
      { kind: 'msg', verified: true }, // missing verifiedAt
    ]) {
      expect(parseFactSourceProvenance(junk)).toBeNull();
    }
  });
});

describe('renderFactSrc (P-007 provenance-hydrated src)', () => {
  const base = { sourceRef: 'msg:m-1' };

  it('no stamp ⇒ the plain sourceRef (legacy/free-text unchanged); no source at all ⇒ empty', () => {
    expect(renderFactSrc({ sourceRef: 'a-plan-slug', sourceProvenance: null })).toBe('a-plan-slug');
    expect(renderFactSrc({ sourceRef: null, sourceProvenance: null })).toBe('');
  });

  it('verified with quote ⇒ `<ref> ✓ "<quote>"`; verified quote-less ⇒ label fallback', () => {
    const stamp: FactSourceProvenance = { kind: 'msg', verified: true, quote: 'origin words', verifiedAt: 't' };
    expect(renderFactSrc({ ...base, sourceProvenance: stamp })).toBe('msg:m-1 ✓ "origin words"');
    expect(
      renderFactSrc({
        sourceRef: 'WI-4172',
        sourceProvenance: { kind: 'work-item', verified: true, label: 'WI-4172 [feature/wip]', verifiedAt: 't' },
      }),
    ).toBe('WI-4172 ✓ WI-4172 [feature/wip]');
  });

  it('unverified renders LOUDLY with the error', () => {
    expect(
      renderFactSrc({ ...base, sourceProvenance: { kind: 'msg', verified: false, error: 'not_found', verifiedAt: 't' } }),
    ).toBe('msg:m-1 ✗unverified (not_found)');
    expect(
      renderFactSrc({ ...base, sourceProvenance: { kind: 'msg', verified: false, verifiedAt: 't' } }),
    ).toBe('msg:m-1 ✗unverified');
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-007: truncate-not-reject ────────────────

import { clampFactBody, FACT_BODY_MAX_CHARS } from './store';

describe('clampFactBody — over-cap bodies truncate instead of rejecting (P-007)', () => {
  it('keeps an in-cap body verbatim (trimmed)', () => {
    expect(clampFactBody('  a tight conclusion  ')).toBe('a tight conclusion');
  });

  it('truncates an over-cap body to exactly the cap with a visible ellipsis', () => {
    const out = clampFactBody('x'.repeat(FACT_BODY_MAX_CHARS + 100));
    expect(out.length).toBe(FACT_BODY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('at-cap body passes untouched (boundary)', () => {
    const exact = 'y'.repeat(FACT_BODY_MAX_CHARS);
    expect(clampFactBody(exact)).toBe(exact);
  });
});
