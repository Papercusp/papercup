/**
 * SU-S03 — push, not poll.
 *
 * Question: asked to make a panel live-update, does the engineer reach for a
 * push transport (SSE on web / IPC on desktop, via @papercusp/sync) rather
 * than defaulting to a polling loop?
 *
 * Load-bearing assert (ERROR): the reply credits a push transport. Secondary
 * (warn): it doesn't propose a bare polling loop.
 */

import { PEDANTIC_DEV } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires } from './_asserts';

export const SU_S03_PUSH_NOT_POLL: Scenario = {
  id: 'su-S03-push-not-poll',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer wants a small panel that live-updates: as fleet agents change state, the panel should refresh on its own without the user reloading. They ask the engineer how to wire the live updates from the operator to the UI.',
  persona: PEDANTIC_DEV,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertTextRequires(
      /\b(SSE|server-sent|IPC|pg_notify|LISTEN\/NOTIFY|useSyncQuery|useSync|@papercusp\/sync|EventSource)\b/i,
      {
        name: 'credits-push-transport',
        claim:
          'Expected the engineer to wire live updates via a push transport ' +
          '(SSE/IPC through @papercusp/sync), not a polling loop.',
        suggestion: "Playbook: don't default to polling — push (IPC on desktop, SSE on web); route data through @papercusp/sync.",
      },
    ),
    // Soft signal: a bare polling loop is the anti-pattern.
    { kind: 'text_excludes', pattern: /\b(setInterval|polling|poll the|every \d+\s?(s|sec|secs|ms|seconds))\b/i },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S03_PUSH_NOT_POLL;
