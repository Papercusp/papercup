/** Consume the holder's serialized continuation in a fresh process on the integration fixture's database. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { _resetForTests, withWorkspace } from '@papercusp/db-org';
import getGoal from '../../agent-mcp/src/tools/goals/get.ts';
import type { GoalReportPage } from '../lib/goal-related-reports.ts';

type Page = Extract<GoalReportPage, { entries: unknown[] }>;
export type RecoveredGoalReportPages = { pid: number; pages: Page[] };
const request: { workspaceId: string; harnessSlug: string; ownerId: string; next: NonNullable<Page['next']> } =
  JSON.parse(readFileSync(0, 'utf8'));
const pages: Page[] = [];
const seen = new Set<string>();

try {
  let next: Page['next'] = request.next;
  while (next) {
    assert.equal(next.tool, getGoal.name);
    const args = getGoal.args.parse(next.args);
    assert.ok(args.reportCursor && !seen.has(args.reportCursor), 'Expected a new continuation token');
    seen.add(args.reportCursor);
    const result = await withWorkspace(request.workspaceId, async tx => getGoal.handler(args, {
      tx, workspaceId: request.workspaceId, harnessSlug: request.harnessSlug, ownerId: request.ownerId,
    } as never));
    const page = (result as { data: { historyContext: { relatedReports: Page } } }).data.historyContext.relatedReports;
    assert.equal(page.status, 'available');
    pages.push(page);
    next = page.next;
  }
  process.stdout.write(JSON.stringify({ pid: process.pid, pages } satisfies RecoveredGoalReportPages));
} finally {
  await _resetForTests();
}
