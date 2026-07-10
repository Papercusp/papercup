/**
 * publish-blueprint-visibility.test.ts — the publish-time public-visibility gate
 * for blueprint listings (cupboard-full-dogfood-2026-07-10 P-002 guardrail).
 *
 * A blueprint is publishable to the public Cupboard ONLY when its blueprint.yaml
 * declares `visibility: public`. These tests pin that the gate is fail-closed:
 * absent, wrong-cased, typo'd, or non-object manifests all resolve to 'internal'
 * and 422 — so nothing leaks onto the public listing by default.
 */
import { describe, it, expect } from 'vitest';
import {
  assertBlueprintVisibilityPublishable,
  readBlueprintVisibility,
  BlueprintVisibilityError,
} from './publish-blueprint-visibility';

describe('readBlueprintVisibility', () => {
  it("returns 'public' only for an exact visibility: 'public'", () => {
    expect(readBlueprintVisibility({ visibility: 'public' })).toBe('public');
  });

  it("returns 'internal' when the marker is absent", () => {
    expect(readBlueprintVisibility({ id: 'coding', kind: 'harness' })).toBe('internal');
  });

  it("returns 'internal' for any non-exact value (fail-closed)", () => {
    for (const bad of ['internal', 'Public', 'PUBLIC', 'pubic', true, 1, null, ['public']]) {
      expect(readBlueprintVisibility({ visibility: bad } as unknown)).toBe('internal');
    }
  });

  it("returns 'internal' for a non-object / array / null manifest", () => {
    for (const bad of [null, undefined, 'public', 42, ['visibility', 'public']]) {
      expect(readBlueprintVisibility(bad as unknown)).toBe('internal');
    }
  });
});

describe('assertBlueprintVisibilityPublishable', () => {
  it('accepts a blueprint explicitly marked visibility: public', () => {
    expect(assertBlueprintVisibilityPublishable('coding', { id: 'coding', visibility: 'public' })).toBe('public');
  });

  it('422s an unmarked blueprint (internal by default)', () => {
    expect(() => assertBlueprintVisibilityPublishable('audit', { id: 'audit', kind: 'harness' })).toThrow(
      BlueprintVisibilityError,
    );
    try {
      assertBlueprintVisibilityPublishable('audit', { id: 'audit' });
    } catch (e) {
      expect((e as BlueprintVisibilityError).status).toBe(422);
      expect(String((e as Error).message)).toContain('visibility: public');
    }
  });

  it('422s a blueprint explicitly marked visibility: internal', () => {
    expect(() =>
      assertBlueprintVisibilityPublishable('papercup', { visibility: 'internal' }),
    ).toThrow(BlueprintVisibilityError);
  });

  it("422s a typo'd / wrong-cased marker (never leaks on a near-miss)", () => {
    for (const bad of ['Public', 'PUBLIC', 'pubic', 'public ']) {
      expect(() => assertBlueprintVisibilityPublishable('x', { visibility: bad })).toThrow(BlueprintVisibilityError);
    }
  });
});
