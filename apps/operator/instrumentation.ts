/**
 * Next.js instrumentation hook — top-level edge-safe shim.
 *
 * Next runs instrumentation in BOTH the Node runtime and the Edge
 * Runtime variants. The actual boot work (pty WS, schema pre-warm,
 * backup scheduler, plugin grants backfill, generated-schema self-
 * repair) is all Node-only — it uses node:fs, node:child_process,
 * process.cwd, etc. Putting those at module load (even transitively
 * via static imports inside the same file) makes Turbopack mark
 * every route that imports the bundled instrumentation as Edge-
 * incompatible, which cascades into "Invalid segment configuration
 * export detected" at page-data collection (the bug we hit
 * 2026-05-11 across many prod build attempts).
 *
 * The fix is small: this file does NOTHING but check the runtime
 * and dynamically import `instrumentation-node` when we're on the
 * Node runtime. The Edge variant of this file never reaches the
 * Node import, so its static-analysis graph stays clean.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { register: registerNode } = await import('./instrumentation-node');
  await registerNode();
}
