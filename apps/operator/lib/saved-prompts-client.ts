/**
 * saved-prompts-client.ts — browser fetch helpers for the saved-prompts CRUD
 * endpoint (`/api/agent-mcp/saved-prompts`). Used by the SavedPromptsSection
 * settings module on both the harness-settings and personalization pages.
 *
 * No `?harness=` ⇒ workspace-global scope; `?harness=<slug>` ⇒ that harness.
 */

export interface SavedPrompt {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  name: string;
  body: string;
  description: string | null;
  argHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavePromptInput {
  harness?: string | null;
  name: string;
  body: string;
  description?: string | null;
  argHint?: string | null;
}

const BASE = '/api/agent-mcp/saved-prompts';

function scopeQuery(harness?: string | null): string {
  return harness ? `?harness=${encodeURIComponent(harness)}` : '';
}

export async function fetchSavedPrompts(harness?: string | null): Promise<SavedPrompt[]> {
  const res = await fetch(`${BASE}${scopeQuery(harness)}`);
  if (!res.ok) throw new Error(`Failed to load saved prompts (${res.status})`);
  const json = (await res.json()) as { prompts: SavedPrompt[] };
  return json.prompts;
}

export async function saveSavedPrompt(input: SavePromptInput): Promise<SavedPrompt> {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = (await res.json().catch(() => ({}))) as { prompt?: SavedPrompt; error?: string; detail?: string };
  if (!res.ok) throw new Error(json.detail || json.error || `Save failed (${res.status})`);
  return json.prompt as SavedPrompt;
}

export async function deleteSavedPrompt(name: string, harness?: string | null): Promise<void> {
  const sep = harness ? '&' : '';
  const harnessParam = harness ? `${sep}harness=${encodeURIComponent(harness)}` : '';
  const res = await fetch(`${BASE}?name=${encodeURIComponent(name)}${harnessParam}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}
