import { describe, it, expect } from 'vitest';
import {
  validateIr,
  assertValidIr,
  IrValidationError,
  lintIr,
  lintErrors,
  IR_VERSION,
  type UiIr,
} from './index';

const minimalSpec: UiIr = {
  irVersion: IR_VERSION,
  surface: 'demo',
  ecosystem: '*',
  layout: { kind: 'stack', direction: 'vertical' },
};

describe('validateIr', () => {
  it('accepts a minimal valid spec', () => {
    const r = validateIr(minimalSpec);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.spec).toBeDefined();
  });

  it('rejects missing required fields', () => {
    const r = validateIr({ surface: 'x', ecosystem: '*', layout: { kind: 'stack' } });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message?.includes('irVersion'))).toBe(true);
  });

  it('rejects bad irVersion format', () => {
    const r = validateIr({ ...minimalSpec, irVersion: '1.0.0' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown node kind', () => {
    const r = validateIr({
      ...minimalSpec,
      layout: { kind: 'invalid-kind' as never },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('/layout/kind'))).toBe(true);
  });

  it('rejects extra top-level properties', () => {
    const r = validateIr({ ...minimalSpec, randomField: 'oops' });
    expect(r.ok).toBe(false);
  });

  it('accepts a richer spec with components, tokens, states, a11y', () => {
    const spec: UiIr = {
      irVersion: IR_VERSION,
      surface: 'operator-panel',
      ecosystem: 'react-tailwind',
      layout: {
        kind: 'stack',
        direction: 'vertical',
        gap: { token: 'space.md' },
        children: [
          {
            kind: 'header',
            title: { key: 'op.header.title', default: 'Operator' },
          },
          {
            kind: 'list',
            emptyState: {
              kind: 'empty-state',
              copy: { default: 'No directives.' },
              icon: 'inbox',
            },
            item: {
              kind: 'card',
              slots: {
                title: { kind: 'text' },
                actions: { kind: 'stack', direction: 'horizontal' },
              },
            },
          },
        ],
      },
      components: [
        {
          id: 'btn-accept',
          registry: 'action.primary',
          props: { label: 'Accept' },
        },
      ],
      tokens: { uses: ['color.bg.surface', 'space.md'] },
      states: {
        loading: { kind: 'spinner', label: { default: 'Loading…' } },
        error: { kind: 'banner', copy: { default: 'Failed to load.' } },
      },
      a11y: { landmark: 'main', headingLevel: 2 },
    };
    const r = validateIr(spec);
    expect(r.ok).toBe(true);
  });

  it('accepts kind="chart" with a Plotly spec object', () => {
    const r = validateIr({
      ...minimalSpec,
      layout: {
        kind: 'chart',
        spec: { data: [{ x: [1, 2], y: [3, 4], type: 'scatter' }] },
      },
    });
    expect(r.ok).toBe(true);
  });

  it('accepts kind="raw" with ecosystem + payload', () => {
    const r = validateIr({
      ...minimalSpec,
      layout: { kind: 'raw', ecosystem: 'react-tailwind', payload: '<MyJsx/>' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('assertValidIr', () => {
  it('passes on valid', () => {
    expect(() => assertValidIr(minimalSpec)).not.toThrow();
  });

  it('throws IrValidationError on invalid', () => {
    expect(() => assertValidIr({ kind: 'wat' })).toThrow(IrValidationError);
  });
});

describe('lintIr', () => {
  it('passes a clean spec with no issues', () => {
    const issues = lintIr(minimalSpec);
    expect(issues).toEqual([]);
  });

  describe('max-nesting-depth', () => {
    it('warns on deep nesting', () => {
      const deep = (depth: number): UiIr['layout'] =>
        depth === 0
          ? { kind: 'text' }
          : { kind: 'stack', children: [deep(depth - 1)] };
      const issues = lintIr({ ...minimalSpec, layout: deep(10) }, { maxDepth: 6 });
      expect(issues.some((i) => i.ruleId === 'max-nesting-depth')).toBe(true);
    });

    it('does not warn within the depth limit', () => {
      const shallow: UiIr['layout'] = {
        kind: 'stack',
        children: [{ kind: 'text' }],
      };
      const issues = lintIr({ ...minimalSpec, layout: shallow }, { maxDepth: 6 });
      expect(issues.filter((i) => i.ruleId === 'max-nesting-depth')).toEqual([]);
    });
  });

  describe('unknown-token', () => {
    it('errors on unknown gap token', () => {
      const issues = lintIr(
        {
          ...minimalSpec,
          layout: { kind: 'stack', gap: { token: 'space.fake' } },
        },
        { knownTokens: new Set(['space.md']) },
      );
      expect(issues.some((i) => i.ruleId === 'unknown-token' && i.severity === 'error')).toBe(true);
    });

    it('passes when token is known', () => {
      const issues = lintIr(
        {
          ...minimalSpec,
          layout: { kind: 'stack', gap: { token: 'space.md' } },
        },
        { knownTokens: new Set(['space.md']) },
      );
      expect(issues.filter((i) => i.ruleId === 'unknown-token')).toEqual([]);
    });

    it('skips check when no knownTokens context provided', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: { kind: 'stack', gap: { token: 'unknown' } },
      });
      expect(issues.filter((i) => i.ruleId === 'unknown-token')).toEqual([]);
    });
  });

  describe('unknown-component', () => {
    it('errors on unknown registry component', () => {
      const issues = lintIr(
        {
          ...minimalSpec,
          components: [{ id: 'b', registry: 'action.fake' }],
        },
        { knownComponents: new Set(['action.primary']) },
      );
      expect(issues.some((i) => i.ruleId === 'unknown-component' && i.severity === 'error')).toBe(
        true,
      );
    });
  });

  describe('orphan-component-binding', () => {
    it('errors when ref points to non-existent component', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: {
          kind: 'stack',
          children: [{ kind: 'component', ref: 'btn-ghost' }],
        },
      });
      expect(
        issues.some(
          (i) => i.ruleId === 'orphan-component-binding' && i.severity === 'error',
        ),
      ).toBe(true);
    });

    it('warns when component declared but unused', () => {
      const issues = lintIr({
        ...minimalSpec,
        components: [{ id: 'btn-ghost', registry: 'action.primary' }],
      });
      expect(
        issues.some(
          (i) => i.ruleId === 'orphan-component-binding' && i.severity === 'warning',
        ),
      ).toBe(true);
    });
  });

  describe('interactive-without-a11y', () => {
    it('warns on bare button', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: { kind: 'stack', children: [{ kind: 'button' }] },
      });
      expect(issues.some((i) => i.ruleId === 'interactive-without-a11y')).toBe(true);
    });

    it('passes when button has aria-label', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: {
          kind: 'stack',
          children: [
            {
              kind: 'button',
              a11y: { ariaLabel: { default: 'Accept' } },
            },
          ],
        },
      });
      expect(issues.filter((i) => i.ruleId === 'interactive-without-a11y')).toEqual([]);
    });
  });

  describe('error-state-missing-recovery', () => {
    it('warns when error state has no recovery', () => {
      const issues = lintIr({
        ...minimalSpec,
        states: { error: { kind: 'banner', copy: { default: 'oops' } } },
      });
      expect(issues.some((i) => i.ruleId === 'error-state-missing-recovery')).toBe(true);
    });

    it('passes when error state has a button', () => {
      const issues = lintIr({
        ...minimalSpec,
        states: {
          error: {
            kind: 'banner',
            children: [{ kind: 'button', a11y: { ariaLabel: { default: 'Retry' } } }],
          },
        },
      });
      expect(issues.filter((i) => i.ruleId === 'error-state-missing-recovery')).toEqual([]);
    });
  });

  describe('loading-state-missing-aria-live', () => {
    it('warns when loading has no aria-live', () => {
      const issues = lintIr({
        ...minimalSpec,
        states: { loading: { kind: 'spinner' } },
      });
      expect(issues.some((i) => i.ruleId === 'loading-state-missing-aria-live')).toBe(true);
    });

    it('passes when loading has aria-live', () => {
      const issues = lintIr({
        ...minimalSpec,
        states: {
          loading: { kind: 'spinner', a11y: { ariaLive: 'polite' } },
        },
      });
      expect(issues.filter((i) => i.ruleId === 'loading-state-missing-aria-live')).toEqual([]);
    });
  });

  describe('raw-escape-hatch', () => {
    it('warns on kind="raw"', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: { kind: 'raw', ecosystem: 'react-tailwind', payload: '<X/>' },
      });
      expect(issues.some((i) => i.ruleId === 'raw-escape-hatch')).toBe(true);
    });
  });

  describe('copy-missing-key', () => {
    it('warns when copy has default but no key', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: {
          kind: 'header',
          title: { default: 'Hi' },
        },
      });
      expect(issues.some((i) => i.ruleId === 'copy-missing-key')).toBe(true);
    });

    it('passes when copy has both key and default', () => {
      const issues = lintIr({
        ...minimalSpec,
        layout: {
          kind: 'header',
          title: { key: 'hdr.hi', default: 'Hi' },
        },
      });
      expect(issues.filter((i) => i.ruleId === 'copy-missing-key')).toEqual([]);
    });
  });
});

describe('lintErrors', () => {
  it('returns only errors, not warnings', () => {
    const issues = lintErrors(
      {
        ...minimalSpec,
        layout: { kind: 'raw', ecosystem: 'x', payload: '?' }, // warning
        components: [{ id: 'orphan', registry: 'action.primary' }], // warning
      },
      { knownComponents: new Set(['action.primary']) },
    );
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });
});
