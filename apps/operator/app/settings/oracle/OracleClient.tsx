'use client';

import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { SettingsMarkdownEditor } from '../SettingsMarkdownEditor';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

interface OracleConfig {
  prompt: string;
  memory: string;
  prompt_path: string;
  memory_path: string;
}

const OracleSchema = z.object({
  prompt: z.string(),
  memory: z.string(),
});
type OracleFormData = z.infer<typeof OracleSchema>;

export default function OracleClient() {
  const [cfg, setCfg] = useState<OracleConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const { control, submit, reset, errors, isSubmitting } = useFormWith(OracleSchema, {
    defaultValues: { prompt: '', memory: '' },
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/oracle/config')
      .then((r) => r.json())
      .then((d: OracleConfig) => {
        if (cancelled) return;
        setCfg(d);
        reset({ prompt: d.prompt, memory: d.memory });
      })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reset]);

  const onSubmit = async (data: OracleFormData) => {
    try {
      const r = await fetch('/api/oracle/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: OracleConfig = await r.json();
      setCfg(d);
      reset({ prompt: d.prompt, memory: d.memory });
      toast.success('Oracle config saved');
    } catch (err: any) {
      toast.error(`save failed: ${err?.message ?? err}`);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div>
      <h1>Oracle</h1>
      <p className="pc-settings-intro">
        The Oracle is the always-mounted assistant in the bottom-right of every page.
        Edit its system prompt and persistent memory here. Files live at{' '}
        <code>{cfg?.prompt_path}</code> and <code>{cfg?.memory_path}</code>.
      </p>

      <form onSubmit={submit(onSubmit)}>
        <FormField label="System prompt" error={errors.prompt}>
          <Controller
            control={control}
            name="prompt"
            render={({ field }) => (
              <div style={{ minHeight: 320, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                <SettingsMarkdownEditor value={field.value} onChange={field.onChange} mode="ir" minHeight={320} />
              </div>
            )}
          />
        </FormField>

        <FormField label="Persistent memory" error={errors.memory}>
          <Controller
            control={control}
            name="memory"
            render={({ field }) => (
              <div style={{ minHeight: 240, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                <SettingsMarkdownEditor value={field.value} onChange={field.onChange} mode="ir" minHeight={240} />
              </div>
            )}
          />
        </FormField>

        <div style={{ marginTop: 16 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
        </div>
      </form>
    </div>
  );
}
