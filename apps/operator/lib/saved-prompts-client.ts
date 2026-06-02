/**
 * saved-prompts-client.ts — browser fetch helpers for the saved-prompts CRUD
 * endpoint (`/api/agent-mcp/saved-prompts`). Used by the SavedPromptsSection
 * settings module on both the harness-settings and personalization pages.
 *
 * No `?harness=` ⇒ workspace-global scope; `?harness=<slug>` ⇒ that harness.
 *
 * Hardened for the desktop WebView (D-010). Two platform hazards, both
 * dodged the way the rest of the app does:
 *   1. SSE socket-pool starvation — the settings shell holds long-lived SSE
 *      streams that consume the WebView's 6-socket/origin budget, so a
 *      same-origin write can hang waiting for a free socket. We route every
 *      request through `crossOriginUrl()` (the localhost⇄127.0.0.1 sibling
 *      host), which has its own fresh socket pool the SSE streams never
 *      touch — the same fix the commit-diff read uses.
 *   2. WebKitGTK silently fails CORS preflight handshakes. Going cross-origin
 *      would trigger a preflight for a PUT/DELETE, so writes are CORS-"simple"
 *      requests instead: POST + `content-type: text/plain` and no custom
 *      headers ⇒ no preflight. The server reads the body with `req.json()`
 *      regardless of content-type; the global `/api/*` host CORS reflects the
 *      loopback origin on the response.
 * `crossOriginUrl` is a no-op off a loopback host (e.g. tauri.localhost), so
 * these stay same-origin where sharding doesn't apply.
 */
import { crossOriginUrl } from './cross-origin-url';

/** Simple-request POST: text/plain body, no custom headers ⇒ no CORS preflight. */
const SIMPLE_POST = { 'content-type': 'text/plain' } as const;

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
  const res = await fetch(crossOriginUrl(`${BASE}${scopeQuery(harness)}`));
  if (!res.ok) throw new Error(`Failed to load saved prompts (${res.status})`);
  const json = (await res.json()) as { prompts: SavedPrompt[] };
  return json.prompts;
}

export async function saveSavedPrompt(input: SavePromptInput): Promise<SavedPrompt> {
  const res = await fetch(crossOriginUrl(BASE), {
    method: 'POST',
    headers: SIMPLE_POST,
    body: JSON.stringify(input),
  });
  const json = (await res.json().catch(() => ({}))) as { prompt?: SavedPrompt; error?: string; detail?: string };
  if (!res.ok) throw new Error(json.detail || json.error || `Save failed (${res.status})`);
  return json.prompt as SavedPrompt;
}

export async function deleteSavedPrompt(name: string, harness?: string | null): Promise<void> {
  const res = await fetch(crossOriginUrl(`${BASE}/remove`), {
    method: 'POST',
    headers: SIMPLE_POST,
    body: JSON.stringify({ name, harness: harness ?? null }),
  });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}
