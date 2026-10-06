/**
 * POST /api/desktop/report-problem — the desktop "Report a problem" door
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048, D-013).
 *
 * Body: { payload, previewDigest }. `payload` is exactly the object the dialog
 * rendered in its Review step (problem-report.ts), and `previewDigest` is
 * sha256 of its canonical JSON. The route:
 *   1. parses with a STRICT schema: an unknown key anywhere is refused (400);
 *   2. recomputes the digest and refuses a mismatch (409 preview-mismatch);
 *   3. refuses a payload `buildProblemReport` would not have produced, such as
 *      unredacted text or an over-long field (422 not-as-previewed);
 *   4. files through the ONE intake (`intakeEndUserReport`, reporterKind
 *      'end-user'), so the P-013 quoting and redaction run again server-side;
 *   5. stores a ticked log excerpt in the consented-attachment store, door
 *      'desktop', idempotent per digest.
 * Response: { routed: 'work-item' | 'memory', id, attachments }.
 *
 * Anonymous: no reporter identity is taken from the request.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { PLATFORM_POT_SLUG } from '../../../platform-pot-slug';
import {
  intakeEndUserReport,
  type EndUserReportInput,
  type EndUserReportResult,
} from '../../../harness/improvements/end-user-intake';
import {
  putReportAttachment,
  type PutReportAttachmentInput,
  type PutReportAttachmentResult,
} from '../../../harness/improvements/report-attachments';
import {
  PROBLEM_REPORT_APP,
  PROBLEM_REPORT_LIMITS as L,
  PROBLEM_REPORT_SCHEMA_VERSION,
  isNormalizedProblemReport,
  previewDigest,
  type ProblemReportPayload,
} from '../../../harness/improvements/problem-report';

/** The attachment-store door name for this dialog (D-048 pt 4). */
export const REPORT_PROBLEM_DOOR = 'desktop';

const errorSchema = z
  .object({
    at: z.string().max(40).nullable(),
    source: z.string().max(L.errorSource).nullable(),
    message: z.string().min(1).max(L.errorMessage),
  })
  .strict();

const payloadSchema = z
  .object({
    schemaVersion: z.literal(PROBLEM_REPORT_SCHEMA_VERSION),
    text: z.string().min(1).max(L.text),
    context: z
      .object({
        app: z.literal(PROBLEM_REPORT_APP),
        appVersion: z.string().max(L.appVersion).nullable(),
        screen: z
          .object({
            route: z.string().min(1).max(L.route),
            state: z.record(z.string().max(L.stateKey), z.string().max(L.stateValue)).nullable(),
          })
          .strict()
          .nullable(),
        recentErrors: z.array(errorSchema).max(L.recentErrors),
      })
      .strict(),
    attachments: z
      .array(
        z
          .object({
            kind: z.literal('log'),
            mime: z.literal('text/plain'),
            lineCount: z.number().int().min(1).max(L.logLines),
            content: z.string().min(1).max(L.logLines * (L.logLine + 1)),
          })
          .strict(),
      )
      .max(1),
  })
  .strict();

export const reportProblemBodySchema = z
  .object({
    payload: payloadSchema,
    previewDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export interface ReportProblemDeps {
  intake: (input: EndUserReportInput) => Promise<EndUserReportResult>;
  putAttachment: (input: PutReportAttachmentInput) => Promise<PutReportAttachmentResult>;
  workspaceId: () => string;
}

export function defaultReportProblemDeps(): ReportProblemDeps {
  return {
    intake: (input) => intakeEndUserReport(input),
    putAttachment: (input) => putReportAttachment(input),
    workspaceId: activeWorkspaceId,
  };
}

export type ReportProblemAttachmentOutcome =
  | { kind: 'log'; ok: true; id: string; deduplicated: boolean }
  | { kind: 'log'; ok: false; reason: string };

export type ReportProblemOutcome =
  | {
      status: 200;
      body: { routed: 'work-item' | 'memory'; id: string | null; attachments: ReportProblemAttachmentOutcome[] };
    }
  | { status: 400 | 409 | 422; body: { error: string; detail?: unknown } };

function workItemIdOf(result: Extract<EndUserReportResult, { routed: 'work-item' }>): string | null {
  return result.capture.issue?.id ?? result.capture.coalescedOnto?.id ?? null;
}

/** The whole door, minus HTTP. Exported for tests. */
export async function handleReportProblem(
  body: unknown,
  deps: ReportProblemDeps = defaultReportProblemDeps(),
): Promise<ReportProblemOutcome> {
  const parsed = reportProblemBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'invalid report', detail: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) },
    };
  }
  const payload = parsed.data.payload as ProblemReportPayload;
  const digest = await previewDigest(payload);
  if (digest !== parsed.data.previewDigest) {
    return { status: 409, body: { error: 'preview-mismatch', detail: 'the payload differs from the one the preview showed' } };
  }
  if (!isNormalizedProblemReport(payload)) {
    return { status: 422, body: { error: 'not-as-previewed', detail: 'the payload is not what the Report a problem dialog builds' } };
  }

  const workspaceId = deps.workspaceId();
  const { context } = payload;
  const result = await deps.intake({
    text: payload.text,
    workspaceId,
    // A note about the app is kept in the platform Pot's pool, where its bugs go too.
    noteScope: `harness:${PLATFORM_POT_SLUG}`,
    reportContext: {
      app: context.app,
      appVersion: context.appVersion,
      screen: context.screen ? { url: null, route: context.screen.route, state: context.screen.state } : null,
      recentErrors: context.recentErrors,
    },
  });

  if (result.routed === 'memory') {
    return { status: 200, body: { routed: 'memory', id: result.memoryIds[0] ?? null, attachments: [] } };
  }

  const id = workItemIdOf(result);
  const attachments: ReportProblemAttachmentOutcome[] = [];
  for (const [index, attachment] of payload.attachments.entries()) {
    if (!id) {
      attachments.push({ kind: attachment.kind, ok: false, reason: 'no work item id to attach to' });
      continue;
    }
    // A failed attachment never fails the report: the text is already filed.
    const stored = await deps
      .putAttachment({
        workspaceId,
        workItemId: id,
        door: REPORT_PROBLEM_DOOR,
        kind: attachment.kind,
        mime: attachment.mime,
        content: attachment.content,
        externalId: `${digest}:${index}`,
      })
      .catch((err: unknown): PutReportAttachmentResult => ({
        ok: false,
        reason: 'invalid',
        detail: err instanceof Error ? err.message : String(err),
      }));
    attachments.push(
      stored.ok
        ? { kind: attachment.kind, ok: true, id: stored.id, deduplicated: stored.deduplicated }
        : { kind: attachment.kind, ok: false, reason: `${stored.reason}: ${stored.detail}` },
    );
  }
  return { status: 200, body: { routed: 'work-item', id, attachments } };
}

const post = defineTool({
  method: 'POST',
  path: '/desktop/report-problem',
  auth: {},
  async handler(req) {
    const body = await req.json().catch(() => null);
    const outcome = await handleReportProblem(body);
    return Response.json(outcome.body, { status: outcome.status });
  },
});

export default post;
