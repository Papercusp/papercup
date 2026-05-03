'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { UseFormRegisterReturn } from 'react-hook-form';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

interface MaskedCoreCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

interface VoiceCredsState { configured: boolean; apiKey: string | null }
interface VoiceCredsSnapshot {
  elevenlabs: VoiceCredsState;
  openai: VoiceCredsState;
  cartesia: VoiceCredsState;
  deepgram: VoiceCredsState;
  picovoice: VoiceCredsState;
  google: VoiceCredsState;
}

// Core keys (Anthropic LLM, OpenAI, GitHub) — leave-alone-on-empty semantics.
const ApiKeysSchema = z.object({
  anthropic: z.string().optional().default(''),
  openai: z.string().optional().default(''),
  github: z.string().optional().default(''),
});
type ApiKeysFormData = z.infer<typeof ApiKeysSchema>;

export default function ApiKeysPage() {
  const [masked, setMasked] = useState<MaskedCoreCredentials | null>(null);
  const [voiceCreds, setVoiceCreds] = useState<VoiceCredsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const { register, submit, reset, errors, isSubmitting } = useFormWith(ApiKeysSchema, {
    defaultValues: { anthropic: '', openai: '', github: '' },
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/credentials').then(r => r.json()),
      fetch('/api/agent-mcp/operator-credentials').then(r => r.ok ? r.json() : null),
    ])
      .then(([core, voice]) => {
        if (cancelled) return;
        setMasked(core);
        if (voice) setVoiceCreds(voice as VoiceCredsSnapshot);
      })
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
      const d: MaskedCoreCredentials = await r.json();
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

      <h2 style={{ marginTop: 24, fontSize: 18 }}>Core</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginBottom: 12 }}>
        Anthropic powers the harness roles via <code>claude -p</code>. OpenAI is
        a fallback for some plugins. GitHub PAT is needed only when publishing
        harnesses to the marketplace.
      </p>

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
          label="OpenAI API key (LLM)"
          help="Optional fallback for some plugins. NOTE: this is a separate slot from the OpenAI voice key below."
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

      <h2 style={{ marginTop: 32, fontSize: 18 }}>Voice & cloud engines</h2>
      <p style={{ color: 'var(--fg-mute)', fontSize: 13, marginBottom: 12 }}>
        Optional keys for cloud STT (Deepgram), cloud TTS (ElevenLabs, OpenAI,
        Cartesia), wake-word/noise-suppression (Picovoice), and full-agent voice
        modes (Google for Gemini Live, OpenAI for Realtime). Configure only the
        ones you actually use — local Voicemode + Kokoro work without any of these.
      </p>
      {voiceCreds && (
        <div style={{ maxWidth: 640 }}>
          <VoiceKeyRow
            label="OpenAI (voice)"
            field="openaiApiKey"
            state={voiceCreds.openai}
            placeholder="sk-..."
            helpUrl="https://platform.openai.com/api-keys"
            note="Used for OpenAI tts-1 voices AND OpenAI Realtime full-agent mode."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="ElevenLabs"
            field="elevenlabsApiKey"
            state={voiceCreds.elevenlabs}
            placeholder="sk_..."
            helpUrl="https://elevenlabs.io/app/settings/api-keys"
            note="ElevenLabs Turbo v2.5 TTS + ElevenLabs Conversational AI full-agent mode."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Cartesia"
            field="cartesiaApiKey"
            state={voiceCreds.cartesia}
            placeholder="sk_..."
            helpUrl="https://play.cartesia.ai/keys"
            note="Cartesia Sonic-2 TTS — fastest first-byte (<100ms)."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Deepgram"
            field="deepgramApiKey"
            state={voiceCreds.deepgram}
            placeholder="dg_..."
            helpUrl="https://console.deepgram.com/project/default/keys"
            note="Deepgram Nova-2 STT (alternative to Voicemode whisper)."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Picovoice"
            field="picovoiceApiKey"
            state={voiceCreds.picovoice}
            placeholder="pv_..."
            helpUrl="https://console.picovoice.ai/"
            note="Wake-word (Porcupine) + noise suppression (Koala). Free tier covers personal use."
            onChange={(snap) => setVoiceCreds(snap)}
          />
          <VoiceKeyRow
            label="Google AI"
            field="googleApiKey"
            state={voiceCreds.google}
            placeholder="AIza..."
            helpUrl="https://aistudio.google.com/app/apikey"
            note="Google Gemini Live full-agent mode. Free tier available via AI Studio."
            onChange={(snap) => setVoiceCreds(snap)}
          />
        </div>
      )}
    </div>
  );
}

function VoiceKeyRow({
  label, field, state, placeholder, helpUrl, note, onChange,
}: {
  label: string;
  field: 'elevenlabsApiKey' | 'openaiApiKey' | 'cartesiaApiKey' | 'deepgramApiKey' | 'picovoiceApiKey' | 'googleApiKey';
  state: VoiceCredsState;
  placeholder: string;
  helpUrl: string;
  note: string;
  onChange: (snap: VoiceCredsSnapshot) => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: draft.trim() }),
      });
      if (r.ok) {
        onChange((await r.json()) as VoiceCredsSnapshot);
        setDraft('');
        toast.success(`${label} key saved`);
      } else {
        toast.error(`Save failed: HTTP ${r.status}`);
      }
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!confirm(`Clear the ${label} API key?`)) return;
    setBusy(true);
    try {
      const r = await fetch('/api/agent-mcp/operator-credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: null }),
      });
      if (r.ok) onChange((await r.json()) as VoiceCredsSnapshot);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        <a href={helpUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, opacity: 0.7 }}>get key →</a>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginBottom: 8 }}>{note}</p>
      {state.configured ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code style={{ padding: '4px 8px', background: 'var(--bg-1)', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }}>
            {state.apiKey ?? '(masked)'}
          </code>
          <button type="button" onClick={clear} disabled={busy}
            style={{ padding: '4px 10px', fontSize: 12, color: '#fca5a5', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
            Clear
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            style={{ flex: 1, padding: '4px 8px', fontSize: 12, fontFamily: 'monospace' }}
          />
          <button type="button" onClick={save} disabled={busy || !draft.trim()}
            style={{ padding: '4px 12px', fontSize: 12, background: 'var(--cta-bg, #1f2937)', color: 'var(--cta-fg, #fff)', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
            Save
          </button>
        </div>
      )}
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
