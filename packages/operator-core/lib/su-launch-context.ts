/**
 * Launch-context composer for the `psu` / `*-su` launch path.
 *
 * When `psu` (or the /adv "Launch SU" modal) bootstraps a session, the
 * user has just picked a harness scope and (optionally) a plan to work
 * on. The static playbook the wrappers inject is profile-wide and
 * scope-agnostic — it can't say "you are on harness X" or "your bound
 * plan's Now is Y". This module composes a SHORT, launch-specific
 * addendum from those picks; `bootstrap-su` writes it to a per-launch
 * file and hands the path to the wrapper via `PAPERCUSP_LAUNCH_CONTEXT_FILE`,
 * which each client appends to its system prompt
 * (`--append-system-prompt[-file]`).
 *
 * Design (su-prompt-audit-fixes P-021/P-022, D-008): the addendum
 * *supplements* the playbook (it does not restate it — see D-001
 * pointers-not-duplication). It only has something launch-specific to
 * say when a harness OR a plan was picked; an ad-hoc workspace-level
 * launch returns '' (the playbook's no-harness section already covers
 * that case) and `bootstrap-su` then sets no env var.
 *
 * `composeLaunchContext` is pure so it is unit-tested without the route;
 * the fs write + env wiring live in `bootstrap-su.ts`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LaunchContextInput {
  /** Harness the session is scoped to, or null for a workspace-level launch. */
  harnessSlug: string | null;
  /** Plan the session is bound to, or null for an ad-hoc session. */
  planSlug: string | null;
  /** Plan title from frontmatter, if known. */
  planTitle?: string | null;
  /** The plan's `## Now` block, if the plan was readable at launch. */
  planNow?: { state: string; next: string } | null;
}

/**
 * Compose the launch-context addendum (markdown). Returns '' when there
 * is nothing launch-specific to say (no harness AND no plan).
 */
export function composeLaunchContext(input: LaunchContextInput): string {
  const { harnessSlug, planSlug, planTitle, planNow } = input;
  if (!harnessSlug && !planSlug) return '';

  const lines: string[] = [
    '# This launch',
    '',
    '> Scope + plan context for THIS `psu` launch, composed at launch time.',
    '> It supplements — it does not restate — the playbook above.',
    '',
  ];

  if (harnessSlug) {
    lines.push(
      `You launched **scoped to harness \`${harnessSlug}\`**. Your ` +
        '`docs:*`, `features:*`, `issues:*`, and `plans:*` calls serve this ' +
        "harness automatically — you don't pass its slug. To read a " +
        '*different* harness, use `cross_harness:docs_*` / `cross_harness:plans_*` ' +
        '(read-only) rather than switching scope.',
      '',
    );
  } else {
    lines.push(
      'You launched with **no harness scope** (workspace level). ' +
        '`docs:*` / `features:*` / `plans:*` fall through to workspace-level ' +
        'views. To work *on a specific harness*: relaunch via `psu` and pick ' +
        'it, or pass an explicit slug to harness-scoped tools and use ' +
        '`cross_harness:docs_*` / `cross_harness:plans_*` to read its docs and plans.',
      '',
    );
  }

  if (planSlug) {
    lines.push(
      `You launched **bound to plan \`${planSlug}\`**${planTitle ? ` — ${planTitle}` : ''}.`,
    );
    if (planNow && (planNow.state || planNow.next)) {
      lines.push('Its current focus:');
      if (planNow.state) lines.push(`> **Now:** ${planNow.state}`);
      if (planNow.next) lines.push(`> **Next:** ${planNow.next}`);
      lines.push(
        '',
        `Re-read the full plan with \`plans:get { slug: '${planSlug}' }\` before ` +
          'acting, and keep `## Now` current as you work (`plans:set-now`).',
      );
    } else {
      lines.push(
        `Read it with \`plans:get { slug: '${planSlug}' }\` to pick up its ` +
          '`## Now` focus.',
      );
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Directory the per-launch context files live in. A bootstrap artifact a
 * CLI reads as `--append-system-prompt-file` BEFORE any PG/tool
 * connection exists — squarely an acceptable file use (not app state).
 * Overridable via `PAPERCUSP_LAUNCH_CONTEXT_DIR` (used by tests + for
 * relocating the runtime dir); defaults under `~/.papercusp`.
 */
export function launchContextDir(): string {
  return process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR || join(homedir(), '.papercusp', 'launch-context');
}

/** Absolute path of the context file for a given launch key (session id or nonce). */
export function launchContextPathFor(key: string | number): string {
  return join(launchContextDir(), `session-${key}.md`);
}
