import type { PhaseTracker, ToolResult } from '@papercusp/tooldef';
import { collectHarnessSlugArgs } from '../../hive-harness-arg-coverage';
import { isReservedHarnesslessRoutineHost } from '../../../harness/routines/routine-host';

type Caller = {
  workspaceId: string;
  harnessSlug?: string;
  role?: string;
  profile?: string;
  isSuperuser?: boolean;
};

export function hasWorkspaceProjectAuthority(caller: Caller): boolean {
  return caller.isSuperuser === true && caller.profile === 'engineer' &&
    (caller.role === 'operator' || caller.role === 'su');
}

type ProjectTarget = { arg: string; slug: string; subject: Record<string, unknown> };
type PolicyResult =
  | { ok: true; args: Record<string, unknown>; effectiveHarnessSlug: string | undefined }
  | { ok: false; result: ToolResult };

function deny(message: string): PolicyResult {
  return { ok: false, result: { isError: true, content: [{ type: 'text', text: message }] } };
}

/** Preserve non-project labels and exact harness-less operations. */
function isNonProjectTarget(toolName: string, target: ProjectTarget, workspaceId: string): boolean {
  if (target.arg === 'harness' && toolName === 'dev:build_status') return true;
  if (target.arg === 'harness' && target.slug === 'engineering' &&
      ['docs:get', 'docs:search', 'docs:outline', 'docs:author'].includes(toolName)) return true;
  if ((target.arg !== 'installSlug' && target.arg !== 'harness') ||
      !isReservedHarnesslessRoutineHost(target.slug, workspaceId)) return false;
  const name = typeof target.subject.name === 'string' ? target.subject.name.trim() : '';
  if (!name || name === '*' || name.toLowerCase() === 'all') return false;
  if (toolName === 'routines:set') return target.arg === 'installSlug';
  return toolName === 'routines:fire' || (toolName === 'routines:list' && target.subject.rollup !== true);
}

/** Check every supplied selector, including aliases shadowed by handler precedence. */
function projectTargets(toolName: string, args: Record<string, unknown>): ProjectTarget[] | string {
  const targets: ProjectTarget[] = [];
  const collect = (row: Record<string, unknown>, prefix: string): string | undefined => {
    const stringKeys = ['harness', 'harness_slug', 'harnessSlug', 'hive', 'hive_slug', 'pot'];
    if (/^(pot|harness|hive):/.test(toolName) && !(toolName === 'harness:create' && row.pot)) stringKeys.push('slug');
    for (const key of stringKeys) {
      const value = row[key];
      if (key in row && (typeof value !== 'string' || !value.trim())) return prefix + key;
    }
    targets.push(...collectHarnessSlugArgs(row, { toolName, skip: [] })
      .map(target => ({ ...target, arg: prefix + target.arg, subject: row })));
    if (typeof row.scope === 'string' && (row.scope === 'harness' || row.scope.startsWith('harness:'))) {
      if (row.scope.startsWith('harness:')) {
        targets.push({ arg: prefix + 'scope', slug: row.scope.slice(8).trim(), subject: row });
      }
      for (const key of ['scopeRef', 'scope_ref', 'ref']) {
        if (!(key in row)) continue;
        const value = row[key];
        if (typeof value !== 'string' || !value.trim()) return prefix + key;
        targets.push({ arg: prefix + key, slug: value.trim(), subject: row });
      }
    }
  };
  const invalid = collect(args, '');
  if (invalid) return invalid;
  // Registered batch envelopes only: launch briefs and arbitrary payloads are inert.
  if ((toolName === 'work_items:claim' || toolName === 'work_items:checkpoint') && Array.isArray(args.items)) {
    for (const [index, item] of args.items.entries()) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const invalid = collect(item as Record<string, unknown>, `items[${index}].`);
        if (invalid) return invalid;
      }
    }
  }
  return targets;
}

/**
 * Selection supplies defaults, never authority. Both transports pass server-derived
 * identity here before executing any part of a multi-target call. null leaves
 * narrower roles/profiles on their existing confinement path.
 */
export async function applySuperuserProjectPolicy(
  toolName: string,
  caller: Caller,
  input: Record<string, unknown>,
  clampEnabled: boolean,
  // Request-local phase tracker. Without it, a deadline that fires during the registry
  // lookup below reports no pending transport-scope phase and the stall is unattributed.
  phases?: Pick<PhaseTracker, 'track' | 'addCompleted'>,
): Promise<PolicyResult | null> {
  if (!clampEnabled || !hasWorkspaceProjectAuthority(caller)) return null;
  let args = input;
  // These existing workspace-wide operations never expand across workspaces.
  if (caller.harnessSlug === '*' && (toolName === 'plans:list' || toolName === 'loop:arm') &&
      (args.harness === 'all' || args.harness === '*')) {
    const { harness: _harness, ...rest } = args;
    args = toolName === 'plans:list' ? { ...rest, workspaceWide: true } : rest;
  }
  const collected = projectTargets(toolName, args);
  if (typeof collected === 'string') return deny(`harness_forbidden: ${collected} must name a non-empty registered project.`);
  const targets = collected.filter(target => !isNonProjectTarget(toolName, target, caller.workspaceId));
  if (targets.length) {
    const { resolveWorkspaceForHarnessSlugIn } = await import('../../../harness-core');
    const { primeWorkScopePolicy, evaluateWorkScope } = await import('../../../work-scope-policy');
    await primeWorkScopePolicy();
    const resolved = new Map<string, string | null>();
    for (const target of targets) {
      if (!target.slug || target.slug === '*' || target.slug === 'all') {
        return deny(`harness_forbidden: ${target.arg} must name a concrete registered project.`);
      }
      let workspace: string | null;
      try {
        if (!resolved.has(target.slug)) {
          const slug = target.slug;
          const resolve = () => resolveWorkspaceForHarnessSlugIn(caller.workspaceId, slug, phases);
          resolved.set(slug, await (phases ? phases.track('harnessWorkspaceResolution', resolve) : resolve()));
        }
        workspace = resolved.get(target.slug)!;
      } catch {
        return deny(`harness_forbidden: cannot establish workspace authority for ${target.arg} "${target.slug}"; registry resolution failed.`);
      }
      if (workspace !== caller.workspaceId) {
        return deny(`harness_forbidden: ${target.arg} "${target.slug}" is not a registered project in workspace "${caller.workspaceId}".`);
      }
      const subject = target.subject;
      const verdict = evaluateWorkScope({
        harness: target.slug,
        plan: typeof subject.plan_slug === 'string' ? subject.plan_slug :
          toolName.startsWith('plans:') && typeof subject.slug === 'string' ? subject.slug : undefined,
        workItem: typeof subject.id === 'string' ? subject.id : undefined,
      });
      if (!verdict.allowed) return deny(verdict.message);
    }
  }
  // Rebinding this call never changes the session's selected project.
  const effectiveHarnessSlug = typeof args.harness === 'string' &&
    !isNonProjectTarget(toolName, { arg: 'harness', slug: args.harness.trim(), subject: args }, caller.workspaceId)
    ? args.harness.trim() : caller.harnessSlug;
  for (const key of ['workspace', 'workspaceId']) {
    if (key in args) args = { ...args, [key]: caller.workspaceId };
  }
  return { ok: true, args, effectiveHarnessSlug };
}
