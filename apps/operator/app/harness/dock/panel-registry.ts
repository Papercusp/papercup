/**
 * PanelRegistry — runtime mapping of panel type → React component, with
 * late-registration support for plugin-contributed panels.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §8.3
 *
 * Two concerns this solves:
 *   1. Phase 5 root dock needs a stable registry so dockview can render
 *      `data:features` (and friends) by type string regardless of where
 *      they're defined.
 *   2. Plugin panels (`plugin:<id>:<panel-id>`) register at plugin onLoad,
 *      which races layout hydration. When a layout references a type not
 *      yet registered, `MissingPanel` renders as a fallback and subscribes
 *      here; on `register()` it re-resolves and hot-swaps.
 *
 * This is a CLIENT-SIDE registry (browser singleton). Server-side, the
 * layout body is just opaque JSON.
 */

import type { ComponentType } from 'react';

export type PanelComponentProps = {
  /** Stable id of this panel instance (from layout's PanelInstance.id). */
  panelId: string;
  /** Panel type (the registry key — `data:features`, `plugin:foo:bar`, etc). */
  panelType: string;
  /** Params from layout's PanelInstance.params. */
  params: Record<string, unknown>;
  /** Imperative API to mutate this panel's params or title in the layout. */
  api: {
    setParams: (next: Record<string, unknown>) => void;
    setTitle: (title: string) => void;
    close: () => void;
  };
};

export type PanelComponent = ComponentType<PanelComponentProps>;

export type PanelMetadata = {
  /** Default display title when layout doesn't override. */
  title?: string;
  /** Whether dockview should keep this panel mounted when its tab is inactive. */
  keepAlive?: boolean;
  /** Default group hint when opening via `openPanel` without an explicit group. */
  defaultGroup?: string;
};

export type RegistryEntry = {
  type: string;
  component: PanelComponent;
  meta: PanelMetadata;
};

type RegistryListener = () => void;

class PanelRegistryImpl {
  private map = new Map<string, RegistryEntry>();
  private listeners = new Set<RegistryListener>();

  /**
   * Register a panel component for a type. If a component is already
   * registered for this type, it's REPLACED (used by HMR + plugin reloads).
   * Notifies subscribers so any `MissingPanel` instances re-render.
   */
  register(type: string, component: PanelComponent, meta: PanelMetadata = {}): void {
    this.map.set(type, { type, component, meta });
    this.notify();
  }

  /**
   * Unregister a panel type (plugin unload / dev-time cleanup).
   * Subscribers re-render; layouts referencing this type fall back to
   * MissingPanel.
   */
  unregister(type: string): boolean {
    const ok = this.map.delete(type);
    if (ok) this.notify();
    return ok;
  }

  /** Get the registered entry for a type, or undefined. */
  get(type: string): RegistryEntry | undefined {
    return this.map.get(type);
  }

  /** True if a component is registered for the type. */
  has(type: string): boolean {
    return this.map.has(type);
  }

  /** Snapshot of all currently-registered types. */
  list(): string[] {
    return Array.from(this.map.keys()).sort();
  }

  /**
   * Subscribe to registry changes. Returns an unsubscribe function.
   * `MissingPanel` uses this to re-resolve when its type becomes
   * available.
   */
  subscribe(fn: RegistryListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** For tests. Clears all registrations and listeners. */
  _reset(): void {
    this.map.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[panel-registry] listener threw:', err);
      }
    }
  }
}

/**
 * Module-singleton registry. All panel definitions in the operator
 * register here on import; plugin panels register at their onLoad.
 */
export const panelRegistry = new PanelRegistryImpl();

export type PanelRegistry = PanelRegistryImpl;
