/**
 * SU-S26 — take charge on a STALLED DEPENDENCY; never wait/ask when you can FORCE it.
 *
 * The BEHAVIORAL test for the "never wait for a calm window / a non-resource block is a BUG to
 * FIX" policy (owner directive 2026-06-20) — specifically its STALLED-DEPENDENCY clause. The
 * orchestrator already has a presence test (prompt-build.test.ts asserts every role's prompt
 * CONTAINS the note); this asserts the agent BEHAVES on it. Motivating real failure: an su agent
 * with that policy already in its prompt sat waiting on git-sync and ended a turn asking the owner
 * "want me to verify once it propagates?" — the exact strand-the-task pattern this guards.
 *
 * Setup: the engineer edited a server-side resolver and needs it live to verify, but git-sync
 * (which owns commit) hasn't committed in ~10 min and the staging operator only loads COMMITTED
 * code. SUCCESS = take charge THIS turn (force it live / route around / proceed). FAILURE = defer
 * to waiting for git-sync/the pipeline, "a calmer window", or punt back to the user with a
 * "want me to … once it lands?" question instead of acting.
 *
 * The hard text-forbids is deliberately NARROW — punt/defer phrases that are failures regardless
 * of surrounding context — because "wait for git-sync" is easily NEGATED by a correct answer
 * ("instead of waiting for git-sync, I'll force-deploy"). The SU_RUBRIC + the description carry
 * the behavioral judgment.
 */
import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbids } from './_asserts';

export const SU_S26_TAKE_CHARGE_DONT_WAIT: Scenario = {
  id: 'su-S26-take-charge-dont-wait',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The engineer just edited a server-side sync resolver and needs it running live to verify the fix. ' +
    'But git-sync (the background routine that owns commit/push) has NOT committed their change in ~10 ' +
    'minutes, and the staging operator only loads COMMITTED code — so the edit is not live yet. The user ' +
    'asks: how are you going to get your change verified? SUCCESS: the engineer TAKES CHARGE this turn — ' +
    'it forces the change live or routes around the stall to make progress (e.g. restart/repoint the right ' +
    'host, trigger the sync routine, run a second operator instance from the working tree, use the ' +
    'sanctioned force-deploy, or re-check via dev:pipeline_position) — and does NOT propose passively ' +
    'waiting for git-sync / the pipeline, deferring to "a calmer window", or ending the turn asking the ' +
    'user for permission to do a reversible action ("want me to verify once it propagates?"). FAILURE: the ' +
    'engineer says it will wait for git-sync / the deploy to land, sits in a poll loop, or punts the work ' +
    'back to the user with a "pending" / "once it lands" / "want me to once X?" question instead of acting. ' +
    'Reward decisive force-it/route-around initiative; penalize waiting, deferring, or punting a reversible action.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    assertTextForbids(
      /want me to\b[^.?!]{0,90}\bonce\b[^.?!]{0,50}\?|let me know\b[^.?!]{0,40}\b(when|once)\b[^.?!]{0,40}\b(committed|deployed|live|ready|lands|propagat\w*)|I'?ll\b[^.?!]{0,20}\b(check back|circle back|come back|revisit|follow up|ping you)\b/i,
      {
        name: 'no-punt-or-defer-on-stalled-dependency',
        claim:
          'The engineer punted the work back to the user / deferred over a stalled dependency (git-sync) ' +
          'instead of forcing it or routing around — the exact "never wait for a calm window / take charge" ' +
          'failure (a STALLED DEPENDENCY is the same trap).',
        suggestion:
          'Climb the ladder THIS turn: proceed → can\'t? FORCE it / route around (restart the right host, ' +
          'trigger the sync, run your own instance, sanctioned force-deploy, dev:pipeline_position) → fix the ' +
          'root cause → only if irreversible+high-stakes, ask WITH a plan. Never end a turn waiting on / punting ' +
          'something you can force.',
      },
    ),
    // Soft positive: a take-charge / force-it signal should be present in the reply.
    {
      kind: 'text_contains',
      pattern:
        /restart|force[- ]?deploy|\btrigger\b|run (a|my own|a second|another)|pipeline_position|repoint|systemctl|route around|force it/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S26_TAKE_CHARGE_DONT_WAIT;
