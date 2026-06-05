/**
 * In-process dispatch of the plans:* READ tools.
 *
 * Shared by the two server surfaces that need the EXACT same canonical
 * read logic (file-based plan reads) so they can't drift:
 *   - `/api/admin/plans/:verb` GET — the verified-admin Plans UI surface.
 *   - the `@papercusp/sync` named-query resolvers (`plans.*` live queries
 *     in apps/operator/lib/sync-resolver) consumed by `useSyncQuery`.
 *
 * Both synthesize a superuser ctx (`?superuser=1` + validateSuperuser),
 * which is safe because the operator host is loopback-bound — the same
 * security model the rest of `/admin/*` + the public rest-query endpoint
 * already rely on.
 */
import { handleHttpToolRequest, type HttpToolHostExtras } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (defineTool calls),
// including all plans:* tools. Same import the agent-tools catch-all uses.
import '../index';
import { PROJECTED_DEPS } from '../../projected-tool-deps';

const ADMIN_UI_CLIENT_ID = 'pc-admin-plans-ui';

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
};

export interface PlansReadResult {
  status: number;
  /** Unwrapped JSON (the tool's text envelope, parsed) on 200; the raw
   *  tool error body otherwise. */
  data: unknown;
}

/**
 * Dispatch a plans READ verb in-process. Never throws — non-200 surfaces
 * via `status` + `data` (the tool's error envelope). The admin route uses
 * this to build its `Response`.
 */
export async function callPlansReadRaw(
  verb: string,
  body: Record<string, unknown>,
): Promise<PlansReadResult> {
  const sp = new URLSearchParams();
  sp.set('superuser', '1');
  sp.set('client', ADMIN_UI_CLIENT_ID);
  const b: Record<string, unknown> = { ...body };
  // /adv works at operator scope on Papercusp's own plans; default the
  // harness gate to 'all' (→ papercup) unless the caller passed one.
  if (b.harness == null) b.harness = 'all';
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: sp,
      headers: {},
      body: b,
    },
    HOST_EXTRAS,
  );
  if (result.status === 200) {
    const rb = result.body as { content?: Array<{ type: string; text?: string }> };
    const text = rb.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return { status: 200, data: JSON.parse(text) };
      } catch {
        return { status: 200, data: text };
      }
    }
    return { status: 200, data: {} };
  }
  return { status: result.status, data: result.body };
}

/**
 * Resolver convenience: dispatch a read and THROW on non-200 (the
 * rest-query route maps the throw to HTTP 500). Returns the unwrapped
 * JSON object (e.g. `{ plans: [...] }`).
 */
export async function callPlansRead(
  verb: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const r = await callPlansReadRaw(verb, body);
  if (r.status !== 200) {
    const err = (r.data as { error?: unknown } | null)?.error;
    throw new Error(typeof err === 'string' ? err : `plans:${verb} → ${r.status}`);
  }
  return r.data;
}
