/**
 * Guard: the operator's DEFAULT memory backend must be `hybrid-pg`, AND that
 * name must actually be registered by the time anything resolves it
 * (memory-declaude-and-defaults-2026-07-28 P-002 / D-002, D-003).
 *
 * Why this is a test and not just a constant: the default name and the
 * registration that satisfies it live in DIFFERENT layers, and neither one
 * fails loudly when they drift apart at authoring time.
 *
 * - The default is chosen in ./backend-selection (operator).
 * - `hybrid-pg` is registered in ./configure (operator) — NOT by
 *   @papercusp/memory, whose built-in registry holds only `mem0` + `noop`.
 *
 * So a well-intentioned edit that renames the registration, moves it behind a
 * condition, or "tidies" the default to a name the lib knows (`mem0`) breaks
 * production in one of two silent ways: either every memory call throws
 * `unknown memory backend`, or — worse, because it looks fine — memory quietly
 * serves the cosine-only ranking that measured 53% recall@10 against
 * hybrid-pg's 98%. Neither shows up in a typecheck.
 */
import { describe, expect, it } from 'vitest';
import { registeredMemoryBackends } from '@papercusp/memory';
import { DEFAULT_MEMORY_BACKEND } from './backend-selection';

// Side-effect import: this is what registers `hybrid-pg` (and the rest of the
// operator's backends). The assertions below are meaningless without it — that
// coupling IS the thing under test.
import './configure';

describe('default memory backend (memory-declaude-and-defaults-2026-07-28 P-002)', () => {
  it('is hybrid-pg — the backend that won the live recall A/B, not mem0', () => {
    // 39/40 (98%) recall@10 vs mem0's 21/40 (53%) on the 40-pair live A/B.
    // Both back onto the SAME memory_canonical rows, so this is a ranking
    // choice, never a storage one — see D-002.
    expect(DEFAULT_MEMORY_BACKEND).toBe('hybrid-pg');
  });

  it('names a backend that is actually REGISTERED (an unknown name throws at first use)', () => {
    expect(registeredMemoryBackends()).toContain(DEFAULT_MEMORY_BACKEND);
  });

  it('keeps mem0 registered — @papercusp/memory\'s own fallback must stay resolvable', () => {
    // backend-registry.ts falls back to 'mem0' for hosts that register nothing.
    // If that name ever stops resolving, every unconfigured host throws instead
    // of degrading (D-003: this is exactly why the LIB default was NOT flipped
    // to hybrid-pg along with the operator's).
    expect(registeredMemoryBackends()).toContain('mem0');
  });
});
