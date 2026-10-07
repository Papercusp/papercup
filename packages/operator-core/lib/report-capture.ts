/** Adapt existing persisted verdicts/cards to the same immutable publisher. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { ReportBlock } from '@papercusp/chat-protocol';
import type { ReportKind, ReportSubject } from './report-library';
import { publishReportWithEffects } from './report-publication';
import { reportsLibraryDisabled } from './agent-tools/reports/_shared';

interface CaptureOrigin {
  workspaceId: string;
  ownerId: string;
  harnessSlug?: string | null;
  sessionRef?: string | null;
}

async function capture(origin: CaptureOrigin, source: string, ref: string, title: string,
  bodyMd: string, kind: ReportKind, subject: ReportSubject = { kind: 'none' }) {
  if (!origin.workspaceId || origin.workspaceId === '*' || !origin.ownerId || await reportsLibraryDisabled()) return null;
  try {
    const { report } = await publishReportWithEffects(getOrgPg().sql, {
      workspaceId: origin.workspaceId, title, bodyMd: `${bodyMd}\n\nSource reference: ${ref}\n`, kind,
      subject, source: `capture:${source}`, visibility: 'owner', tags: [`capture:${source}`],
      requestKey: `capture:${source}:${createHash('sha256').update(ref).digest('hex')}`,
    }, { authorOwnerId: origin.ownerId, harnessSlug: origin.harnessSlug,
      authorSessionRef: origin.sessionRef ?? ref }, message => console.warn(message));
    return report.reportId;
  } catch (error) {
    // The original card/verdict already exists. Preserve its control-plane
    // success and file a source-addressable failure for retry instead of losing it.
    const { captureImprovement } = await import('./harness/improvements/capture-core');
    await captureImprovement({ title: 'Reports automatic capture failed', kind: 'bug',
      body: `Capture ${source} failed for ${ref}: ${String(error)}. The source remains persisted; retry the adapter with this exact source reference.`,
      createdBy: origin.ownerId, filedByRole: 'su',
    });
    return null;
  }
}

export async function captureCoordReport(options: CaptureOrigin & { msgId: string; summary: string; report: ReportBlock }) {
  // A GOAL reference already points at a published exact snapshot; retain that
  // citation instead of manufacturing a second report from its notification.
  if (options.report.goalReport) return options.report.goalReport.reportId;
  const lines = options.report.plans.flatMap(plan => [
    `## ${plan.title}${plan.status ? ` (${plan.status})` : ''}`,
    ...(plan.summary ? [plan.summary] : []),
    ...(plan.items ?? []).map(item => `- ${item.id ? `${item.id}: ` : ''}${item.text}${item.status ? ` (${item.status})` : ''}${item.ref ? ` — ${item.ref}` : ''}`), '',
  ]);
  const plan = options.report.plans.length === 1 ? options.report.plans[0] : undefined;
  return capture(options, 'coord', options.msgId, options.report.title || options.summary,
    lines.join('\n'), 'status-digest', plan?.slug ? { kind: 'plan', ref: plan.slug, label: plan.title } : { kind: 'none' });
}

export async function captureAcceptanceVerdict(options: CaptureOrigin & {
  issueId: string; rubricRef: string; title: string; planSlug?: string | null;
  body?: string; ratings: unknown; acceptance?: unknown;
}) {
  const body = [options.body || '', `Rubric: ${options.rubricRef}`, '```json',
    JSON.stringify({ ratings: options.ratings, acceptance: options.acceptance ?? null }, null, 2), '```'].join('\n');
  return capture(options, 'acceptance', options.issueId, options.title, body, 'review',
    options.planSlug ? { kind: 'plan', ref: options.planSlug } : { kind: 'none' });
}

export async function captureAuditCompletion(options: CaptureOrigin & {
  itemId: string; completionRef?: string | null; title: string; completion: { summary: string };
}) {
  const { getModes } = await import('./modes/store');
  const modes = await getModes(options.workspaceId, options.ownerId);
  if (!modes.some(mode => mode.mode === 'audit')) return null;
  return capture(options, 'audit', options.completionRef ?? options.itemId, options.title,
    `${options.completion.summary}\n\n\`\`\`json\n${JSON.stringify(options.completion, null, 2)}\n\`\`\``,
    'audit', { kind: 'work_item', ref: options.itemId });
}
