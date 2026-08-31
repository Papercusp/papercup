/**
 * The coord:send `blockedOn` describe strings in message-fields.ts PROMISE that a
 * work-item ref is awaitable as `work-item:done:<id>`. That promise is prose
 * restating a key the emitter (work-items-events.ts) owns — exactly the
 * code-describing-metadata shape the derive/pin/attest ladder pins at rung 2
 * instead of leaving to a human re-read (rung 4).
 *
 * Origin: vetting finding on rubric acceptance-coord-derived-fields-2026-08-31
 * (consult conv-mthflplu-0000-9236728af9a44b709935c7e13d0de113): the drift
 * marker "a describe promising an await key that does not exist" was only
 * checkable by reading work-items-events.ts by hand. This test makes that
 * drift impossible instead of merely documented.
 *
 * Sibling of gate-candidate-ref.test.ts — same P-004 family: fixture controls
 * are load-bearing (once the live assertion goes green it stops being evidence
 * the detector works), and a failed/short read REFUSES rather than passing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MESSAGE_FIELDS = join(
  ROOT,
  'packages/operator-core/lib/agent-tools/coordination/message-fields.ts',
);
const WORK_ITEMS_EVENTS = join(ROOT, 'packages/operator-core/lib/work-items-events.ts');

interface AwaitKeyVerdict {
  ok: boolean;
  promisedPrefixes: string[];
  emittedPrefixes: string[];
  violations: string[];
}

/** A prose promise of an awaitable work-item key: `work-item:<verb>:<id>`. */
const PROMISE_RE = /work-item:([a-z-]+):<id>/g;
/** A real emit site: a template literal building `work-item:<verb>:${…}`. */
const EMIT_RE = /`work-item:([a-z-]+):\$\{/g;

/**
 * Every key the describe PROMISES must have an emit site producing that exact
 * prefix. Refuses short/empty reads and a describe that stopped promising any
 * key — the promise disappearing is a detector failure, never a pass (the
 * vacuous-negative shape the meta-acceptance-rubric names).
 */
function judgeAwaitKeyCorrespondence(
  describeSource: string,
  emitterSource: string,
): AwaitKeyVerdict {
  if (describeSource.length < 200) {
    throw new Error('Refusing to judge: describe source too short — a failed read must never look like a passing pin');
  }
  if (emitterSource.length < 200) {
    throw new Error('Refusing to judge: emitter source too short — a failed read must never look like a passing pin');
  }
  const promisedPrefixes = [
    ...new Set([...describeSource.matchAll(PROMISE_RE)].map((m) => `work-item:${m[1]}:`)),
  ];
  const emittedPrefixes = [
    ...new Set([...emitterSource.matchAll(EMIT_RE)].map((m) => `work-item:${m[1]}:`)),
  ];
  if (promisedPrefixes.length === 0) {
    throw new Error('Refusing to judge: no promised await key found in the describe source — the promise disappearing is a detector failure, not a pass');
  }
  const violations = promisedPrefixes
    .filter((p) => !emittedPrefixes.includes(p))
    .map((p) => `describe promises \`${p}<id>\` but no emit site produces that key`);
  return { ok: violations.length === 0, promisedPrefixes, emittedPrefixes, violations };
}

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'// filler\n'.repeat(30)}`;

describe('blockedOn await-key describe↔emitter pin', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches a describe promising a key no emitter produces', () => {
      const verdict = judgeAwaitKeyCorrespondence(
        pad('reader can await `work-item:completed:<id>` on this'),
        pad('emit({ key: `work-item:done:${wi.id}` });'),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/work-item:completed:/);
    });

    it('passes when the promise and the emit site agree', () => {
      const verdict = judgeAwaitKeyCorrespondence(
        pad('reader can await `work-item:done:<id>` on this'),
        pad('emit({ key: `work-item:done:${wi.id}` });'),
      );
      expect(verdict.ok).toBe(true);
      expect(verdict.promisedPrefixes).toEqual(['work-item:done:']);
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      expect(() => judgeAwaitKeyCorrespondence('', pad('x'))).toThrow(/Refusing to judge/);
      expect(() => judgeAwaitKeyCorrespondence(pad('x'), '')).toThrow(/Refusing to judge/);
    });

    it('REFUSES a describe that stopped promising any key (vacuity guard)', () => {
      // If the promise is deleted from the prose, the pin must not silently pass.
      const verdict = () =>
        judgeAwaitKeyCorrespondence(
          pad('this describe no longer mentions any awaitable key at all'),
          pad('emit({ key: `work-item:done:${wi.id}` });'),
        );
      expect(verdict).toThrow(/no promised await key/);
    });
  });

  describe('the live claim', () => {
    const describeSource = readFileSync(MESSAGE_FIELDS, 'utf8');
    const emitterSource = readFileSync(WORK_ITEMS_EVENTS, 'utf8');

    it('positive control: both real files were actually read', () => {
      expect(describeSource).toMatch(/blockedOn/i);
      expect(describeSource.split('\n').length).toBeGreaterThan(300);
      expect(emitterSource).toMatch(/work-item:done:/);
      expect(emitterSource.split('\n').length).toBeGreaterThan(300);
    });

    it('every await key the blockedOn describe promises has a real emit site', () => {
      const verdict = judgeAwaitKeyCorrespondence(describeSource, emitterSource);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('the taught `work-item:done:<id>` key exists end-to-end (promise AND emitter)', () => {
      const verdict = judgeAwaitKeyCorrespondence(describeSource, emitterSource);
      expect(verdict.promisedPrefixes).toContain('work-item:done:');
      expect(verdict.emittedPrefixes).toContain('work-item:done:');
    });
  });
});
