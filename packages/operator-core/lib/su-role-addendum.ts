/**
 * SU-TIER ROLES — a role that runs as a FULL su engineer session plus a few
 * role-specific lines, rather than as a role-scoped session (EI-996).
 *
 * Owner ask (2026-06-17), verbatim: planners should "be full su agents and get
 * the full su prompt, but just a few lines added about their planner role."
 *
 * ── THE SHAPE, AND WHY IT IS A ROLE NAME ─────────────────────────────────────
 * The wire carries `su_role: 'planner'` — a NAME, validated against the
 * allow-list below, whose addendum text is resolved SERVER-SIDE from a prompt
 * source. It deliberately does NOT carry the addendum prose itself.
 *
 * That is a security boundary, not a style preference: routing a role through
 * the su path grants it the SUPERUSER MCP tier, so this request mints a
 * superuser-tier system prompt. A free-text `role_addendum` field would let any
 * loopback caller append arbitrary instructions to a superuser prompt — an
 * open prompt-injection surface on the most privileged launch path we have. A
 * closed allow-list of names has no such degree of freedom: the worst a caller
 * can do is select a different vetted, in-repo addendum.
 *
 * (`buildSuLaunchSpec` still takes `roleAddendum` as TEXT — that is an internal
 * builder seam reached only after this resolution, not a wire field.)
 *
 * ── WHERE THE TEXT LIVES ─────────────────────────────────────────────────────
 * `apps/operator/prompts/su-role-<role>.addendum.md`, alongside the su playbooks
 * (`papercusp-su-{engineer,power}.tools.md`) it is appended to. Prompt prose is a
 * SOURCE in this repo, never a TS string constant — see CLAUDE.md, "Prompts are
 * auto-generated — edit the source, never the rendered output". Resolution reuses
 * the playbook's own prompts-dir candidates so the bundled Tauri sidecar layout
 * resolves identically.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  operatorAppRootForPrompts,
  promptsDirCandidates,
} from './desktop-install/papercusp-files';

/**
 * Roles that launch on the SU tier (full engineer playbook + superuser MCP)
 * instead of the role-scoped bootstrap.
 *
 * ⚠ `apps/operator/scripts/psu-launcher.mjs` carries its own copy of this list
 * (it is plain .mjs and cannot import TS). `su-role-addendum.test.ts` asserts
 * the two agree, so adding a role here without updating the launcher fails a
 * test rather than silently routing that role the old way.
 */
export const SU_TIER_ROLES = ['planner'] as const;

export type SuTierRole = (typeof SU_TIER_ROLES)[number];

/** Is this role name one that launches on the su tier? Narrowing type-guard. */
export function isSuTierRole(role: string | null | undefined): role is SuTierRole {
  return !!role && (SU_TIER_ROLES as readonly string[]).includes(role);
}

/** The addendum source filename for a su-tier role. Pure. */
export function suRoleAddendumFileName(role: SuTierRole): string {
  return `su-role-${role}.addendum.md`;
}

/**
 * Resolve a su-tier role's addendum TEXT from its prompt source.
 *
 * Returns null for an unknown role or a missing/blank file — a missing addendum
 * degrades the launch to a plain su session (full playbook, no role lines),
 * which is strictly better than failing the launch outright: the role still
 * gets the su tier the owner asked for.
 */
export function resolveSuRoleAddendum(
  role: string | null | undefined,
  opts: { operatorAppRoot?: string } = {},
): string | null {
  if (!isSuTierRole(role)) return null;
  const explicitRoot = !!opts.operatorAppRoot;
  const root = opts.operatorAppRoot ?? operatorAppRootForPrompts();
  const fileName = suRoleAddendumFileName(role);
  for (const dir of promptsDirCandidates(root, explicitRoot)) {
    const candidate = path.join(dir, fileName);
    try {
      if (!existsSync(candidate)) continue;
      const text = readFileSync(candidate, 'utf8').trim();
      if (text) return text;
    } catch {
      /* unreadable candidate → try the next root */
    }
  }
  return null;
}
