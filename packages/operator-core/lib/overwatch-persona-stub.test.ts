/**
 * overwatch-persona-stub.test.ts — the D-007 anti-drift guard
 * (overwatch-role-2026-06-15 B-01, the EI-611 lesson).
 *
 * EI-611: the Queen has TWO full personas — a fallback and the blueprint
 * `blueprints/hive/prompts/queen.md` — that silently DRIFT; shared instructions
 * repeatedly land in the dead fallback while the live blueprint Queen runs without
 * them. The overwatch must NOT repeat that: its canonical persona ships ONCE in the
 * hive blueprint (B-05), and the base-library fallback
 * `blueprints/base/prompts/overwatch.md` (which exists only so an `overwatch` spawn
 * outside the hive blueprint still resolves to *a* prompt via the universal base
 * library) is a THIN STUB that points at the blueprint and adds no instructions.
 *
 * (Phase 5: the legacy global fallback `prompts/overwatch.md` was deleted with the
 * global prompts/ dir; the base library is now the no-blueprintId fallback home.)
 *
 * This pins that: a refactor that grows the fallback into a second full persona
 * (the exact EI-611 failure) trips here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { harnessPath } from './harness-paths';

const STUB = harnessPath('blueprints', 'base', 'prompts', 'overwatch.md');
const CANONICAL = harnessPath('blueprints', 'hive', 'prompts', 'overwatch.md');

describe('overwatch persona — one canonical home, the fallback stays a stub (D-007 / EI-611)', () => {
  it('the canonical persona lives in the hive blueprint and is a SUBSTANTIAL persona', () => {
    const canonical = readFileSync(CANONICAL, 'utf8');
    // The real persona — mandate, health model, nudge-not-replace, observe/escalate,
    // turn-end reflection, declare-next-wake. It is long; pin a generous floor.
    expect(canonical.split('\n').length).toBeGreaterThan(80);
  });

  it('the fallback prompts/overwatch.md is a THIN STUB, not a second full persona', () => {
    const stub = readFileSync(STUB, 'utf8');
    const canonical = readFileSync(CANONICAL, 'utf8');
    // A stub is small in absolute terms…
    expect(stub.split('\n').length).toBeLessThan(60);
    // …and far smaller than the canonical (the anti-drift signal — if someone
    // copies the persona into the fallback, this ratio collapses and the test trips).
    expect(stub.length).toBeLessThan(canonical.length / 3);
  });

  it('the stub announces itself as a stub AND points at the canonical blueprint path', () => {
    const stub = readFileSync(STUB, 'utf8');
    expect(stub).toMatch(/stub/i);
    // The explicit anti-drift instruction (D-007's prescribed wording).
    expect(stub).toMatch(/do not add/i);
    // Points readers/authors at the one canonical home.
    expect(stub).toContain('blueprints/hive/prompts/overwatch.md');
  });
});
