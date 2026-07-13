/**
 * validateManifestEventDeclarations — the semantic layer over the JSON-schema
 * shape check for the events-as-a-dependency axis
 * (cupboard-public-release-2026-07-12 D-003 / P-005).
 *
 * Pins the buildKey contract a declared family must satisfy: unique family ids,
 * and keyTemplate `<placeholder>` ↔ params bidirectional consistency, so a
 * declared family can actually build concrete keys downstream (P-006/P-007).
 */
import { describe, it, expect } from 'vitest';
import { validateManifestEventDeclarations } from './index';

describe('validateManifestEventDeclarations (D-003 / P-005)', () => {
  it('passes a well-formed provides.events + dependencies.events', () => {
    expect(
      validateManifestEventDeclarations({
        provides: {
          events: [
            { family: 'a', keyTemplate: 'a:done:<id>', params: [{ name: 'id', required: true, describe: 'id' }] },
            { family: 'b', keyTemplate: 'b:heartbeat' },
          ],
        },
        dependencies: { events: [{ family: 'a' }, { family: 'c', optional: true }] },
      }),
    ).toEqual([]);
  });

  it('passes an empty / absent manifest', () => {
    expect(validateManifestEventDeclarations({})).toEqual([]);
    expect(validateManifestEventDeclarations({ provides: null, dependencies: null })).toEqual([]);
  });

  it('flags a duplicate provided family', () => {
    const issues = validateManifestEventDeclarations({
      provides: {
        events: [
          { family: 'a', keyTemplate: 'a:1' },
          { family: 'a', keyTemplate: 'a:2' },
        ],
      },
    });
    expect(issues.some((i) => /duplicate family "a"/.test(i))).toBe(true);
  });

  it('flags a keyTemplate placeholder with no matching params entry', () => {
    const issues = validateManifestEventDeclarations({
      provides: { events: [{ family: 'a', keyTemplate: 'a:done:<id>' }] },
    });
    expect(issues.some((i) => /placeholder "<id>" has no matching params/.test(i))).toBe(true);
  });

  it('flags a params entry absent from the keyTemplate', () => {
    const issues = validateManifestEventDeclarations({
      provides: {
        events: [{ family: 'a', keyTemplate: 'a:done', params: [{ name: 'id', required: true, describe: 'x' }] }],
      },
    });
    expect(issues.some((i) => /params entry "id" does not appear/.test(i))).toBe(true);
  });

  it('accepts a multi-placeholder template with matching params (order-free)', () => {
    expect(
      validateManifestEventDeclarations({
        provides: {
          events: [
            {
              family: 'plan-item',
              keyTemplate: 'plan-item:done:<slug>:<id>',
              params: [
                { name: 'id', required: true, describe: 'item id' },
                { name: 'slug', required: true, describe: 'plan slug' },
              ],
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('flags a missing family in provides and in dependencies', () => {
    const issues = validateManifestEventDeclarations({
      provides: { events: [{ family: '', keyTemplate: 'a:b' }] },
      dependencies: { events: [{ family: '  ' }] },
    });
    expect(issues.some((i) => /provides\.events\[0\] — missing family/.test(i))).toBe(true);
    expect(issues.some((i) => /dependencies\.events\[0\] — missing family/.test(i))).toBe(true);
  });
});
