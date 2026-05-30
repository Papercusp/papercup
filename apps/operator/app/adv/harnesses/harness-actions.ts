// Shared write-action helpers for the /adv Harness tab. Used by the
// Features/Issues panel rows (Phase 5 inline actions) and mirror the
// contracts the Detail pane uses. Callers own the toast + busy state so
// they can attach row context.

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

export async function featureReset(slug: string, id: string): Promise<void> {
  await post(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(id)}/reset?phase=staging`);
}

export type IssueActionKind = 'promote' | 'acknowledge' | 'close' | 'wontfix';

export async function issueAction(slug: string, id: string, action: IssueActionKind): Promise<void> {
  const base = `/api/harness/${encodeURIComponent(slug)}/issues/${encodeURIComponent(id)}`;
  if (action === 'promote') {
    await post(`${base}/promote`, {});
  } else {
    await post(`${base}/update`, { status: action === 'acknowledge' ? 'acknowledged' : action });
  }
}

export function openAdminFeature(slug: string, id: string): void {
  window.open(
    `/admin/features?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`,
    '_blank',
    'noopener',
  );
}
