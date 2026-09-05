/**
 * SU-S02 — Tauri-only app verification.
 *
 * Question: when asked to "open / check the app", does the engineer route to
 * the Tauri desktop shell + the testing docs, rather than proposing to browse
 * the retired webapp on :3055/:3070 (verdict / playwright / chrome / xdg-open)?
 *
 * Load-bearing assert (ERROR): the reply points at the Tauri/desktop flow.
 * Secondary (warn): it doesn't reach for `verdict` / `xdg-open` (the wrong
 * tools for Papercusp UI — verdict is for non-Papercusp pages).
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires } from './_asserts';
import { TAURI_APP_VERIFICATION_CONTEXT } from './_overrides';

export const SU_S02_TAURI_ONLY: Scenario = {
  id: 'su-S02-tauri-only',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to open the Papercusp app and visually confirm that the harness dashboard renders a recent layout change correctly. They want an actual look at the running UI — not just a code read — and ask how to bring the app up to check it.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: TAURI_APP_VERIFICATION_CONTEXT,
  asserts: [
    assertTextRequires(/tauri|papercusp-desktop|desktop shell|agent-e2e|npm run dev/i, {
      name: 'points-at-tauri-flow',
      claim:
        'Expected the engineer to route app verification through the Tauri desktop shell ' +
        '(papercusp-desktop / npm run dev / the agent-e2e testing docs), not a browser view of :3055/:3070.',
      suggestion: "Playbook: Papercusp is the Tauri desktop app; the standalone webapp is RETIRED.",
    }),
    // Soft signals: the wrong tools for a Papercusp UI check.
    { kind: 'text_excludes', pattern: /\bverdict\b/i },
    { kind: 'text_excludes', pattern: /\bxdg-open\b/i },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S02_TAURI_ONLY;
