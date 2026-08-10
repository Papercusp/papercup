/**
 * The lock hook ↔ `isLifecycleIntent` contract (EI-20055604348536487).
 *
 * The FIXTURE CONTROLS are load-bearing, for the reason the doc-claims family states: once the
 * live assertion goes green it stops being evidence that the detector works at all. A pin that
 * can only pass proves nothing — so each control below reproduces a re-wording that MUST be
 * caught, including the plausible ones a future editor would actually write.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHookLockIntentLiterals } from './hook-intent-label';
import { isLifecycleIntent } from '../coordination/presence-payload';

// lib/agent-tools/locks → agent-tools → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const HOOK = join(ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh');

describe('extractHookLockIntentLiterals (the detector must be able to FAIL)', () => {
  it('realizes an f-string placeholder into the value the server actually receives', () => {
    const found = extractHookLockIntentLiterals("        'intent': f'PreToolUse:{tool_name}',");
    expect(found).toEqual([
      { line: 1, raw: "f'PreToolUse:{tool_name}'", realized: 'PreToolUse:Edit' },
    ]);
  });

  it.each([
    ["        'intent': f'{tool_name} via PreToolUse',", 'Edit via PreToolUse', 'reordered'],
    ["        'intent': f'hook:{tool_name}',", 'hook:Edit', 'renamed prefix'],
    ["        'intent': 'automatic file lock',", 'automatic file lock', 'plain literal'],
    ["        'intent': f'lock for {tool_name}',", 'lock for Edit', 'prose form'],
  ])('CATCHES a re-worded label %j (%s → %s)', (line, realized) => {
    const [found] = extractHookLockIntentLiterals(line);
    expect(found.realized).toBe(realized);
    // The point of the control: these are NOT recognized, so the writer-side recovery would
    // not fire and the sentinel would flow back into the ledger unnoticed.
    expect(isLifecycleIntent(found.realized)).toBe(false);
  });

  it('reports an intent computed through a VARIABLE as unverifiable, not as clean', () => {
    // An empty result must never read as "checked and fine" — the live test below turns this
    // into a failure rather than a silent pass.
    expect(extractHookLockIntentLiterals("        'intent': computed_intent,")).toEqual([]);
  });
});

describe('the live hook’s lock intent stays recognizable to isLifecycleIntent', () => {
  it('is present and git-tracked where the pin expects it', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it('sends at least one intent literal — an empty extraction FAILS rather than passes', () => {
    const found = extractHookLockIntentLiterals(readFileSync(HOOK, 'utf8'));
    expect(found.length).toBeGreaterThan(0);
  });

  it('sends only labels the writer-side recovery will recognize', () => {
    // If this fails, the hook's label was re-worded: edit `isLifecycleIntent`
    // (coordination/presence-payload.ts) to match, or the ledger silently refills with sentinels.
    const found = extractHookLockIntentLiterals(readFileSync(HOOK, 'utf8'));
    const unrecognized = found.filter((f) => !isLifecycleIntent(f.realized));
    expect(unrecognized).toEqual([]);
  });
});
