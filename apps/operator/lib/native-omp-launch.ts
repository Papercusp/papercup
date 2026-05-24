/**
 * native-omp-launch.ts — renderer-side launcher for the power-user
 * OMP agent (the `omp`-mode sibling of native-console.ts's shell
 * launcher).
 *
 * Kept in its own module rather than folded into native-console.ts so
 * the two launch paths stay independently editable — the shell path
 * sees frequent churn around WebKit CORS workarounds.
 *
 * POSTs to /api/agent-mcp/console/launch with `mode: 'omp'`; the
 * operator mints power-user tokens and spawns a native terminal
 * running `papercusp-omp connect`. See
 * docs/plans/omp-power-user-bundle-2026-05-20.md §4.4.
 */

import type { LaunchOpts } from './native-console';

/** Result of an `omp`-mode launch attempt. */
export interface OmpLaunchResult {
  ok: boolean;
  /** Set to 'omp_not_installed' when OMP / @papercusp/omp aren't on PATH. */
  code?: 'omp_not_installed';
  error?: string;
  /** The `npm i -g …` line to show when code === 'omp_not_installed'. */
  installCmd?: string;
}

/**
 * Launch a power-user OMP agent session.
 *
 * Always uses POST (never the Image().src GET hack the shell path
 * uses) because we need the JSON body back to detect
 * `omp_not_installed`. content-type text/plain keeps it a CORS
 * "simple request" so WebKit's broken preflight is sidestepped.
 */
export async function launchOmpAgent(opts: LaunchOpts): Promise<OmpLaunchResult> {
  const endpoints: string[] = [];
  if (typeof window !== 'undefined') {
    const loc = window.location;
    if (loc.protocol === 'http:' || loc.protocol === 'https:') {
      endpoints.push('/api/agent-mcp/console/launch');
    }
  }
  // Tauri webview / fallback — try prod then dev operator ports.
  endpoints.push('http://localhost:3070/api/agent-mcp/console/launch');
  endpoints.push('http://localhost:3055/api/agent-mcp/console/launch');

  let lastError = 'no spawn path available';
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          slug: opts.slug,
          mode: 'omp',
          planSlug: opts.planSlug ?? null,
          label: opts.label ?? null,
          resumeSessionId: opts.resumeSessionId ?? null,
        }),
      });
      const data = (await r.json().catch(() => null)) as
        | { status?: string; code?: string; error?: string; installCmd?: string }
        | null;
      if (!data) {
        lastError = `console/launch HTTP ${r.status} (no body)`;
        continue;
      }
      if (data.code === 'omp_not_installed') {
        return {
          ok: false,
          code: 'omp_not_installed',
          error: data.error,
          installCmd: data.installCmd,
        };
      }
      if (r.ok && data.status === 'ok') return { ok: true };
      lastError = data.error ?? `console/launch HTTP ${r.status}`;
      // Keep trying the fallback ports — a wrong-port hit is the most
      // likely first-endpoint failure in the Tauri webview.
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}
