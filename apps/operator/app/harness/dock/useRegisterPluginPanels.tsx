/**
 * useRegisterPluginPanels — fetches /api/plugins contributions and
 * registers each plugin panel in panelRegistry.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §8 (plugin contract)
 *
 * Hot-swap (§8.3): if a layout is already hydrated referencing
 * `plugin:<name>:<id>` and the plugin hasn't loaded yet, MissingPanel
 * renders. When this hook lands the registration, MissingPanel
 * subscribes-and-re-renders into the real component.
 *
 * Mount once at the dock root (or anywhere safe to refetch). Plugin
 * panels currently render as iframes pointing at the plugin's
 * iframeUrl; `type: 'react'` will require dynamic-import support via
 * componentRoot/componentId — that's TODO once a plugin actually uses
 * the new field.
 */

'use client';

import { useEffect } from 'react';
import { panelRegistry } from './panel-registry';
import { IframePanel } from './IframePanel';
import { MissingPanel } from './MissingPanel';

interface PanelContrib {
  pluginName: string;
  id: string;
  fullType: string;
  title: string;
  icon?: string;
  type: 'react' | 'iframe';
  componentRoot?: string;
  componentId?: string;
  src?: string;
  defaultGroup?: string;
  defaultFloating?: { width?: number; height?: number };
  keepAlive?: boolean;
}

interface ContributionsResponse {
  panels?: PanelContrib[];
}

export function useRegisterPluginPanels(slug: string): void {
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/plugins/${encodeURIComponent(slug)}/contributions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ContributionsResponse | null) => {
        if (cancelled || !j?.panels) return;
        for (const panel of j.panels) {
          if (panel.type === 'iframe' && panel.src) {
            // Wrap IframePanel so the registered component carries the
            // panel's src as a closure (panel registry expects a fixed
            // component, not one that receives external src). We pass
            // src via params at openPanel time, but plugin panels often
            // have a fixed src. The simplest approach: register a
            // component that ignores params.src and uses the closed-over
            // value. But to support src-from-params openPanel calls,
            // we also fall through to params.src if set.
            const Comp = (props: Parameters<typeof IframePanel>[0]) => {
              const params = props.params as { src?: string };
              return (
                <IframePanel
                  {...props}
                  params={{ ...props.params, src: params.src ?? panel.src }}
                />
              );
            };
            Comp.displayName = `PluginIframePanel(${panel.fullType})`;
            panelRegistry.register(panel.fullType, Comp, {
              title: panel.title,
              keepAlive: panel.keepAlive ?? true,
              defaultGroup: panel.defaultGroup,
            });
          } else {
            // React-type plugin panels need dynamic-import wiring to
            // resolve componentRoot/componentId. Until that lands, show
            // MissingPanel with a clear message.
            const NotYet = (props: Parameters<typeof MissingPanel>[0]) => (
              <MissingPanel {...props} panelType={panel.fullType} />
            );
            NotYet.displayName = `PluginReactPanel(${panel.fullType})`;
            panelRegistry.register(panel.fullType, NotYet, {
              title: panel.title,
              keepAlive: panel.keepAlive,
              defaultGroup: panel.defaultGroup,
            });
          }
        }
      })
      .catch(() => {
        // Plugin contributions endpoint unreachable; plugin panels in
        // existing layouts will fall back to MissingPanel.
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);
}
