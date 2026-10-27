/**
 * testing:record-native-check — execute a registered native operational check and
 * record it in test_runs with execution-time runtime witnesses.
 *
 * The native-check registry lives here, not in record-run.ts: live spec bindings
 * pin record-run.ts, so adding a check to it makes other plans' evidence
 * non-current (EI-26555275260059787). New checks are a new arm of this union plus
 * their own module; record-run.ts stays untouched.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';
import { executeConsultReceiptMatrix } from './native-check-consult-receipts';

export default defineTool({
  name: 'testing:record-native-check',
  description:
    'Execute a registered native operational check and record it in test_runs with before/after runtime witnesses, ' +
    'so a live-plane binding can read environment-current. consultReceiptMatrix:{evidenceFile} re-verifies a committed ' +
    'get-feedback receipt matrix against the operator database in one read-only snapshot.',
  guidance: {
    when: 'A live-plane acceptance bar needs a runtime-witnessed operational row and a registered native check covers it.',
    notWhen: 'Not for Vitest (testing:run) or importing an already-completed artifact (testing:record-run evidenceFile).',
    chaining: 'Bind the returned testRunIds with plans:bind-spec-evidence, details.evidencePlane matching the bar.',
  },
  capability: 'testing:run',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    harness: harnessArg,
    consultReceiptMatrix: z.object({
      evidenceFile: z.string().min(1).max(400)
        .describe('Repo-relative committed docs/evidence/*.json receipt-matrix artifact whose cells are re-verified.'),
    }).strict(),
  }),
  async handler(args, ctx) {
    const harnessSlug = resolveConcreteHarnessSlug(args.harness, ctx);
    if (!harnessSlug) return harnessRequiredResult('testing:record-native-check', ctx);
    return { data: await executeConsultReceiptMatrix(args.consultReceiptMatrix.evidenceFile, { ...ctx, harnessSlug }) };
  },
});
