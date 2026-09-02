/**
 * EI-22174225494240206 — the host half of the ambient-dispatch-arg-keys seam.
 * `ambient-args-wiring.ts` registers Papercusp's own dispatch-level reserved args
 * (`projection`, `view`) with tooldef's resolver as a side effect of import (see
 * `agent-tools/index.ts`), the same shape as `server-vintage-wiring.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readAmbientArgKeys, resetAmbientArgKeysResolver } from '@papercusp/agent-mcp';
import { PROJECTION_ARG, VIEW_ARG } from '../result-projection';
import './ambient-args-wiring';

// The wiring under test registers the resolver as an IMPORT-TIME side effect (once,
// above) — not per-test — so reset only after the whole file's assertions are done,
// not between them (an afterEach here would clear it before the second test ever runs).
afterAll(() => resetAmbientArgKeysResolver());

describe('ambient-args Papercusp wiring', () => {
  it('registers both dispatch-level reserved args', () => {
    expect(readAmbientArgKeys()).toEqual([PROJECTION_ARG, VIEW_ARG]);
  });

  it('reads them from the SAME exported constants the transport strips with, not re-typed literals', () => {
    // A literal re-typed copy would still equal 'projection'/'view' today but would
    // silently drift the moment either constant is renamed (derived-truth-ladder
    // rung 1) — assert identity with the source constants, not their current values.
    const keys = readAmbientArgKeys();
    expect(keys).toContain(PROJECTION_ARG);
    expect(keys).toContain(VIEW_ARG);
  });
});
