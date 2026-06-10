/**
 * Fork-completion form.
 *
 * Reads the snapshot's per-plugin shape via /api/snapshots/[id]/shape,
 * renders inputs for fields that were stripped (`shareable: false` /
 * `secret: true` / `oauth`), and POSTs to /api/snapshots/[id]/instantiate
 * with the completed `pluginConfigOverrides`.
 *
 * Form state via `lib/forms` (react-hook-form + Zod) — matches the
 * convention the operator uses everywhere else (login, settings/*).
 * Per-plugin field validation patterns can't be expressed in the static
 * Zod schema (they're plugin-author-supplied at runtime), so we re-check
 * them manually in the submit handler before posting and surface
 * mismatches via `setError`.
 *
 * Spec: /docs/snapshots/share-semantics + oauth-integration.
 */
'use client';

import { useEffect, useState } from 'react';
import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

interface ShapeField {
  reason: 'secret-strip' | 'secret-include' | 'secret-warn' | 'shareable-false' | 'pattern-fallback';
  oauth?: { provider: string; scopes?: string[] };
  pattern?: string;
  description?: string;
  flaggedShareableButLooksSecret?: boolean;
}

interface PluginShape {
  name: string;
  version: string;
  pluginVersionPinned: boolean;
  shape: { fields: Record<string, ShapeField>; warnings?: string[] } | null;
  preservedConfig: Record<string, unknown> | null;
}

interface SecurityAdvisory {
  cve?: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  fixedIn?: string;
  summary: string;
  advisoryUrl?: string;
}

interface AdvisoryCheck {
  state: 'clean' | 'flagged' | 'unknown';
  advisories?: SecurityAdvisory[];
  latestSafeVersion?: string;
  reason?: string;
}

export interface PendingProvisioningEntry {
  plugin: string;
  publisher?: string;
  version?: string;
  displayName?: string;
  description?: string;
  scriptPath: string;
  allowedHosts?: string[];
  cloudProvider?: { id: string; region?: string; regions?: string[] };
  timeoutSec?: number;
}

export interface ForkSuccessPayload {
  newSlug: string;
  pendingProvisioning?: PendingProvisioningEntry[];
}

interface Props {
  snapshotId: string;
  /** Called after a successful fork. Passes the new harness slug + the
   *  list of plugins that declared `provision.setup` (i.e. need
   *  consent + run before the harness is fully usable). */
  onSuccess?: (payload: ForkSuccessPayload) => void;
}

/* ─── Zod schema ────────────────────────────────────────────────────────── */

// Dynamic per-plugin field values are nested two levels deep:
//   overrides[pluginSlug][fieldName] = string
// Per-field `pattern` constraints are plugin-author-supplied at runtime,
// so they can't live in the static schema — we validate them in the
// submit handler before posting.
const FormSchema = z.object({
  name: z.string()
    .regex(/^[a-z0-9._-]*$/i, 'lowercase letters, digits, dots, underscores, hyphens')
    .max(64)
    .optional()
    .or(z.literal('')),
  acknowledgeAdvisories: z.boolean(),
  overrides: z.record(z.string(), z.record(z.string(), z.string())),
});
type FormValues = z.infer<typeof FormSchema>;

/* ─── Component ─────────────────────────────────────────────────────────── */

export function ForkCompletionForm({ snapshotId, onSuccess }: Props) {
  const [plugins, setPlugins] = useState<PluginShape[] | null>(null);
  const [advisories, setAdvisories] = useState<Record<string, AdvisoryCheck>>({});

  const { register, submit, errors, isSubmitting, setError, watch } =
    useFormWith(FormSchema, {
      defaultValues: { name: '', acknowledgeAdvisories: false, overrides: {} },
    });
  const acknowledgeAdvisories = watch('acknowledgeAdvisories');

  // Shape fetch + advisory checks (unchanged)
  useEffect(() => {
    fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/shape`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) {
          toast.error(`shape fetch failed: ${d.error ?? 'unknown'}`);
          return;
        }
        setPlugins(d.plugins);
        const list = d.plugins as PluginShape[];
        const pinned = list.filter((p) => p.pluginVersionPinned !== false);
        Promise.all(
          pinned.map(async (p) => {
            try {
              const r = await fetch('/api/security-advisories/check', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: p.name, version: p.version }),
              });
              const j = await r.json();
              return [p.name, j.result as AdvisoryCheck] as const;
            } catch {
              return [p.name, { state: 'unknown' as const, reason: 'network' }] as const;
            }
          }),
        ).then((entries) => setAdvisories(Object.fromEntries(entries)));
      })
      .catch((e) => toast.error(`shape error: ${e?.message ?? e}`));
  }, [snapshotId]);

  async function onSubmit(values: FormValues) {
    // Per-plugin pattern validation — plugin authors declare `pattern` at
    // runtime, so Zod can't model it. Walk every field that has a pattern
    // and reject mismatches via setError, which feeds the FormField error
    // display the same way Zod errors do.
    let hadPatternMismatch = false;
    for (const p of plugins ?? []) {
      if (!p.shape) continue;
      const slug = pluginSlug(p.name);
      for (const [fieldName, shape] of Object.entries(p.shape.fields)) {
        if (!shape.pattern) continue;
        if (shape.reason === 'secret-include') continue;
        if (shape.oauth) continue;
        const v = values.overrides?.[slug]?.[fieldName] ?? '';
        if (!v) continue; // empty is allowed; server enforces required separately
        try {
          if (!new RegExp(shape.pattern).test(v)) {
            setError(`overrides.${slug}.${fieldName}` as const, {
              type: 'pattern',
              message: `must match ${shape.pattern}`,
            });
            hadPatternMismatch = true;
          }
        } catch {
          // Bad regex from the plugin manifest — surface but don't block.
          toast.error(`plugin ${p.name} declared an invalid pattern for ${fieldName}`);
        }
      }
    }
    if (hadPatternMismatch) return;

    try {
      const r = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/instantiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: (values.name ?? '').trim() || undefined,
          pluginConfigOverrides: values.overrides ?? {},
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`fork failed: ${d.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success(`Forked → ${d.newSlug}`);
      onSuccess?.({
        newSlug: d.newSlug,
        pendingProvisioning: d.pendingProvisioning ?? [],
      });
    } catch (e: any) {
      toast.error(`fork crashed: ${e?.message ?? e}`);
    }
  }

  if (plugins === null) return <div className="pc-fork-form-loading" style={{ padding: 16 }}>Loading snapshot shape…</div>;

  const pluginsWithFields = plugins.filter((p) => p.shape && Object.keys(p.shape.fields ?? {}).length > 0);
  const flaggedAdvisories = Object.entries(advisories).filter(([, v]) => v.state === 'flagged');
  const blockingAdvisories = flaggedAdvisories.length > 0 && !acknowledgeAdvisories;

  return (
    <form className="pc-fork-form" onSubmit={submit(onSubmit)} style={{ padding: 16, maxWidth: 640 }}>
      <h3 style={{ marginTop: 0 }}>Fork this snapshot</h3>

      {flaggedAdvisories.length > 0 && (
        <div className="pc-fork-advisory-banner" style={advisoryBanner}>
          <strong>⚠ Security advisories on pinned versions</strong>
          <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 13 }}>
            {flaggedAdvisories.map(([plugin, ck]) => (
              <li key={plugin} style={{ marginBottom: 4 }}>
                <strong>{plugin}</strong>: {ck.advisories?.map((a) =>
                  `[${a.severity}] ${a.cve ?? ''} ${a.summary}`).join('; ')}
                {ck.latestSafeVersion && (
                  <em style={{ marginLeft: 6, color: 'var(--fg-mute, #aaa)' }}>
                    fixed in {ck.latestSafeVersion}
                  </em>
                )}
              </li>
            ))}
          </ul>
          <label style={{ marginTop: 8, display: 'inline-block', fontSize: 12 }}>
            <input
              type="checkbox"
              {...register('acknowledgeAdvisories')}
            />
            <span style={{ marginLeft: 6 }}>
              I understand and want to fork with the pinned vulnerable version anyway.
            </span>
          </label>
        </div>
      )}

      <FormField label="New harness name (optional)" error={errors.name}>
        <input
          type="text"
          placeholder="auto-generated if blank"
          style={input}
          {...register('name')}
        />
      </FormField>

      {pluginsWithFields.length === 0 ? (
        <p style={{ color: 'var(--fg-mute, #aaa)' }}>
          This snapshot has no stripped fields — fork directly.
        </p>
      ) : (
        <>
          <p className="pc-fork-copy" style={{ fontSize: 13, color: 'var(--fg-mute, #ccc)' }}>
            Some plugin config was stripped from the snapshot. Fill in your own values
            (or click <em>Connect with X</em> for OAuth-backed credentials).
          </p>
          {pluginsWithFields.map((p) => (
            <PluginFields
              key={p.name}
              plugin={p}
              register={register}
              errors={errors}
            />
          ))}
        </>
      )}

      <SubmitButton
        pending={isSubmitting}
        aria-disabled={blockingAdvisories ? 'true' : undefined}
      >
        {blockingAdvisories ? 'Acknowledge advisories to fork' : 'Fork'}
      </SubmitButton>
    </form>
  );
}

function pluginSlug(name: string): string {
  const last = name.split('/').pop() ?? name;
  return last.replace(/[^a-zA-Z0-9._-]/g, '_');
}

interface PluginFieldsProps {
  plugin: PluginShape;
  register: UseFormRegister<FormValues>;
  errors: FieldErrors<FormValues>;
}

function PluginFields({ plugin, register, errors }: PluginFieldsProps) {
  const fields = Object.entries(plugin.shape!.fields);
  const slug = pluginSlug(plugin.name);
  return (
    <div className="pc-fork-plugin-card" style={pluginCard}>
      <header className="pc-fork-plugin-card-head" style={{ marginBottom: 8 }}>
        <strong>{plugin.name}</strong>{' '}
        <span style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>
          v{plugin.version}{plugin.pluginVersionPinned && ' · pinned'}
        </span>
      </header>
      {fields.map(([fieldName, shape]) => {
        const reasonLabel =
          shape.reason === 'shareable-false' ? 'publisher-specific' :
          shape.reason === 'secret-strip' ? 'secret' :
          shape.reason === 'secret-warn' ? 'secret (warned)' :
          shape.reason === 'pattern-fallback' ? 'matched secret pattern' :
          'included';

        if (shape.reason === 'secret-include') {
          return (
            <div key={fieldName} style={{ marginBottom: 12, fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
              ✓ <code>{fieldName}</code> — included by publisher (no override needed)
            </div>
          );
        }

        // Reach into the nested errors tree for this dynamic field.
        // The schema is record(record(string)), so each leaf error has
        // FieldError shape — `message` is the field we surface inline.
        const fieldError = errors.overrides?.[slug]?.[fieldName];

        return (
          <FormField
            key={fieldName}
            label={fieldName}
            error={fieldError}
          >
            <div style={{ marginBottom: 4 }}>
              <span className={`pc-fork-badge pc-fork-badge--${shape.reason}`} style={badge}>{reasonLabel}</span>
            </div>
            {shape.description && (
              <div className="pc-fork-field-description" style={{ fontSize: 12, color: 'var(--fg-mute, #888)', marginBottom: 4 }}>
                {shape.description}
              </div>
            )}
            {shape.oauth ? (
              <div className="pc-fork-oauth-note" style={{ fontSize: 13 }}>
                <em style={{ color: 'var(--fg-mute, #aaa)' }}>
                  After fork, click "Connect with {shape.oauth.provider}" on the new harness's plugin settings.
                </em>
              </div>
            ) : (
              <input
                type={shape.reason === 'secret-strip' || shape.reason === 'pattern-fallback' ? 'password' : 'text'}
                pattern={shape.pattern}
                style={input}
                autoComplete="off"
                {...register(`overrides.${slug}.${fieldName}` as const)}
              />
            )}
            {shape.pattern && (
              <div className="pc-fork-pattern" style={{ fontSize: 11, color: 'var(--fg-mute, #888)', marginTop: 2 }}>
                must match <code>{shape.pattern}</code>
              </div>
            )}
          </FormField>
        );
      })}
    </div>
  );
}

const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-1, #141414)',
  border: '1px solid var(--border, #2a2a2a)', borderRadius: 4, color: 'var(--fg, #ddd)',
  fontSize: 13, fontFamily: 'inherit',
};
const pluginCard: React.CSSProperties = {
  padding: 12, marginBottom: 12, border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6, background: 'rgba(255,255,255,.02)',
};
const badge: React.CSSProperties = {
  display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 3,
  fontSize: 10, fontWeight: 500, textTransform: 'uppercase',
  background: 'rgba(150,150,150,.12)', color: '#aaa', border: '1px solid rgba(150,150,150,.25)',
  letterSpacing: '.04em',
};
const advisoryBanner: React.CSSProperties = {
  padding: 12, marginBottom: 16, borderRadius: 6,
  background: 'rgba(255, 90, 90, .1)',
  border: '1px solid rgba(255, 90, 90, .35)',
  color: '#ffb0b0',
};
