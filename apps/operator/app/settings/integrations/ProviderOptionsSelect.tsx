'use client';

/**
 * A settings field whose choices come from a connected provider (cupboard-distributable-
 * integrations-2026-10-10 P-004, D-005; SPEC-R-2-P-004).
 *
 * The workflow package declares the field in its trigger-pack `inputs` with
 * `x-options: { capability, args? }`; this control renders whatever it declares and names no
 * provider. It asks /api/user/integrations/options once, which invokes the capability on each of
 * the owner's connected sources whose installed provider declares it, and shows the answers as one
 * dropdown (grouped by account when there are several). A string property is a single choice, an
 * array-of-strings property a multiple choice.
 *
 * The field is never blocked on a provider: with no option source, nothing connected that can
 * answer, or a failed read, it falls back to typing the value, and a saved value the provider no
 * longer lists stays selectable instead of silently disappearing.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { providerOptionSourceOf } from '@papercusp/plugin-sdk/provider';
import type { ProviderOptionsGroup, ProviderOptionsResult } from '@papercusp/operator-core/lib/integrations/provider-options';
import { Button } from '../../harness/Button';
import { IntegrationRequestError, INTEGRATIONS_SETTINGS_HREF } from './ticket-integrations-client';

export const PROVIDER_OPTIONS_API = '/api/user/integrations/options';

type OptionsState =
  | { state: 'loading' }
  | { state: 'ready'; groups: ProviderOptionsGroup[] }
  | { state: 'failed'; message: string };

async function requestOptions(body: { capability: string; args?: Record<string, unknown> }): Promise<ProviderOptionsResult> {
  const res = await fetch(PROVIDER_OPTIONS_API, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (ProviderOptionsResult & { ok?: boolean; error?: string; detail?: string }) | null;
  if (!res.ok || !json || json.ok === false) {
    throw new IntegrationRequestError(json?.error ?? `http_${res.status}`, json?.detail ?? json?.error ?? `HTTP ${res.status}`);
  }
  return json;
}

const groupLabel = (g: ProviderOptionsGroup): string => (g.accountLabel ? `${g.providerName} · ${g.accountLabel}` : g.providerName);

export interface ProviderOptionsSelectProps {
  id: string;
  label: string;
  /** The trigger-pack `inputs` property (JSON schema) for this field. */
  property: unknown;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
  disabled?: boolean;
}

export function ProviderOptionsSelect({ id, label, property, value, onChange, disabled }: ProviderOptionsSelectProps) {
  const source = useMemo(() => providerOptionSourceOf(property), [property]);
  const sourceKey = source ? JSON.stringify(source) : '';
  const multiple = Boolean(property && typeof property === 'object' && (property as { type?: unknown }).type === 'array');
  const description =
    property && typeof property === 'object' && typeof (property as { description?: unknown }).description === 'string'
      ? ((property as { description: string }).description)
      : null;
  const [result, setResult] = useState<OptionsState>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sourceKey) return;
    let cancelled = false;
    setResult({ state: 'loading' });
    requestOptions(JSON.parse(sourceKey) as { capability: string; args?: Record<string, unknown> })
      .then(({ groups }) => {
        if (!cancelled) setResult({ state: 'ready', groups });
      })
      .catch((err: unknown) => {
        if (!cancelled) setResult({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [sourceKey, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const selected = value === undefined ? [] : Array.isArray(value) ? value : value ? [value] : [];
  const groups = result.state === 'ready' ? result.groups : [];
  const listed = groups.flatMap((g) => g.options);
  const listedValues = new Set(listed.map((o) => o.value));
  const unlisted = selected.filter((v) => !listedValues.has(v));
  const failedGroups = groups.filter((g) => g.error);
  const truncated = groups.some((g) => g.truncated);
  const canPick = source !== null && result.state === 'ready' && listed.length > 0;

  const typed = (
    <input
      id={id}
      style={inputStyle}
      value={selected.join(', ')}
      disabled={disabled}
      placeholder={multiple ? 'Values, separated by commas' : 'Value'}
      onChange={(e) => {
        const text = e.target.value;
        onChange(multiple ? text.split(',').map((s) => s.trim()).filter(Boolean) : text);
      }}
    />
  );

  return (
    <div style={fieldStyle}>
      <label htmlFor={id} style={labelText}>
        {label}
      </label>
      {description && <p style={hintText}>{description}</p>}
      {source && result.state === 'loading' && (
        <p role="status" style={hintText}>
          Asking connected providers for the choices…
        </p>
      )}
      {canPick ? (
        <select
          id={id}
          style={inputStyle}
          multiple={multiple}
          disabled={disabled}
          value={multiple ? selected : (selected[0] ?? '')}
          onChange={(e) => {
            onChange(multiple ? Array.from(e.target.selectedOptions, (o) => o.value) : e.target.value);
          }}
        >
          {!multiple && <option value="">Choose…</option>}
          {groups.length > 1
            ? groups
                .filter((g) => g.options.length > 0)
                .map((g) => (
                  <optgroup key={g.sourceId} label={groupLabel(g)}>
                    {g.options.map((o) => (
                      <option key={`${g.sourceId}:${o.value}`} value={o.value} title={o.description}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))
            : listed.map((o) => (
                <option key={o.value} value={o.value} title={o.description}>
                  {o.label}
                </option>
              ))}
          {unlisted.map((v) => (
            <option key={`unlisted:${v}`} value={v}>
              {v} (no longer listed)
            </option>
          ))}
        </select>
      ) : (
        (!source || result.state !== 'loading') && typed
      )}
      {source && result.state === 'failed' && (
        <div style={actionRow}>
          <p role="alert" style={errorText}>
            Could not list the choices: {result.message}
          </p>
          <Button type="button" variant="neutral" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {source && result.state === 'ready' && listed.length === 0 && failedGroups.length === 0 && (
        <p style={hintText}>
          No connected provider lists these choices. Connect one on{' '}
          <a href={INTEGRATIONS_SETTINGS_HREF}>Settings → Integrations</a>, or type the value.
        </p>
      )}
      {failedGroups.map((g) => (
        <p key={g.sourceId} role="alert" style={errorText}>
          {groupLabel(g)}: {g.error?.message}
        </p>
      ))}
      {truncated && <p style={hintText}>The provider listed only part of the choices.</p>}
    </div>
  );
}

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const labelText: CSSProperties = { fontSize: 13, color: 'var(--fg)' };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: 0 };
const errorText: CSSProperties = { color: 'var(--bad)', fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };
const inputStyle: CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border, rgba(127,127,127,0.35))',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
};
