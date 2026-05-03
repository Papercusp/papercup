'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { z } from 'zod';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

const LoginSchema = z.object({
  email: z.string().email('Please enter a valid email'),
});
type LoginFormData = z.infer<typeof LoginSchema>;

function LoginForm() {
  const sp = useSearchParams();
  const error = sp.get('error');

  const [devUrl, setDevUrl] = useState<string | null>(null);
  const { register, submit, errors, isSubmitting } = useFormWith(LoginSchema, {
    defaultValues: { email: '' },
  });

  useEffect(() => {
    if (error === 'expired') toast.error('That magic link expired. Request a new one.');
    else if (error === 'consumed') toast.error('That magic link was already used.');
    else if (error === 'invalid_token') toast.error('That magic link is invalid.');
    else if (error) toast.error(`login error: ${error}`);
  }, [error]);

  const onSubmit = async (data: LoginFormData) => {
    setDevUrl(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? 'request failed');
      toast.success('Magic link sent. Check your email (or the dev console).');
      if (d?.devMagicUrl) setDevUrl(d.devMagicUrl);
    } catch (err: any) {
      toast.error(`failed: ${err?.message ?? err}`);
    }
  };

  return (
    <div className="pc-shell">
      <h1>Sign in</h1>
      <p>
        Enter your email and we&rsquo;ll send a one-time link. No passwords.
      </p>

      <div className="pc-card" style={{ maxWidth: 460 }}>
        <form onSubmit={submit(onSubmit)}>
          <FormField label="Email" error={errors.email}>
            <input
              type="email"
              className="pc-input"
              placeholder="you@example.com"
              autoComplete="email"
              {...register('email')}
            />
          </FormField>
          <SubmitButton pending={isSubmitting} pendingLabel="Sending…">Send magic link</SubmitButton>
        </form>

        {devUrl && (
          <div className="pc-warn" style={{ marginTop: 16 }}>
            🔧 <strong>Dev mode.</strong> Email isn&rsquo;t wired yet — open this link to sign in:
            <br />
            <a href={devUrl} style={{ wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
              {devUrl}
            </a>
          </div>
        )}
      </div>

      <div style={{ marginTop: 32, color: 'var(--fg-mute)', fontSize: 12 }}>
        <p>
          You don&rsquo;t need an account to use Papercusp locally. Visit{' '}
          <a href="/settings/api-keys">settings</a> to add your API keys
          and start running harnesses on your own machine right now.
          Sign-in is for syncing profile preferences across devices.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="pc-shell"><h1>Sign in</h1><p>loading…</p></div>}>
      <LoginForm />
    </Suspense>
  );
}
