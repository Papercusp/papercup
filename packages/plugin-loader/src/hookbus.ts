/**
 * Hook bus runtime — WordPress-style addAction/addFilter for plugins.
 *
 * Lets plugins extend host behaviour without modifying core. The host
 * fires named events at well-known points (e.g., `task.passed`,
 * `proposal.accepted`); plugins subscribe via addAction (no return value)
 * or addFilter (transforms a value).
 *
 * Capability gates:
 *   - addAction/addFilter requires `events:listen:<event-name>`
 *   - emit requires `events:emit:<event-name>`
 *
 * Hook events the substrate fires (fixed; part of the spec):
 *
 *   task.created          { taskId: string }
 *   task.status-changed   { taskId: string; from: string; to: string }
 *   task.passed           { taskId: string }
 *   task.failing          { taskId: string }
 *   feature.completed     { featureId: string }
 *   proposal.accepted     { proposalId: string }
 *   proposal.rejected     { proposalId: string }
 *   orchestrator.tick     { decision: string }
 *   worker.complete       { roleName: string; featureId: string }
 *   validator.complete    { featureId: string; status: 'passed' | 'failing' }
 *   mission.start         {}
 *   mission.done          {}
 *   mission.escalate      { reason: string }
 *   pending_event.queued  { eventId: string; targetRole: string }
 *
 * Plugins may emit their own events for cross-plugin composition. Names
 * are unconstrained but must be declared in `events:emit:<name>` capabilities.
 */

import type { Capability } from '@papercusp/plugin-sdk';
import { hasCapability, type CapabilityCheckContext } from './capabilities';

type ActionHandler<T = unknown> = (arg: T) => void | Promise<void>;
type FilterHandler<T = unknown> = (arg: T) => T | Promise<T>;

interface RegisteredAction {
  pluginName: string;
  handler: ActionHandler;
}
interface RegisteredFilter {
  pluginName: string;
  handler: FilterHandler;
}

/**
 * Central hook bus. One per substrate process.
 *
 * Plugins receive a *scoped view* (createPluginHookBus below) that injects
 * their plugin name + capability check into every register/emit call.
 */
export class HookBus {
  private actions: Map<string, RegisteredAction[]> = new Map();
  private filters: Map<string, RegisteredFilter[]> = new Map();

  registerAction(event: string, pluginName: string, handler: ActionHandler): void {
    if (!this.actions.has(event)) this.actions.set(event, []);
    this.actions.get(event)!.push({ pluginName, handler });
  }

  registerFilter(event: string, pluginName: string, handler: FilterHandler): void {
    if (!this.filters.has(event)) this.filters.set(event, []);
    this.filters.get(event)!.push({ pluginName, handler });
  }

  /**
   * Fire all action handlers for the event. Errors in one handler don't
   * abort others — they're logged and skipped.
   */
  async runAction<T = unknown>(event: string, arg: T, log?: (msg: string) => void): Promise<void> {
    const handlers = this.actions.get(event) ?? [];
    for (const { pluginName, handler } of handlers) {
      try {
        await handler(arg);
      } catch (e) {
        log?.(`[hookbus] action "${event}" handler from plugin "${pluginName}" threw: ${e}`);
      }
    }
  }

  /**
   * Run the value through every filter handler in registration order.
   * Each handler's output becomes the next handler's input. Errors abort
   * the chain — a broken filter shouldn't silently let bad data through.
   */
  async applyFilter<T = unknown>(event: string, value: T): Promise<T> {
    const handlers = this.filters.get(event) ?? [];
    let current = value;
    for (const { handler } of handlers) {
      current = await handler(current);
    }
    return current;
  }

  /** Remove all registrations from a specific plugin (called on unload). */
  unregisterPlugin(pluginName: string): void {
    for (const [event, list] of this.actions) {
      this.actions.set(event, list.filter((r) => r.pluginName !== pluginName));
    }
    for (const [event, list] of this.filters) {
      this.filters.set(event, list.filter((r) => r.pluginName !== pluginName));
    }
  }

  /** Diagnostic: list registrations. */
  inspect(): { event: string; kind: 'action' | 'filter'; plugins: string[] }[] {
    const out: { event: string; kind: 'action' | 'filter'; plugins: string[] }[] = [];
    for (const [event, list] of this.actions) {
      out.push({ event, kind: 'action', plugins: list.map((r) => r.pluginName) });
    }
    for (const [event, list] of this.filters) {
      out.push({ event, kind: 'filter', plugins: list.map((r) => r.pluginName) });
    }
    return out;
  }
}

/**
 * Plugin-facing hook bus. Each plugin gets one of these — calls are scoped
 * to the plugin's name + capability-checked.
 */
export function createPluginHookBus(bus: HookBus, ctx: CapabilityCheckContext) {
  return {
    addAction<T>(event: string, handler: ActionHandler<T>): void {
      const cap: Capability = `events:listen:${event}`;
      if (!hasCapability(ctx, cap)) {
        throw new Error(
          `plugin "${ctx.pluginName}" missing capability "${cap}". ` +
          `Add it to the plugin's manifest \`capabilities[]\`.`
        );
      }
      bus.registerAction(event, ctx.pluginName, handler as ActionHandler);
    },

    addFilter<T>(event: string, handler: FilterHandler<T>): void {
      const cap: Capability = `events:listen:${event}`;
      if (!hasCapability(ctx, cap)) {
        throw new Error(
          `plugin "${ctx.pluginName}" missing capability "${cap}". ` +
          `Add it to the plugin's manifest \`capabilities[]\`.`
        );
      }
      bus.registerFilter(event, ctx.pluginName, handler as FilterHandler);
    },

    async emit<T>(event: string, arg: T): Promise<void> {
      const cap: Capability = `events:emit:${event}`;
      if (!hasCapability(ctx, cap)) {
        throw new Error(
          `plugin "${ctx.pluginName}" missing capability "${cap}". ` +
          `Add it to the plugin's manifest \`capabilities[]\`.`
        );
      }
      await bus.runAction(event, arg);
    },
  };
}
