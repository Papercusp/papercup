/**
 * Focused unit tests for the UI-IR JSON-Schema validator (validate.ts).
 *
 * Pure unit — drives the REAL ajv 2020 compiler against real IR fixtures.
 * Complements design-ir.test.ts by drilling into the result *shape*:
 * the narrowed `spec`, the formatted-error contract (instancePath → a
 * `/`-joined pointer + populated keyword/params/message), the throwing
 * `assertValidIr` variant, and the never-throws-on-bad-input contract of
 * `validateIr`.
 */
import { describe, it, expect } from 'vitest';
import {
  validateIr,
  assertValidIr,
  IrValidationError,
  type ValidationResult,
} from './validate';
import { IR_VERSION, type UiIr } from './schema';

// --- Minimal fixtures built from the schema -------------------------------

/** The smallest IR that satisfies `required: [irVersion, surface, ecosystem, layout]`. */
const minimalSpec: UiIr = {
  irVersion: IR_VERSION,
  surface: 'demo',
  ecosystem: '*',
  layout: { kind: 'stack' },
};

describe('validateIr — valid input', () => {
  it('returns { ok:true, errors:[] } and echoes the input as `spec`', () => {
    const r = validateIr(minimalSpec);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    // The narrowed spec is the same object reference, cast to UiIr.
    expect(r.spec).toBe(minimalSpec);
  });

  it('narrows `spec` to UiIr so its typed fields are reachable', () => {
    const r = validateIr(minimalSpec);
    // When ok=true the discriminant guarantees `spec` is present.
    expect(r.ok).toBe(true);
    if (r.ok) {
      // `spec` is typed UiIr here; assert a field that only exists on UiIr.
      expect(r.spec?.surface).toBe('demo');
      expect(r.spec?.layout.kind).toBe('stack');
    }
  });

  it('accepts a deeply-nested IR exercising $defs recursion (node→children→item→slots)', () => {
    const spec: UiIr = {
      irVersion: IR_VERSION,
      surface: 'panel',
      ecosystem: 'react',
      layout: {
        kind: 'stack',
        direction: 'vertical',
        gap: { token: 'space.md' },
        padding: { token: 'space.lg' },
        align: 'center',
        justify: 'space-between',
        children: [
          {
            kind: 'list',
            item: {
              kind: 'card',
              slots: { title: { kind: 'text' } },
            },
            emptyState: { kind: 'empty-state', copy: { default: 'empty' } },
          },
        ],
        a11y: { role: 'group', ariaLive: 'polite', focusOrder: 0 },
        motion: {
          enter: 'fade',
          exit: 'none',
          duration: { token: 'motion.fast' },
          easing: { token: 'motion.ease' },
        },
      },
      components: [{ id: 'c1', registry: 'action.primary', props: { x: 1 } }],
      tokens: {
        uses: ['space.md'],
        proposed: [{ id: 'p1', type: 'color', value: '#fff', reason: 'brand' }],
      },
      states: { loading: { kind: 'spinner' } },
      a11y: { landmark: 'main', headingLevel: 2 },
    };
    const r = validateIr(spec);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('validateIr — invalid input (formatted-error contract)', () => {
  it('reports a `/`-joined pointer for a nested instancePath', () => {
    // Bad enum on layout.kind → instancePath "/layout/kind".
    const r = validateIr({ ...minimalSpec, layout: { kind: 'no-such-kind' } });
    expect(r.ok).toBe(false);
    const kindErr = r.errors.find((e) => e.path === '/layout/kind');
    expect(kindErr).toBeDefined();
    // Each formatted error carries keyword + params + a message string.
    expect(kindErr?.keyword).toBe('enum');
    expect(typeof kindErr?.message).toBe('string');
    expect(kindErr?.params).toBeTypeOf('object');
  });

  it('uses "/" as the path for a top-level (root) error', () => {
    // Missing a top-level required prop → instancePath "" → formatted to "/".
    const r = validateIr({ surface: 'x', ecosystem: '*', layout: { kind: 'stack' } });
    expect(r.ok).toBe(false);
    const rootErr = r.errors.find((e) => e.keyword === 'required');
    expect(rootErr).toBeDefined();
    expect(rootErr?.path).toBe('/');
    // ajv surfaces the missing property name in params.missingProperty.
    expect(rootErr?.params.missingProperty).toBe('irVersion');
  });

  it('collects ALL errors (allErrors:true), not just the first', () => {
    // Two independent violations: bad irVersion pattern + extra top-level prop.
    const r = validateIr({ ...minimalSpec, irVersion: '1.0.0', bogusField: true });
    expect(r.ok).toBe(false);
    const keywords = new Set(r.errors.map((e) => e.keyword));
    expect(keywords.has('pattern')).toBe(true); // irVersion '^0\.[0-9]+$'
    expect(keywords.has('additionalProperties')).toBe(true); // bogusField
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('omits `spec` on failure but always returns an errors array', () => {
    const r = validateIr({ totally: 'wrong' });
    expect(r.ok).toBe(false);
    expect(r.spec).toBeUndefined();
    expect(Array.isArray(r.errors)).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('every formatted error has a non-empty path and keyword', () => {
    const r = validateIr({ irVersion: 'bad', layout: 5 });
    expect(r.ok).toBe(false);
    for (const e of r.errors) {
      expect(e.path.length).toBeGreaterThan(0); // never empty: "" → "/"
      expect(e.keyword.length).toBeGreaterThan(0);
      expect(typeof e.message).toBe('string');
    }
  });
});

describe('validateIr — never throws on bad input', () => {
  const adversarial: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    true,
    [],
    {},
    { layout: { kind: { nested: 'object' } } },
    { irVersion: 0.1 }, // wrong type (number, not string)
  ];

  for (const input of adversarial) {
    it(`returns a result (no throw) for ${JSON.stringify(input) ?? String(input)}`, () => {
      let result!: ValidationResult;
      expect(() => {
        result = validateIr(input);
      }).not.toThrow();
      // Bad input → ok=false with a structured error list (never throws).
      expect(result.ok).toBe(false);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  }
});

describe('assertValidIr', () => {
  it('does not throw on a valid IR', () => {
    expect(() => assertValidIr(minimalSpec)).not.toThrow();
  });

  it('throws IrValidationError on an invalid IR', () => {
    expect(() => assertValidIr({ kind: 'wat' })).toThrow(IrValidationError);
  });

  it('the thrown error carries the same structured errors validateIr returns', () => {
    const bad = { surface: 'x', ecosystem: '*', layout: { kind: 'stack' } };
    const expected = validateIr(bad).errors;
    let caught: unknown;
    try {
      assertValidIr(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IrValidationError);
    const err = caught as IrValidationError;
    expect(err.name).toBe('IrValidationError');
    expect(err.message).toBe(`IR validation failed: ${expected.length} error(s)`);
    expect(err.errors).toEqual(expected);
    expect(err.errors.length).toBeGreaterThan(0);
  });

  it('narrows the input to UiIr after a successful assertion', () => {
    const candidate: unknown = {
      irVersion: IR_VERSION,
      surface: 's',
      ecosystem: 'e',
      layout: { kind: 'text' },
    };
    assertValidIr(candidate);
    // After the assertion, `candidate` is typed UiIr — reading a UiIr-only
    // field type-checks AND returns the expected runtime value.
    expect(candidate.surface).toBe('s');
  });
});

describe('IrValidationError', () => {
  it('is an Error subclass with a stable name and exposed errors', () => {
    const errs = [{ path: '/x', message: 'm', keyword: 'k', params: {} }];
    const e = new IrValidationError(errs);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(IrValidationError);
    expect(e.name).toBe('IrValidationError');
    expect(e.errors).toBe(errs);
    expect(e.message).toBe('IR validation failed: 1 error(s)');
  });
});
