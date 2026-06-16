/**
 * su-launch-cwd.ts — resolve the working directory a psu superuser session
 * launches in, guarding the prompt-isolation leak EI-202.
 *
 * A no-harness `psu` launch prefers the launcher's OWN cwd (`process.cwd()`, the
 * user's terminal) so the agent's cwd-scoped resume works from where the user is.
 * But Claude Code auto-loads PROJECT-level memory from the cwd — `<cwd>/CLAUDE.md`
 * and `<cwd>/.claude/CLAUDE.md`. When the launcher's cwd is the user's `$HOME`,
 * those "project files" ARE the owner's personal config (`~/CLAUDE.md` +
 * `~/.claude/CLAUDE.md` → the personal memory rules), re-importing exactly what
 * the per-session `CLAUDE_CONFIG_DIR` skip-links out of GLOBAL memory (P-002).
 * The config-dir isolation can't catch this because cwd project-memory is a
 * separate discovery path it doesn't govern.
 *
 * So: a psu session must never run in `$HOME`. The internal workspace root
 * (`envelopeCwd` — `papercuspPathForWorkspace`, always under `~/.papercusp/…`,
 * never `$HOME`) carries no personal memory, so a `$HOME` cwd is relocated there.
 * A cwd one or more levels below `$HOME` (the repo, a project dir, the internal
 * dir) is left untouched — only the exact-`$HOME` case hits the personal
 * `CLAUDE.md` / `.claude/CLAUDE.md` as cwd-level project files.
 *
 * Pure + dependency-free so the deterministic psu prompt-isolation guard
 * (P-005) can assert it without booting the route.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function resolveSuLaunchCwd(opts: {
  /** The chosen harness slug, or null for a no-harness (workspace-root) launch. */
  harnessSlug: string | null;
  /** The launcher's own `process.cwd()` (no-harness launches prefer it). */
  callerCwd: string | null;
  /** The internal workspace-root cwd from the console envelope — never `$HOME`. */
  envelopeCwd: string;
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
}): string {
  // A harness launch always runs in the harness repo (envelope.cwd), never the
  // caller's terminal — so it can't be $HOME and needs no guard.
  if (opts.harnessSlug) return opts.envelopeCwd;
  const preferred = opts.callerCwd || opts.envelopeCwd;
  const home = opts.home ?? homedir();
  // EI-202: at $HOME the cwd-level CLAUDE.md / .claude/CLAUDE.md ARE the owner's
  // personal config — relocate to the internal workspace root, which has neither.
  return resolve(preferred) === resolve(home) ? opts.envelopeCwd : preferred;
}
