/**
 * wake-vs-inject-axis.test.ts — pins the wake-vs-inject decision axis in the
 * follow-verb family's agent-facing metadata (linking-notify-family-hardening
 * P-001 / WI-4053, decision D-001).
 *
 * The axis is the invisible seam agents reliably fail on: topics:subscribe and
 * work_items:subscribe INJECT into the next turn and never re-invoke an idle
 * session, while events:await is the ONLY waking verb and is one-shot. These
 * assertions read the SOURCE TEXT (not the compiled modules) so the guard has
 * zero import side effects and survives handler refactors — it fails only if
 * a rewording drops the axis declaration itself.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/__tests__/wake-vs-inject-axis.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('wake-vs-inject axis stays declared at tool choice (D-001)', () => {
  it('work_items:subscribe declares inject-only + never-wakes and points at events:await', () => {
    const src = read('../work_items/subscribe.ts');
    expect(src).toMatch(/inject-only/i);
    expect(src).toMatch(/never WAKES/i);
    expect(src).toMatch(/events:await/);
    // the shared enum is disambiguated, not just enumerated
    expect(src).toMatch(/digest = coalesced/i);
    expect(src).toMatch(/mention = only @-mentions/i);
  });

  it('topics:subscribe declares inject-only + never-wakes and points at events:await', () => {
    const src = read('../coordination/tools/topics-subscribe.ts');
    expect(src).toMatch(/inject-only/i);
    expect(src).toMatch(/never WAKES/i);
    expect(src).toMatch(/events:await/);
    expect(src).toMatch(/digest = coalesced/i);
  });

  it('events:await declares itself the one-shot WAKE verb', () => {
    const src = read('../events/await.ts');
    expect(src).toMatch(/one-shot WAKE/i);
    expect(src).toMatch(/can never wake-loop/i);
  });

  it('events:await guidance carries the happy-path recipe + the unblocked-key caution (P-004)', () => {
    const src = read('../events/await.ts');
    // recipe: announce → await the RETURNED key → end turn → re-register for the next occurrence
    expect(src).toMatch(/announce:true/);
    expect(src).toMatch(/RETURNED key/);
    expect(src).toMatch(/one-shot: a fired await is gone/);
    // interim caution until the registration-time latch (P-006) covers unblocked keys
    expect(src).toMatch(/work-item:unblocked:<id>/);
    expect(src).toMatch(/STILL blocked before awaiting/);
  });

  it('the su engineer prompt maps all three follow verbs onto the axis in ONE block', () => {
    const prompt = read('../../../../../apps/operator/prompts/papercusp-su-engineer.tools.md');
    const start = prompt.indexOf('notify ≠ wake');
    expect(start).toBeGreaterThan(-1);
    const block = prompt.slice(start, start + 900);
    expect(block).toContain('topics:subscribe');
    expect(block).toContain('work_items:subscribe');
    expect(block).toContain('events:await');
    expect(block).toMatch(/inject-only/i);
    expect(block).toMatch(/one-shot/i);
  });
});
