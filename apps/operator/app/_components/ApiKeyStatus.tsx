'use client';

import { useEffect, useState } from 'react';

interface Status {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
}

export default function ApiKeyStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    fetch('/api/credentials', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (status === null) {
    return <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>checking…</span>;
  }

  const anthropicOk = !!status.anthropic_api_key;
  const openaiOk = !!status.openai_api_key;
  const githubOk = !!status.github_pat;
  const anyOptionalSet = openaiOk || githubOk;

  const dotColor = anthropicOk ? 'var(--good)' : 'var(--warn)';
  const label = anthropicOk
    ? `Anthropic key set${anyOptionalSet ? ` · ${[openaiOk && 'OpenAI', githubOk && 'GitHub'].filter(Boolean).join(' · ')}` : ''}`
    : 'Anthropic key not set';

  return (
    <span
      title={`anthropic: ${anthropicOk ? '✓' : '✗'} · openai: ${openaiOk ? '✓' : '—'} · github: ${githubOk ? '✓' : '—'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-mute)' }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}
