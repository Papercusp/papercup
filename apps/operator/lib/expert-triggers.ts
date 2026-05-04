/**
 * Plugin-event → expert dispatch trigger.
 *
 * Hooks into `firePluginLifecycle` and `firePluginEvent` so experts can
 * react to events that the scoper doesn't observe (post-provisioning
 * verification, teardown audit, etc.). These are POST-HOC verifiers,
 * not planners — they run after the event already happened to check
 * that infrastructure ended up in the right shape.
 *
 * Triggers are sourced from the role registry (see lib/role-registry.ts):
 * each role's `alwaysFireOn` array is matched against the event name.
 * No hardcoded role list here; adding a new role with a new trigger is
 * purely about its sidecar `prompts/<role>.role.json`.
 *
 * Triggers are best-effort: a failed dispatch (lock-held, role missing,
 * etc.) is logged but doesn't abort the original plugin event chain.
 */
import { dispatchExpert } from './expert-dispatcher';
import { loadHarnessRegistry } from './harness-registry';
import { rolesFiringOn } from './role-registry';

async function fireFor(
  source: 'lifecycle' | 'event',
  event: string,
  installSlug: string,
  ctx: Record<string, unknown>,
): Promise<Array<{ role: string; expertId?: string; error?: string }>> {
  const matching = rolesFiringOn(event);
  if (matching.length === 0) return [];

  const reg = loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === installSlug);
  if (!project) return [];

  const out: Array<{ role: string; expertId?: string; error?: string }> = [];
  for (const role of matching) {
    try {
      const result = await dispatchExpert(
        { slug: installSlug, path: project.path },
        role.id,
        {
          reason: `${source}:${event} fired (auto-trigger from role.alwaysFireOn)`,
          context: { source, event, installSlug, ...ctx },
        },
      );
      if (result.ok) out.push({ role: role.id, expertId: result.expertId });
      else out.push({ role: role.id, error: result.error });
    } catch (e) {
      out.push({ role: role.id, error: (e as Error).message });
    }
  }
  return out;
}

/**
 * Fire any expert dispatches matching this lifecycle hook. Best-effort;
 * never throws back to the caller.
 */
export async function fireLifecycleTriggers(
  lifecycle: string,
  installSlug: string,
  ctx: Record<string, unknown>,
): Promise<Array<{ role: string; expertId?: string; error?: string }>> {
  return fireFor('lifecycle', lifecycle, installSlug, ctx);
}

/** Same as fireLifecycleTriggers but for free-form firePluginEvent events. */
export async function fireEventTriggers(
  event: string,
  installSlug: string,
  arg: unknown,
): Promise<Array<{ role: string; expertId?: string; error?: string }>> {
  const ctx = (typeof arg === 'object' && arg !== null) ? arg as Record<string, unknown> : { arg };
  return fireFor('event', event, installSlug, ctx);
}
