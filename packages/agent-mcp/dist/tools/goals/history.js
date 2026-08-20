/**
 * One append-only history for facts learned ABOUT a goal and amendments made
 * TO it. The established workspace audit_log is the store: goal history is a
 * projection, not a second ledger or a mutable metadata array.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const GOAL_EVIDENCE_ACTION = 'goal:evidence';
export const GOAL_AMENDMENT_ACTION = 'goal:amendment';
export const GOAL_HISTORY_LIMIT = 100;
/** Add one field only when its persisted semantic value really moved. */
export function addGoalFieldChange(changes, field, before, after) {
    const normalizedBefore = before ?? null;
    const normalizedAfter = after ?? null;
    if (!isDeepStrictEqual(normalizedBefore, normalizedAfter)) {
        changes.push({ field, before: normalizedBefore, after: normalizedAfter });
    }
}
export async function appendGoalHistory(sql, input) {
    const atMs = input.atMs ?? Date.now();
    const id = input.id ?? `goal-${randomUUID()}`;
    const action = input.detail.kind === 'amendment' ? GOAL_AMENDMENT_ACTION : GOAL_EVIDENCE_ACTION;
    await sql `
    INSERT INTO harness_shared.audit_log
      (id, ts, actor, action, subject, details, workspace_id)
    VALUES
      (${id}, ${atMs}, ${input.author}, ${action}, ${input.goalId}, ${JSON.stringify(input.detail)}::jsonb, ${input.workspaceId})
  `;
    return historyEntry({ id, ts: atMs, actor: input.author, action, details: input.detail });
}
function objectOf(v) {
    if (v && typeof v === 'object' && !Array.isArray(v))
        return v;
    if (typeof v === 'string') {
        try {
            const parsed = JSON.parse(v);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : {};
        }
        catch {
            return {};
        }
    }
    return {};
}
function historyEntry(row) {
    const d = objectOf(row.details);
    const atMs = Number(row.ts);
    const at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(0).toISOString();
    if (row.action === GOAL_AMENDMENT_ACTION) {
        return {
            id: row.id,
            kind: 'amendment',
            author: row.actor,
            at,
            reason: typeof d.reason === 'string' ? d.reason : 'not recorded',
            reasonSource: d.reasonSource === 'caller' ? 'caller' : 'generated',
            changes: Array.isArray(d.changes) ? d.changes : [],
        };
    }
    const kind = d.kind === 'finding' ? 'finding' : 'evidence';
    return {
        id: row.id,
        kind,
        author: row.actor,
        at,
        summary: typeof d.summary === 'string' ? d.summary : '',
        ...(typeof d.detail === 'string' ? { detail: d.detail } : {}),
        ...(Array.isArray(d.refs) ? { refs: d.refs.filter((r) => typeof r === 'string') } : {}),
    };
}
export async function readGoalHistory(sql, input) {
    const limit = Math.max(1, Math.min(input.limit ?? GOAL_HISTORY_LIMIT, GOAL_HISTORY_LIMIT));
    const rows = await sql `
    SELECT id, ts, actor, action, details
      FROM harness_shared.audit_log
     WHERE workspace_id = ${input.workspaceId}
       AND subject = ${input.goalId}
       AND action = ANY(${[GOAL_AMENDMENT_ACTION, GOAL_EVIDENCE_ACTION]}::text[])
     ORDER BY ts DESC, id DESC
     LIMIT ${limit + 1}
  `;
    return {
        entries: rows.slice(0, limit).map(historyEntry),
        truncated: rows.length > limit,
        limit,
    };
}
