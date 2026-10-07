import { BRIEF_ADMIN, PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { SU_RUBRIC } from '../../rubrics/su';
import { effectiveToolCall } from './_asserts';

const REPORT_BODY = '# Architecture review\n\n## Findings\nThe queue reader uses the shared visibility predicate.\n\n## Verdict\nThe reviewed boundary is verified.\n\n```mermaid\ngraph TD; A[Publish] --> B[Library]\n```';
const result = (data: unknown) => ({ ok: true as const, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const world: ToolDispatchOverride = {
  override(name, args) {
    if (name === 'reports:publish') return result({ ok: true, report_id: 'rpt_fixture', path: '/reports?sel=rpt_fixture',
      body_md: args.body_md, visibility: args.visibility ?? 'owner' });
    if (name === 'reports:get') return result({ ok: true, results: [{ id: 'rpt_fixture', ok: true,
      report: { report_id: 'rpt_fixture', path: '/reports?sel=rpt_fixture', body_md: REPORT_BODY, visibility: 'owner' } }], counts: { ok: 1, failed: 0 } });
    return PASS_THROUGH;
  },
};

export const SU_S38_REPORTS_CAPTURE: Scenario = {
  id: 'su-S38-reports-capture', version: 1, target: 'su', transport: 'in-process',
  description: 'The approved audit is finished in AUTO/self, and all source and test verification is already complete. '
    + 'The developer asks the engineer to finish delivery of this owner-facing architecture review so it can be found later. '
    + 'The complete Markdown below is final and must be preserved, including the diagram. No implementation remains.\n\n' + REPORT_BODY,
  persona: BRIEF_ADMIN, goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 240, maxCostUsd: 2 },
  runMatrix: { repeat: 1, variancePolicy: 'flag-if-stddev>0.5' }, toolOverride: world, rubric: SU_RUBRIC,
  asserts: [{ kind: 'custom', name: 'complete-private-report-published-and-read-back', eval(run) {
    const calls = run.turns.flatMap(turn => turn.toolCalls).map(effectiveToolCall);
    const publish = calls.find(call => call.name === 'reports:publish' && call.input.body_md === REPORT_BODY
      && (call.input.visibility === undefined || call.input.visibility === 'owner'));
    const readBack = calls.some(call => call.name === 'reports:get' &&
      (call.input.id === 'rpt_fixture' || Array.isArray(call.input.ids) && call.input.ids.includes('rpt_fixture')));
    return publish && readBack ? [] : [{ assertKind: 'custom:complete-private-report-published-and-read-back', severity: 'error',
      claim: 'The finished owner-facing review must be published in full with private visibility and read back before delivery is claimed.' }];
  } }],
};
