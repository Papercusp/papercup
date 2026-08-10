/**
 * P-005 / WI-37791 — the install's resolved libs/generic root.
 *
 * The regression under test is not "the resolver returns a path"; it is that a
 * builder agent is never again handed the dev-checkout-relative example
 * `file:../papercusp/libs/generic/<pkg>` as if it were actionable. So the
 * load-bearing assertions are the NEGATIVE ones: what the surfaces must refuse
 * to say when this install has no tree.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveGenericLibsRoot,
  genericLibsDependencySpec,
  describeSupplyChain,
  VENDORED_IN_TEMPLATE,
  type GenericLibsRootVerdict,
} from './generic-libs-root';

/** The exact string the README documented and that must never be prescribed. */
const DEV_CHECKOUT_EXAMPLE = 'file:../papercusp/libs/generic/';

const FAKE_TREE = '/opt/papercusp-install/dev-source';
const FAKE_GENERIC = join(FAKE_TREE, 'libs', 'generic');

function withTree(overrides: Parameters<typeof resolveGenericLibsRoot>[0] = {}) {
  return resolveGenericLibsRoot({
    detectSourceRoot: () => FAKE_TREE,
    exists: (p) => p === FAKE_GENERIC,
    listPackages: () => ['sync', 'ui-primitives', 'template-kit'],
    detectArchivePending: () => false,
    ...overrides,
  });
}

describe('resolveGenericLibsRoot', () => {
  it('resolves <sourceRoot>/libs/generic and enumerates what is actually there', () => {
    const v = withTree();
    expect(v.root).toBe(FAKE_GENERIC);
    expect(v.sourceRoot).toBe(FAKE_TREE);
    expect(v.available).toEqual(['sync', 'ui-primitives', 'template-kit']);
    expect(v.pending).toBe(false);
  });

  it('reports the dev-source-tree leg when the extracted-bundle env names that root', () => {
    const prev = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    process.env.PAPERCUSP_DEV_SOURCE_ROOT = FAKE_TREE;
    try {
      expect(withTree().source).toBe('dev-source-tree');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_DEV_SOURCE_ROOT;
      else process.env.PAPERCUSP_DEV_SOURCE_ROOT = prev;
    }
  });

  it('reports the integration-root leg when no extracted bundle names that root', () => {
    const prev = process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    delete process.env.PAPERCUSP_DEV_SOURCE_ROOT;
    try {
      expect(withTree().source).toBe('integration-root');
    } finally {
      if (prev !== undefined) process.env.PAPERCUSP_DEV_SOURCE_ROOT = prev;
    }
  });

  it('answers root:null when the source root resolves but libs/generic is absent', () => {
    const v = resolveGenericLibsRoot({
      detectSourceRoot: () => FAKE_TREE,
      exists: () => false,
      detectArchivePending: () => false,
    });
    expect(v.root).toBeNull();
    expect(v.source).toBe('none');
  });

  it('separates a TRANSIENT absence (archive still extracting) from the real gap', () => {
    const stillExtracting = resolveGenericLibsRoot({
      detectSourceRoot: () => null,
      detectArchivePending: () => true,
    });
    expect(stillExtracting.root).toBeNull();
    expect(stillExtracting.pending).toBe(true);
    expect(stillExtracting.explanation).toMatch(/transient/i);

    const realGap = resolveGenericLibsRoot({
      detectSourceRoot: () => null,
      detectArchivePending: () => false,
    });
    expect(realGap.pending).toBe(false);
    // The gap must name its known cause so the reader is not left guessing.
    expect(realGap.explanation).toMatch(/macOS/);
    expect(realGap.explanation).toMatch(/WI-37790/);
  });

  it('never throws when the detectors or filesystem probes blow up', () => {
    const v = resolveGenericLibsRoot({
      detectSourceRoot: () => {
        throw new Error('boom');
      },
      detectArchivePending: () => {
        throw new Error('also boom');
      },
    });
    expect(v.root).toBeNull();
    expect(v.pending).toBe(false);
  });
});

describe('genericLibsDependencySpec', () => {
  it('routes the VENDORED packages to the template dir, never to libs/generic', () => {
    const v = withTree();
    for (const pkg of VENDORED_IN_TEMPLATE) {
      expect(genericLibsDependencySpec(pkg, v)).toBe(`file:./${pkg}`);
    }
    // ...including when libs/generic happens to contain a copy of one (it does).
    expect(v.available).toContain('template-kit');
    expect(genericLibsDependencySpec('template-kit', v)).toBe('file:./template-kit');
  });

  it('emits an ABSOLUTE file: spec for a package that is really present', () => {
    const spec = genericLibsDependencySpec('sync', withTree());
    expect(spec).toBe(`file:${join(FAKE_GENERIC, 'sync')}`);
    // Absolute, therefore never the dev-checkout-relative form.
    expect(spec).not.toContain(DEV_CHECKOUT_EXAMPLE);
    expect(spec?.startsWith('file:/')).toBe(true);
  });

  it('answers null rather than guessing, for a package this install does not have', () => {
    expect(genericLibsDependencySpec('grid-core', withTree())).toBeNull();
  });

  it('answers null for every non-vendored package when there is no tree', () => {
    const none = resolveGenericLibsRoot({
      detectSourceRoot: () => null,
      detectArchivePending: () => false,
    });
    expect(genericLibsDependencySpec('sync', none)).toBeNull();
    // The vendored ones still work — they do not depend on the tree (D-001).
    expect(genericLibsDependencySpec('pot-app-seam', none)).toBe('file:./pot-app-seam');
  });
});

describe('describeSupplyChain — the builder-facing text', () => {
  it('names the real absolute root and a worked example when a tree exists', () => {
    const text = describeSupplyChain(withTree());
    expect(text).toContain(FAKE_GENERIC);
    expect(text).toContain(`file:${join(FAKE_GENERIC, 'sync')}`);
  });

  it('states the gap loudly instead of falling silent when there is no tree', () => {
    const text = describeSupplyChain(
      resolveGenericLibsRoot({ detectSourceRoot: () => null, detectArchivePending: () => false }),
    );
    expect(text).toMatch(/CANNOT be file:-linked/);
    expect(text).toMatch(/⚠/);
  });

  /**
   * THE REGRESSION GUARD. Whatever else these surfaces say, none of them may
   * PRESCRIBE the dev-checkout-relative path — that is the instruction that sent
   * builders to a tree that does not exist on an install.
   *
   * Both branches legitimately MENTION the path, in opposite framings ("do NOT
   * write this" when there is no tree; "a RELATIVE path like … only works in a
   * dev checkout" when there is one), so an allowlist of phrasings is the wrong
   * shape — it passes for the sentence someone happened to write rather than for
   * the property that matters. Instead, every occurrence is checked IN CONTEXT:
   * a negation must sit next to it. A future edit that drops the negation and
   * leaves the path standing as advice fails here, which is the whole point.
   */
  it('never prescribes the dev-checkout-relative path on any surface', () => {
    const NEGATED =
      /do not write|only works inside a dev checkout|not what this install|never|instead of/i;
    const cases: GenericLibsRootVerdict[] = [
      withTree(),
      resolveGenericLibsRoot({ detectSourceRoot: () => null, detectArchivePending: () => false }),
      resolveGenericLibsRoot({ detectSourceRoot: () => null, detectArchivePending: () => true }),
    ];
    for (const v of cases) {
      for (const pkg of ['sync', 'ui-primitives', 'template-kit', 'pot-app-seam']) {
        expect(genericLibsDependencySpec(pkg, v) ?? '').not.toContain(DEV_CHECKOUT_EXAMPLE);
      }
      const text = describeSupplyChain(v);
      let from = 0;
      for (;;) {
        const at = text.indexOf(DEV_CHECKOUT_EXAMPLE, from);
        if (at === -1) break;
        const context = text.slice(Math.max(0, at - 160), at + 160);
        expect(context, `unnegated dev-checkout path in: ${context}`).toMatch(NEGATED);
        from = at + DEV_CHECKOUT_EXAMPLE.length;
      }
    }
  });
});
