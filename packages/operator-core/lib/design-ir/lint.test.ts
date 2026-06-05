/**
 * Per-rule unit tests for the UI-IR anti-pattern linter (lint.ts).
 *
 * Pure unit — one focused, minimal IR fixture per rule, with both a
 * positive (clean → no finding) and a negative (anti-pattern → finding)
 * case, plus the rule's severity. Also covers context-gating (rules that
 * no-op without the relevant `LintContext` set), the walker's reach into
 * children/slots/item/emptyState/states, and the `lintErrors` /
 * severity-aggregation behaviour of `lintIr`.
 *
 * Fixtures are built from ./schema's UiIr / UiNode types; where a rule
 * needs a field the typed surface doesn't model cleanly we narrow-cast.
 */
import { describe, it, expect } from 'vitest';
import { lintIr, lintErrors, type LintContext, type Severity } from './lint';
import { IR_VERSION, type UiIr } from './schema';

// --- Fixture helpers ------------------------------------------------------

const base = {
  irVersion: IR_VERSION,
  surface: 'demo',
  ecosystem: '*',
} as const;

/** Build a UiIr from a layout node (+ optional extras), with the required head. */
function ir(extra: Partial<UiIr> & Pick<UiIr, 'layout'>): UiIr {
  return { ...base, ...extra };
}

const cleanLayout: UiIr['layout'] = { kind: 'stack', direction: 'vertical' };

/** Finds for a single rule id. */
function findsFor(issues: ReturnType<typeof lintIr>, ruleId: string) {
  return issues.filter((i) => i.ruleId === ruleId);
}

// ==========================================================================
// max-nesting-depth (warning)
// ==========================================================================
describe('max-nesting-depth', () => {
  const chain = (depth: number): UiIr['layout'] =>
    depth === 0 ? { kind: 'text' } : { kind: 'stack', children: [chain(depth - 1)] };

  it('clean: within maxDepth → no finding', () => {
    const issues = lintIr(ir({ layout: chain(2) }), { maxDepth: 6 });
    expect(findsFor(issues, 'max-nesting-depth')).toEqual([]);
  });

  it('anti-pattern: exceeds maxDepth → warning with the offending path', () => {
    const issues = lintIr(ir({ layout: chain(8) }), { maxDepth: 3 });
    const finds = findsFor(issues, 'max-nesting-depth');
    expect(finds.length).toBeGreaterThan(0);
    expect(finds[0].severity).toBe<Severity>('warning');
    expect(finds[0].path.startsWith('/layout')).toBe(true);
  });

  it('uses DEFAULT_MAX_DEPTH (6) when maxDepth is omitted', () => {
    // depth 7 > default 6 → warns even with no ctx.maxDepth.
    expect(findsFor(lintIr(ir({ layout: chain(7) })), 'max-nesting-depth').length).toBeGreaterThan(0);
    // depth 6 is at the limit (not strictly greater) → no warning.
    expect(findsFor(lintIr(ir({ layout: chain(6) })), 'max-nesting-depth')).toEqual([]);
  });
});

// ==========================================================================
// unknown-token (error) + context gating
// ==========================================================================
describe('unknown-token', () => {
  const ctx: LintContext = { knownTokens: new Set(['space.md', 'motion.fast', 'motion.ease']) };

  it('clean: all inline + surface tokens resolve → no finding', () => {
    const issues = lintIr(
      ir({
        layout: {
          kind: 'stack',
          gap: { token: 'space.md' },
          padding: { token: 'space.md' },
          motion: { duration: { token: 'motion.fast' }, easing: { token: 'motion.ease' } },
        },
        tokens: { uses: ['space.md'] },
      }),
      ctx,
    );
    expect(findsFor(issues, 'unknown-token')).toEqual([]);
  });

  it('anti-pattern: unknown inline gap token → error at the gap/token path', () => {
    const issues = lintIr(ir({ layout: { kind: 'stack', gap: { token: 'space.bogus' } } }), ctx);
    const finds = findsFor(issues, 'unknown-token');
    expect(finds.some((f) => f.severity === 'error' && f.path === '/layout/gap/token')).toBe(true);
  });

  it('anti-pattern: unknown motion duration/easing tokens each error', () => {
    const issues = lintIr(
      ir({
        layout: {
          kind: 'stack',
          motion: { duration: { token: 'd.bad' }, easing: { token: 'e.bad' } },
        },
      }),
      ctx,
    );
    const finds = findsFor(issues, 'unknown-token');
    expect(finds.some((f) => f.path === '/layout/motion/duration/token')).toBe(true);
    expect(finds.some((f) => f.path === '/layout/motion/easing/token')).toBe(true);
  });

  it('anti-pattern: unknown surface tokens.uses → error at /tokens/uses', () => {
    const issues = lintIr(ir({ layout: cleanLayout, tokens: { uses: ['nope.token'] } }), ctx);
    const finds = findsFor(issues, 'unknown-token');
    expect(finds.some((f) => f.severity === 'error' && f.path === '/tokens/uses')).toBe(true);
  });

  it('gating: without knownTokens context the rule no-ops', () => {
    const issues = lintIr(ir({ layout: { kind: 'stack', gap: { token: 'whatever' } } }));
    expect(findsFor(issues, 'unknown-token')).toEqual([]);
  });
});

// ==========================================================================
// unknown-component (error) + context gating
// ==========================================================================
describe('unknown-component', () => {
  const ctx: LintContext = { knownComponents: new Set(['action.primary']) };

  it('clean: registry id is known → no finding', () => {
    const issues = lintIr(ir({ layout: cleanLayout, components: [{ id: 'a', registry: 'action.primary' }] }), ctx);
    expect(findsFor(issues, 'unknown-component')).toEqual([]);
  });

  it('anti-pattern: unknown registry → error at /components/<i>/registry', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, components: [{ id: 'a', registry: 'action.ghost' }] }),
      ctx,
    );
    const finds = findsFor(issues, 'unknown-component');
    expect(finds[0]?.severity).toBe('error');
    expect(finds[0]?.path).toBe('/components/0/registry');
  });

  it('gating: without knownComponents context the rule no-ops', () => {
    const issues = lintIr(ir({ layout: cleanLayout, components: [{ id: 'a', registry: 'action.ghost' }] }));
    expect(findsFor(issues, 'unknown-component')).toEqual([]);
  });
});

// ==========================================================================
// orphan-component-binding (warning + error halves)
// ==========================================================================
describe('orphan-component-binding', () => {
  it('clean: declared component referenced by a kind="component" node → no finding', () => {
    const issues = lintIr(
      ir({
        layout: { kind: 'stack', children: [{ kind: 'component', ref: 'btn' }] },
        components: [{ id: 'btn', registry: 'action.primary' }],
      }),
    );
    expect(findsFor(issues, 'orphan-component-binding')).toEqual([]);
  });

  it('anti-pattern (warning): component declared but never referenced', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, components: [{ id: 'btn', registry: 'action.primary' }] }),
    );
    const finds = findsFor(issues, 'orphan-component-binding');
    expect(finds.some((f) => f.severity === 'warning' && f.path === '/components')).toBe(true);
  });

  it('anti-pattern (error): ref points to a non-declared component', () => {
    const issues = lintIr(
      ir({ layout: { kind: 'stack', children: [{ kind: 'component', ref: 'ghost' }] } }),
    );
    const finds = findsFor(issues, 'orphan-component-binding');
    expect(finds.some((f) => f.severity === 'error' && f.path === '/layout')).toBe(true);
  });
});

// ==========================================================================
// unknown-icon (error) + context gating
// ==========================================================================
describe('unknown-icon', () => {
  const ctx: LintContext = { knownIcons: new Set(['inbox', 'check']) };

  it('clean: icon id is known → no finding', () => {
    const issues = lintIr(ir({ layout: { kind: 'icon', icon: 'inbox' } }), ctx);
    expect(findsFor(issues, 'unknown-icon')).toEqual([]);
  });

  it('anti-pattern: unknown icon → error at <path>/icon', () => {
    const issues = lintIr(
      ir({ layout: { kind: 'stack', children: [{ kind: 'icon', icon: 'sparkles' }] } }),
      ctx,
    );
    const finds = findsFor(issues, 'unknown-icon');
    expect(finds[0]?.severity).toBe('error');
    expect(finds[0]?.path).toBe('/layout/children/0/icon');
  });

  it('gating: without knownIcons context the rule no-ops', () => {
    const issues = lintIr(ir({ layout: { kind: 'icon', icon: 'sparkles' } }));
    expect(findsFor(issues, 'unknown-icon')).toEqual([]);
  });
});

// ==========================================================================
// interactive-without-a11y (warning)
// ==========================================================================
describe('interactive-without-a11y', () => {
  it('clean: interactive node with a11y.role → no finding', () => {
    const issues = lintIr(ir({ layout: { kind: 'button', a11y: { role: 'button' } } }));
    expect(findsFor(issues, 'interactive-without-a11y')).toEqual([]);
  });

  it('clean: interactive node with a11y.ariaLabel → no finding', () => {
    const issues = lintIr(ir({ layout: { kind: 'input', a11y: { ariaLabel: { default: 'Name' } } } }));
    expect(findsFor(issues, 'interactive-without-a11y')).toEqual([]);
  });

  it('anti-pattern: bare interactive node (no role/ariaLabel) → warning', () => {
    const issues = lintIr(ir({ layout: { kind: 'select' } }));
    const finds = findsFor(issues, 'interactive-without-a11y');
    expect(finds.length).toBe(1);
    expect(finds[0].severity).toBe('warning');
  });

  it('exempts kind="component" (registry supplies the role)', () => {
    const issues = lintIr(
      ir({
        layout: { kind: 'component', ref: 'btn' },
        components: [{ id: 'btn', registry: 'action.primary' }],
      }),
    );
    expect(findsFor(issues, 'interactive-without-a11y')).toEqual([]);
  });

  it('non-interactive kinds (text/heading) are never flagged', () => {
    const issues = lintIr(ir({ layout: { kind: 'stack', children: [{ kind: 'text' }, { kind: 'heading' }] } }));
    expect(findsFor(issues, 'interactive-without-a11y')).toEqual([]);
  });
});

// ==========================================================================
// error-state-missing-recovery (warning)
// ==========================================================================
describe('error-state-missing-recovery', () => {
  it('no error state → no finding', () => {
    expect(findsFor(lintIr(ir({ layout: cleanLayout })), 'error-state-missing-recovery')).toEqual([]);
  });

  it('clean: error state with a button child → no finding', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, states: { error: { kind: 'banner', children: [{ kind: 'button' }] } } }),
    );
    expect(findsFor(issues, 'error-state-missing-recovery')).toEqual([]);
  });

  it('clean: error state with a "retry" interaction → no finding', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, states: { error: { kind: 'banner', interactions: ['retry'] } } }),
    );
    expect(findsFor(issues, 'error-state-missing-recovery')).toEqual([]);
  });

  it('anti-pattern: error state with no recovery affordance → warning', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, states: { error: { kind: 'banner', copy: { default: 'oops' } } } }),
    );
    const finds = findsFor(issues, 'error-state-missing-recovery');
    expect(finds.length).toBe(1);
    expect(finds[0].severity).toBe('warning');
    expect(finds[0].path).toBe('/states/error');
  });
});

// ==========================================================================
// loading-state-missing-aria-live (warning)
// ==========================================================================
describe('loading-state-missing-aria-live', () => {
  it('no loading state → no finding', () => {
    expect(findsFor(lintIr(ir({ layout: cleanLayout })), 'loading-state-missing-aria-live')).toEqual([]);
  });

  it('clean: loading state with aria-live="polite" → no finding', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, states: { loading: { kind: 'spinner', a11y: { ariaLive: 'polite' } } } }),
    );
    expect(findsFor(issues, 'loading-state-missing-aria-live')).toEqual([]);
  });

  it('anti-pattern: loading state without aria-live → warning', () => {
    const issues = lintIr(ir({ layout: cleanLayout, states: { loading: { kind: 'spinner' } } }));
    const finds = findsFor(issues, 'loading-state-missing-aria-live');
    expect(finds.length).toBe(1);
    expect(finds[0].severity).toBe('warning');
    expect(finds[0].path).toBe('/states/loading');
  });

  it('anti-pattern: aria-live="off" does not count as a live region → warning', () => {
    const issues = lintIr(
      ir({ layout: cleanLayout, states: { loading: { kind: 'spinner', a11y: { ariaLive: 'off' } } } }),
    );
    expect(findsFor(issues, 'loading-state-missing-aria-live').length).toBe(1);
  });
});

// ==========================================================================
// raw-escape-hatch (warning)
// ==========================================================================
describe('raw-escape-hatch', () => {
  it('clean: composed primitives → no finding', () => {
    expect(findsFor(lintIr(ir({ layout: { kind: 'stack', children: [{ kind: 'text' }] } })), 'raw-escape-hatch')).toEqual([]);
  });

  it('anti-pattern: kind="raw" → warning', () => {
    const issues = lintIr(ir({ layout: { kind: 'raw', ecosystem: 'react', payload: '<X/>' } }));
    const finds = findsFor(issues, 'raw-escape-hatch');
    expect(finds.length).toBe(1);
    expect(finds[0].severity).toBe('warning');
    expect(finds[0].path).toBe('/layout');
  });
});

// ==========================================================================
// copy-missing-key (warning) — across all copy-bearing fields
// ==========================================================================
describe('copy-missing-key', () => {
  it('clean: copy node with both key + default → no finding', () => {
    const issues = lintIr(ir({ layout: { kind: 'heading', title: { key: 'h.t', default: 'Hi' } } }));
    expect(findsFor(issues, 'copy-missing-key')).toEqual([]);
  });

  it('anti-pattern: title with default but no key → warning', () => {
    const issues = lintIr(ir({ layout: { kind: 'heading', title: { default: 'Hi' } } }));
    const finds = findsFor(issues, 'copy-missing-key');
    expect(finds.length).toBe(1);
    expect(finds[0].severity).toBe('warning');
    expect(finds[0].path).toBe('/layout/title');
  });

  it('checks every copy-bearing field (title, copy, label, placeholder, a11y.ariaLabel)', () => {
    const issues = lintIr(
      ir({
        layout: {
          kind: 'input',
          title: { default: 't' },
          copy: { default: 'c' },
          label: { default: 'l' },
          placeholder: { default: 'p' },
          a11y: { ariaLabel: { default: 'al' } },
        },
      }),
    );
    const paths = findsFor(issues, 'copy-missing-key').map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        '/layout/a11y/ariaLabel',
        '/layout/copy',
        '/layout/label',
        '/layout/placeholder',
        '/layout/title',
      ].sort(),
    );
  });
});

// ==========================================================================
// walker reach — rules see nodes nested in children/slots/item/emptyState/states
// ==========================================================================
describe('walkNodes reach (via raw-escape-hatch + states)', () => {
  it('reaches into slots', () => {
    const issues = lintIr(ir({ layout: { kind: 'card', slots: { body: { kind: 'raw', ecosystem: 'x', payload: '?' } } } }));
    expect(findsFor(issues, 'raw-escape-hatch').some((f) => f.path === '/layout/slots/body')).toBe(true);
  });

  it('reaches into list item + emptyState', () => {
    const issues = lintIr(
      ir({
        layout: {
          kind: 'list',
          item: { kind: 'raw', ecosystem: 'x', payload: '?' },
          emptyState: { kind: 'raw', ecosystem: 'x', payload: '?' },
        },
      }),
    );
    const paths = findsFor(issues, 'raw-escape-hatch').map((f) => f.path);
    expect(paths).toContain('/layout/item');
    expect(paths).toContain('/layout/emptyState');
  });
});

// ==========================================================================
// aggregation: lintIr returns all, lintErrors filters to severity==='error'
// ==========================================================================
describe('severity aggregation', () => {
  /**
   * One IR that trips several rules at once:
   *  - raw-escape-hatch       → warning
   *  - orphan-component-binding (declared-unused) → warning
   *  - unknown-component      → error   (needs knownComponents ctx)
   */
  const messy = ir({
    layout: { kind: 'raw', ecosystem: 'x', payload: '?' },
    components: [{ id: 'unused', registry: 'action.ghost' }],
  });
  const ctx: LintContext = { knownComponents: new Set(['action.primary']) };

  it('lintIr aggregates issues from multiple rules with mixed severities', () => {
    const issues = lintIr(messy, ctx);
    const ruleIds = new Set(issues.map((i) => i.ruleId));
    expect(ruleIds.has('raw-escape-hatch')).toBe(true);
    expect(ruleIds.has('orphan-component-binding')).toBe(true);
    expect(ruleIds.has('unknown-component')).toBe(true);
    const severities = new Set(issues.map((i) => i.severity));
    expect(severities.has('warning')).toBe(true);
    expect(severities.has('error')).toBe(true);
  });

  it('every issue carries its rule id stamped in', () => {
    for (const issue of lintIr(messy, ctx)) {
      expect(typeof issue.ruleId).toBe('string');
      expect(issue.ruleId.length).toBeGreaterThan(0);
    }
  });

  it('lintErrors returns only error-severity issues (a strict subset)', () => {
    const all = lintIr(messy, ctx);
    const errs = lintErrors(messy, ctx);
    expect(errs.every((i) => i.severity === 'error')).toBe(true);
    expect(errs.length).toBe(all.filter((i) => i.severity === 'error').length);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('a fully-clean IR yields zero issues', () => {
    expect(lintIr(ir({ layout: cleanLayout }))).toEqual([]);
    expect(lintErrors(ir({ layout: cleanLayout }))).toEqual([]);
  });
});
