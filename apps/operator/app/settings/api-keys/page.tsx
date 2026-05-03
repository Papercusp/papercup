'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

interface MaskedCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

// All fields optional — empty means "leave alone".
const ApiKeysSchema = z.object({
  anthropic: z.string().optional().default(''),
  openai: z.string().optional().default(''),
  github: z.string().optional().default(''),
});
type ApiKeysFormData = z.infer<typeof ApiKeysSchema>;

export default function ApiKeysPage() {
  const [masked, setMasked] = useState<MaskedCredentials | null>(null);
  const [loading, setLoading] = useState(true);

  const { register, submit, reset, errors, isSubmitting } = useFormWith(ApiKeysSchema, {
    defaultValues: { anthropic: '', openai: '', github: '' },
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials')
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setMasked(d); })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const onSubmit = async (data: ApiKeysFormData) => {
    if (!data.anthropic && !data.openai && !data.github) {
      toast.message('Nothing to save — fill at least one field.');
      return;
    }
    try {
      const body: Record<string, string> = {};
      if (data.anthropic) body.anthropic_api_key = data.anthropic;
      if (data.openai) body.openai_api_key = data.openai;
      if (data.github) body.github_pat = data.github;
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: MaskedCredentials = await r.json();
      setMasked(d);
      reset({ anthropic: '', openai: '', github: '' });
      toast.success(`Saved to ${d.path}`);
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    }
  };

  return (
    <div>
      <h1>API keys</h1>

      <div className="pc-warn" role="status">
        ⚠ <strong>These keys stay on your computer.</strong> They&rsquo;re written to{' '}
        <code>~/.papercusp/credentials.json</code> with permissions <code>0600</code>{' '}
        (your user only). They are <strong>never</strong> sent to or stored on
        Papercusp&rsquo;s servers. If you lose this file, you&rsquo;ll need to re-enter
        the keys here.
      </div>

      <form onSubmit={submit(onSubmit)} className="pc-card" style={{ maxWidth: 640 }}>
        <SecretField
          label="Anthropic API key"
          help="Required. Used by every harness role for `claude -p` invocations."
          placeholder={masked?.anthropic_api_key ?? 'sk-ant-…'}
          masked={masked?.anthropic_api_key}
          loading={loading}
          register={register('anthropic')}
          error={errors.anthropic?.message}
        />
        <SecretField
          label="OpenAI API key"
          help="Optional. Used by some plugins (e.g. embeddings, transcription)."
          placeholder={masked?.openai_api_key ?? 'sk-…'}
          masked={masked?.openai_api_key}
          loading={loading}
          register={register('openai')}
          error={errors.openai?.message}
        />
        <SecretField
          label="GitHub personal access token"
          help="Optional. Needed only if you want to publish harnesses to the marketplace."
          placeholder={masked?.github_pat ?? 'ghp_…'}
          masked={masked?.github_pat}
          loading={loading}
          register={register('github')}
          error={errors.github?.message}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
          {masked?.updated_at && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={masked.updated_at}>{new Date(masked.updated_at).toLocaleString()}</time>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function SecretField({
  label,
  help,
  placeholder,
  masked,
  loading,
  register,
  error,
}: {
  label: string;
  help: string;
  placeholder: string;
  masked: string | null | undefined;
  loading: boolean;
  register: UseFormRegisterReturn;
  error?: string;
}) {
  return (
    <FormField
      label={label}
      error={error}
      description={`${help}${!loading && masked ? ` Currently set; leave empty to keep, type to overwrite.` : !loading ? ' Currently not set.' : ''}`}
    >
      <input
        type="password"
        className="pc-input"
        placeholder={loading ? 'loading…' : placeholder}
        autoComplete="off"
        spellCheck={false}
        {...register}
      />
    </FormField>
  );
}
