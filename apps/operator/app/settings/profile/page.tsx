'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

interface Profile {
  email?: string;
  display_name?: string;
  default_project_dir?: string;
  preferred_models?: Record<string, string>;
  theme?: 'dark' | 'light' | 'auto';
  updated_at?: string;
}

const ProfileSchema = z.object({
  email: z.string().optional().default(''),
  display_name: z.string().optional().default(''),
  default_project_dir: z.string().optional().default(''),
  scoper: z.string().optional().default(''),
  worker: z.string().optional().default(''),
  validator: z.string().optional().default(''),
  reviewer: z.string().optional().default(''),
  orchestrator: z.string().optional().default(''),
});
type ProfileFormData = z.infer<typeof ProfileSchema>;

export default function ProfilePage() {
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { register, submit, reset, errors, isSubmitting } = useFormWith(ProfileSchema, {
    defaultValues: {
      email: '', display_name: '', default_project_dir: '',
      scoper: '', worker: '', validator: '', reviewer: '', orchestrator: '',
    },
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/profile')
      .then((r) => r.json())
      .then((d: Profile) => {
        if (cancelled) return;
        const m = d.preferred_models ?? {};
        reset({
          email: d.email ?? '',
          display_name: d.display_name ?? '',
          default_project_dir: d.default_project_dir ?? '',
          scoper: m.scoper ?? '',
          worker: m.worker ?? '',
          validator: m.validator ?? '',
          reviewer: m.reviewer ?? '',
          orchestrator: m.orchestrator ?? '',
        });
        setUpdatedAt(d.updated_at ?? null);
      })
      .catch((e) => { if (!cancelled) toast.error(`load failed: ${e?.message ?? e}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reset]);

  const onSubmit = async (data: ProfileFormData) => {
    try {
      const body: Profile = {
        email: data.email || undefined,
        display_name: data.display_name || undefined,
        default_project_dir: data.default_project_dir || undefined,
        preferred_models: {
          ...(data.scoper && { scoper: data.scoper }),
          ...(data.worker && { worker: data.worker }),
          ...(data.validator && { validator: data.validator }),
          ...(data.reviewer && { reviewer: data.reviewer }),
          ...(data.orchestrator && { orchestrator: data.orchestrator }),
        },
      };
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: Profile = await r.json();
      setUpdatedAt(d.updated_at ?? null);
      toast.success('Profile saved');
    } catch (e: any) {
      toast.error(`save failed: ${e?.message ?? e}`);
    }
  };

  if (loading) {
    return (
      <div>
        <h1>Profile</h1>
        <p className="pc-settings-loading">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Profile</h1>
      <p className="pc-settings-intro">
        Your identity (email + display name) and the model preferences used by each agent role.
      </p>

      <form onSubmit={submit(onSubmit)} className="pc-card">
        <FormField label="Email (optional)" error={errors.email?.message} description="Used to identify you in commit messages and agent attribution.">
          <input type="email" className="pc-input" placeholder="you@example.com" {...register('email')} />
        </FormField>

        <FormField label="Display name" error={errors.display_name?.message} description="Shown next to your harness runs and proposals.">
          <input type="text" className="pc-input" placeholder="Avi" {...register('display_name')} />
        </FormField>

        <FormField label="Default project directory" error={errors.default_project_dir?.message} description={
          <>Where <code>papercusp init &lt;slug&gt;</code> creates new project directories.</>
        }>
          <input type="text" className="pc-input" placeholder="~/papercusp-projects" {...register('default_project_dir')} />
        </FormField>

        <h3 style={{ marginTop: 24, marginBottom: 8 }}>Preferred models</h3>

        <ModelField label="scoper" help="Plans missions and reviews proposals. Bigger model = better plans." register={register('scoper')} error={errors.scoper?.message} />
        <ModelField label="worker" help="Implements features. The high-volume role; pick something fast." register={register('worker')} error={errors.worker?.message} />
        <ModelField label="validator" help="Verifies workers. Bigger model = catches more bugs." register={register('validator')} error={errors.validator?.message} />
        <ModelField label="reviewer" help="Gates plans and proposals. Should be at least as smart as scoper." register={register('reviewer')} error={errors.reviewer?.message} />
        <ModelField label="orchestrator" help="Coordinates the loop. Tiny model is fine — it's mostly routing." register={register('orchestrator')} error={errors.orchestrator?.message} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
          {updatedAt && (
            <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
              Last updated <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleString()}</time>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

function ModelField({ label, help, register, error }: { label: string; help: string; register: UseFormRegisterReturn; error?: string }) {
  return (
    <FormField label={label} error={error} description={help}>
      <input type="text" className="pc-input" placeholder="claude-sonnet-4-6" {...register} />
    </FormField>
  );
}
