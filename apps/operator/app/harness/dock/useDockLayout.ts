/**
 * useDockLayout — client hook for /api/dock-layouts/:name.
 *
 * Phase 3 / Phase 5 building block. Provides:
 *   - Initial fetch + seed-on-miss (the API handles the seed write)
 *   - Save with optimistic If-Match concurrency
 *   - Reset (DELETE → next GET reseeds)
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4.9
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutDoc } from '@papercusp/operator-core/lib/dock-layouts';

export interface DockLayoutRow {
  workspaceId: string;
  userId: string;
  layoutName: string;
  schemaVersion: number;
  layoutJson: LayoutDoc | { schemaVersion: 0; [k: string]: unknown };
  updatedTs: number;
  createdTs: number;
}

export type DockLayoutState =
  | { status: 'loading'; row: null; error: null }
  | { status: 'ready'; row: DockLayoutRow; error: null }
  | { status: 'error'; row: DockLayoutRow | null; error: Error };

export interface UseDockLayoutResult {
  state: DockLayoutState;
  /** Save a new layout body. Uses If-Match for optimistic concurrency. */
  save: (
    layout: DockLayoutRow['layoutJson'],
    opts?: { force?: boolean },
  ) => Promise<DockLayoutRow>;
  /** DELETE then refetch — server reseeds. */
  reset: () => Promise<DockLayoutRow>;
  /** Refetch from server (e.g. after another tab wrote). */
  refresh: () => Promise<DockLayoutRow>;
}

export function useDockLayout(name: string): UseDockLayoutResult {
  const [state, setState] = useState<DockLayoutState>({
    status: 'loading',
    row: null,
    error: null,
  });
  // Latest row for the save() concurrency hint, kept in a ref so save()
  // doesn't need state in its dep array.
  const rowRef = useRef<DockLayoutRow | null>(null);

  const fetchOnce = useCallback(async (): Promise<DockLayoutRow> => {
    const resp = await fetch(`/api/dock-layouts/${encodeURIComponent(name)}`);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`GET /api/dock-layouts/${name} → ${resp.status}: ${text}`);
    }
    const row = (await resp.json()) as DockLayoutRow;
    // Defense-in-depth: a double-encoded jsonb write (a postgres-js client that
    // turns `JSON.stringify(doc)::jsonb` into a jsonb STRING — see dock-layouts.ts
    // saveLayout) makes layoutJson arrive as a JSON string instead of an object.
    // Parse it so the dock never crashes on `(string).root.kind` (white-screened
    // the /adv git tab). Leave non-string / unparseable values for downstream
    // schemaVersion validation to handle.
    if (typeof (row as { layoutJson?: unknown }).layoutJson === 'string') {
      try {
        row.layoutJson = JSON.parse((row as unknown as { layoutJson: string }).layoutJson);
      } catch {
        /* leave as-is — validateLayoutDoc / schemaVersion gate will reject it */
      }
    }
    rowRef.current = row;
    return row;
  }, [name]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', row: null, error: null });
    fetchOnce()
      .then((row) => {
        if (cancelled) return;
        setState({ status: 'ready', row, error: null });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({ status: 'error', row: null, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchOnce]);

  const refresh = useCallback(async (): Promise<DockLayoutRow> => {
    const row = await fetchOnce();
    setState({ status: 'ready', row, error: null });
    return row;
  }, [fetchOnce]);

  const save = useCallback(
    async (
      layout: DockLayoutRow['layoutJson'],
      opts: { force?: boolean } = {},
    ): Promise<DockLayoutRow> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const lastTs = rowRef.current?.updatedTs;
      if (!opts.force && typeof lastTs === 'number') {
        headers['if-match'] = String(lastTs);
      }
      const resp = await fetch(
        `/api/dock-layouts/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ layout }),
        },
      );
      if (resp.status === 409) {
        // Refresh and re-throw so the caller can decide whether to retry.
        await refresh();
        const conflict = new Error(`409 conflict for ${name}`);
        (conflict as Error & { conflict?: boolean }).conflict = true;
        throw conflict;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`PUT /api/dock-layouts/${name} → ${resp.status}: ${text}`);
      }
      const row = (await resp.json()) as DockLayoutRow;
      rowRef.current = row;
      setState({ status: 'ready', row, error: null });
      return row;
    },
    [name, refresh],
  );

  const reset = useCallback(async (): Promise<DockLayoutRow> => {
    const del = await fetch(`/api/dock-layouts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    if (!del.ok && del.status !== 204) {
      const text = await del.text().catch(() => '');
      throw new Error(`DELETE /api/dock-layouts/${name} → ${del.status}: ${text}`);
    }
    return refresh();
  }, [name, refresh]);

  return { state, save, reset, refresh };
}
