'use client';

/**
 * FeatureDescriptionPanel — Phase 8 P-047c.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.1 — Feature detail panel with vditor-rendered description.
 *
 * Stores the description in the feature's existing `metadata` JSONB
 * column (as `metadata.description: string`) — no schema change.
 * Reads via GET /api/harness/:slug/features/:id; writes via
 * PATCH /api/harness/:slug/features/:id with body
 * { metadata: { ...existing, description } }.
 *
 * Two modes:
 * - read: HarnessMarkdownView (vditor preview, same as notes/debug).
 * - edit: MarkdownEditor (vditor IR mode).
 *
 * Toggle via a "Edit" / "Save" / "Cancel" button row. Optimistic save
 * with rollback on PATCH failure.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HarnessMarkdownView } from './HarnessMarkdownView';
import { MarkdownEditor } from '../_components/MarkdownEditor';

export interface FeatureDescriptionPanelProps {
  slug: string;
  featureId: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

interface FeatureFetchResponse {
  feature?: {
    metadata?: unknown;
  };
}

function extractDescription(metadata: unknown): string {
  if (!metadata || typeof metadata !== 'object') return '';
  let parsed: Record<string, unknown> = metadata as Record<string, unknown>;
  // PG drivers sometimes hand JSONB back as a string — try one parse.
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return '';
    }
  }
  const d = parsed.description;
  return typeof d === 'string' ? d : '';
}

export function FeatureDescriptionPanel(
  props: FeatureDescriptionPanelProps,
): ReactNode {
  const fetchImpl = props.fetchImpl ?? fetch;
  const [description, setDescription] = useState('');
  const [originalDescription, setOriginalDescription] = useState('');
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Initial load (+ reload on featureId change).
  useEffect(() => {
    if (!props.slug || !props.featureId) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetchImpl(
          `/api/harness/${encodeURIComponent(props.slug)}/features/${encodeURIComponent(props.featureId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          if (!cancelled) {
            setError(`HTTP ${res.status}`);
            setLoaded(true);
          }
          return;
        }
        const body = (await res.json().catch(() => ({}))) as FeatureFetchResponse;
        if (cancelled) return;
        const md = (body.feature?.metadata ?? {}) as Record<string, unknown>;
        const d = extractDescription(body.feature?.metadata);
        setMetadata(md && typeof md === 'object' ? md : {});
        setDescription(d);
        setOriginalDescription(d);
        setError(null);
        setLoaded(true);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [props.slug, props.featureId, fetchImpl]);

  const startEdit = useCallback(() => {
    setEditing(true);
    setError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setDescription(originalDescription);
    setEditing(false);
    setError(null);
  }, [originalDescription]);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const nextMeta = { ...metadata, description };
    try {
      const res = await fetchImpl(
        `/api/harness/${encodeURIComponent(props.slug)}/features/${encodeURIComponent(props.featureId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metadata: nextMeta }),
        },
      );
      if (!res.ok) {
        setError(`Save failed: HTTP ${res.status}`);
        return;
      }
      setMetadata(nextMeta);
      setOriginalDescription(description);
      setEditing(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [saving, metadata, description, fetchImpl, props.slug, props.featureId]);

  if (!loaded) {
    return (
      <div data-testid="feature-description-loading" style={{ fontSize: 12, color: 'var(--fg-dim, #888)' }}>
        Loading description…
      </div>
    );
  }

  return (
    <div data-testid="feature-description-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            color: 'var(--fg-dim, #888)',
          }}
        >
          Description
        </span>
        {editing ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              data-testid="feature-description-cancel"
              onClick={cancelEdit}
              disabled={saving}
              style={btnStyle('default', saving)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="feature-description-save"
              onClick={save}
              disabled={saving || description === originalDescription}
              style={btnStyle('primary', saving || description === originalDescription)}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="feature-description-edit"
            onClick={startEdit}
            style={btnStyle('default', false)}
          >
            {description.length > 0 ? 'Edit' : 'Add description'}
          </button>
        )}
      </div>
      {error && (
        <div
          data-testid="feature-description-error"
          style={{ fontSize: 11, color: 'var(--bad, #d68a8a)', marginBottom: 6 }}
        >
          {error}
        </div>
      )}
      {editing ? (
        <div data-testid="feature-description-editor" style={{ minHeight: 200 }}>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            mode="ir"
            minHeight={180}
            toolbar={['headings', 'bold', 'italic', '|', 'list', 'check', 'quote', 'code', 'inline-code', 'link', '|', 'preview']}
          />
        </div>
      ) : description.length === 0 ? (
        <div
          data-testid="feature-description-empty"
          style={{ fontSize: 12, color: 'var(--fg-dim, #888)', fontStyle: 'italic' }}
        >
          No description yet.
        </div>
      ) : (
        <HarnessMarkdownView
          value={description}
          emptyLabel="No description yet."
        />
      )}
    </div>
  );
}

function btnStyle(variant: 'default' | 'primary', disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 4,
    border: '1px solid var(--border, #2a2a2a)',
    background:
      variant === 'primary'
        ? disabled
          ? 'var(--surface-2, #2a2a2a)'
          : 'var(--accent, #6aa)'
        : 'transparent',
    color: variant === 'primary' && !disabled ? 'var(--surface, #1a1a1a)' : 'var(--fg-dim, #aaa)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
