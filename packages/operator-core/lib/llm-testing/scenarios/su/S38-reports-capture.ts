import { BRIEF_ADMIN, PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';
import { SU_RUBRIC } from '../../rubrics/su';
import { effectiveToolCall } from './_asserts';
import publishTool from '../../../agent-tools/reports/publish';
import getTool from '../../../agent-tools/reports/get';
import { REPORT_BODY_MAX_BYTES } from '../../../report-library';

export const REPORT_BODY = '# Architecture review\n\n## Findings\nThe queue reader uses the shared visibility predicate.\n\n## Verdict\nThe reviewed boundary is verified.\n\n```mermaid\ngraph TD; A[Publish] --> B[Library]\n```';
const result = (data: unknown) => ({ ok: true as const, content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
// Reuse the actual tool schema: permissive fixture success previously certified
// kind="architecture-review", which production refuses. This is an isolated
// delivery fixture, not a claim that the production database was exercised.
export function createReportsCaptureWorld(): ToolDispatchOverride {
  let saved: { report_id: string; path: string; body_md: string; visibility: string } | undefined;
  return { override(name, args) {
    if (name === 'reports:publish') {
      const parsed = publishTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false, error: 'invalid_field', message: parsed.error.message });
      const input = parsed.data;
      if (Buffer.byteLength(input.body_md ?? '', 'utf8') > REPORT_BODY_MAX_BYTES)
        return result({ ok: false, error: 'body_too_large' });
      if (input.subject && input.subject.kind !== 'none' && !input.subject.ref)
        return result({ ok: false, error: 'subject_ref_required' });
      if (input.supersedes) return result({ ok: false, error: 'supersedes_not_found' });
      saved = { report_id: 'rpt_fixture', path: '/reports?sel=rpt_fixture',
        body_md: input.body_md ?? '', visibility: input.visibility ?? 'owner' };
      return result({ ok: true, ...saved });
    }
    if (name === 'reports:get') {
      const parsed = getTool.args.safeParse(args);
      if (!parsed.success) return result({ ok: false, error: 'invalid_field', message: parsed.error.message });
      const ids = parsed.data.ids ?? [parsed.data.id!];
      const results = ids.map(id => saved?.report_id === id
        ? { id, ok: true, report: { ...saved } }
        : { id, ok: false, error: 'not_found' });
      const failed = results.filter(row => !row.ok).length;
      return result({ ok: failed === 0, results, counts: { ok: results.length - failed, failed } });
    }
    return PASS_THROUGH;
  } };
}

export const SU_S38_REPORTS_CAPTURE: Scenario = {
  id: 'su-S38-reports-capture', version: 3, target: 'su', transport: 'in-process',
  description: 'The approved audit is finished in AUTO/self, and all source and test verification is already complete. '
    + 'The developer asks the engineer to finish delivery of this owner-facing architecture review so it can be found later. '
    + 'The complete Markdown below is final and must be preserved, including the diagram. No implementation remains.\n\n' + REPORT_BODY,
  persona: BRIEF_ADMIN, goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  targetConfig: { modes: ['auto'] },
  // The review must reach the SUT verbatim. A free-form simulator previously
  // omitted it and invented a docs/ file-save request, changing the task tested.
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message',
    text: 'The approved architecture review is complete. Finish delivery to me so I can find it later. '
      + 'Preserve this final Markdown unchanged, including its diagram. All implementation and verification are finished.\n\n' + REPORT_BODY }],
  simUserContext: 'You asked the engineer to finish delivery of the completed review. '
    + 'The first message already contains its complete final Markdown. Success means a saved, private Reports citation; '
    + 'do not invent a repository file path or ask for implementation.',
  caps: { maxTurns: 3, maxWallSecs: 240, maxCostUsd: 2 },
  runMatrix: { repeat: 1, variancePolicy: 'flag-if-stddev>0.5' }, toolOverride: createReportsCaptureWorld(), rubric: SU_RUBRIC,
  asserts: [{ kind: 'custom', name: 'complete-private-report-published-and-read-back', eval(run) {
    const calls = run.turns.flatMap((turn, turnIndex) => turn.toolCalls.map((call, index) => {
      const evidence = turn.toolResults?.[index];
      let output: Record<string, unknown> | undefined;
      if (evidence && !evidence.isError && !evidence.truncated) {
        try { output = JSON.parse(evidence.output); } catch { /* Unreadable result proves no success. */ }
      }
      return { ...effectiveToolCall(call), output, turnIndex, responseIndex: call.responseIndex };
    }));
    const publishIndex = calls.findIndex(call => call.name === 'reports:publish' && publishTool.args.safeParse(call.input).success
      && call.input.body_md === REPORT_BODY && !call.input.supersedes
      && (!call.input.subject || (call.input.subject as { kind?: string; ref?: string }).kind === 'none'
        || !!(call.input.subject as { ref?: string }).ref)
      && call.output?.ok === true && call.output.report_id === 'rpt_fixture'
      && (call.input.visibility === undefined || call.input.visibility === 'owner'));
    const published = calls[publishIndex];
    const readBack = publishIndex >= 0 && calls.slice(publishIndex + 1).some(call => {
      const crossedResult = call.turnIndex > published.turnIndex
        || call.responseIndex !== undefined && published.responseIndex !== undefined
          && call.responseIndex > published.responseIndex;
      const results = call.output?.results as Array<{ id?: string; ok?: boolean; report?: { body_md?: string; visibility?: string } }> | undefined;
      return crossedResult && call.name === 'reports:get' && getTool.args.safeParse(call.input).success
        && (call.input.id === 'rpt_fixture' || Array.isArray(call.input.ids) && call.input.ids.includes('rpt_fixture'))
        && call.output?.ok === true && Array.isArray(results) && results.some(row => row.id === 'rpt_fixture'
          && row.ok === true && row.report?.body_md === REPORT_BODY && row.report.visibility === 'owner');
    });
    return readBack ? [] : [{ assertKind: 'custom:complete-private-report-published-and-read-back', severity: 'error',
      claim: 'The finished owner-facing review must be published in full with private visibility and read back before delivery is claimed.' }];
  } }],
};
