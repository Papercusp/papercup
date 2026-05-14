'use client';

/**
 * Two small components used by FeaturePeekPanel:
 *
 *   - FeatureTagsAndSeeAlso — comma-separated input editors for
 *     `tags` and `see_also`, persisting via PATCH /:slug/features/:id.
 *     Tag normalization (lowercase, dedupe, format) happens server-side;
 *     we just send the raw text the user typed.
 *
 *   - FeatureMessagesList — pending feature-addressed messages addressed
 *     to this feature, with a "dismiss" button per message that calls
 *     POST /:slug/features/:id/messages/:msgId/dismiss.
 *
 * Both fetch on mount + slug/id change, refetch on save/dismiss. No
 * Zero subscription yet — keeps the surface area small. Migrating to
 * Zero is a follow-up if this needs cross-tab sync.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface FeatureRowFromApi {
  id: string;
  title: string;
  status: string;
  tags?: string[] | null;
  see_also?: string[] | null;
}

interface MessageRow {
  id: string;
  created_at: string;
  from_slug: string;
  from_feature_id: string | null;
  kind: string;
  subject: string;
  body: string | null;
  status: string;
}

const ROW_BORDER = '1px solid var(--border)';
const SUBTLE = 'var(--fg-mute)';

export function FeatureTagsAndSeeAlso({
  slug,
  featureId,
}: {
  slug: string;
  featureId: string;
}): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tagsRaw, setTagsRaw] = useState('');
  const [seeAlsoRaw, setSeeAlsoRaw] = useState('');
  const [originalTags, setOriginalTags] = useState<string[]>([]);
  const [originalSeeAlso, setOriginalSeeAlso] = useState<string[]>([]);
  const [vocabulary, setVocabulary] = useState<Array<{ tag: string; count: number }>>([]);

  // Tag vocabulary — populates the datalist below the tags input so
  // users see existing tag names with usage counts, encouraging reuse
  // over near-duplicate variants. Cheap (single GROUP BY).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${slug}/tags/vocabulary?limit=200`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.vocabulary) return;
        setVocabulary(data.vocabulary);
      })
      .catch(() => { /* best-effort; autocomplete just won't appear */ });
    return () => { cancelled = true; };
  }, [slug]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/harness/${slug}/features/${encodeURIComponent(featureId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { feature: FeatureRowFromApi };
      const tags = Array.isArray(data.feature.tags) ? data.feature.tags : [];
      const seeAlso = Array.isArray(data.feature.see_also) ? data.feature.see_also : [];
      setOriginalTags(tags);
      setOriginalSeeAlso(seeAlso);
      setTagsRaw(tags.join(', '));
      setSeeAlsoRaw(seeAlso.join(', '));
    } catch (e) {
      toast.error('Failed to load feature metadata', { description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [slug, featureId]);

  useEffect(() => { void reload(); }, [reload]);

  const dirty =
    parseList(tagsRaw).join(',') !== originalTags.join(',') ||
    parseList(seeAlsoRaw).join(',') !== originalSeeAlso.join(',');

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const tags = parseList(tagsRaw);
      const seeAlso = parseList(seeAlsoRaw);
      const r = await fetch(`/api/harness/${slug}/features/${encodeURIComponent(featureId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags, seeAlso }),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody?.error ?? `HTTP ${r.status}`);
      }
      toast.success('Saved');
      await reload();
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [slug, featureId, tagsRaw, seeAlsoRaw, reload]);

  if (loading) {
    return <div style={{ fontSize: 12, color: SUBTLE }}>Loading metadata…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: SUBTLE }}>
          Tags <span style={{ opacity: 0.7 }}>(comma-separated, lowercase + hyphens/underscores only)</span>
        </span>
        <input
          type="text"
          list={`tag-vocab-${featureId}`}
          value={tagsRaw}
          onChange={(e) => setTagsRaw(e.target.value)}
          placeholder="auth, security, db-schema"
          style={{ fontSize: 12, padding: '4px 8px', fontFamily: 'monospace' }}
          spellCheck={false}
        />
        {vocabulary.length > 0 && (
          <datalist id={`tag-vocab-${featureId}`}>
            {vocabulary.map((v) => (
              <option key={v.tag} value={v.tag} label={`${v.tag} (${v.count})`} />
            ))}
          </datalist>
        )}
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: SUBTLE }}>
          See also <span style={{ opacity: 0.7 }}>(comma-separated feature IDs)</span>
        </span>
        <input
          type="text"
          value={seeAlsoRaw}
          onChange={(e) => setSeeAlsoRaw(e.target.value)}
          placeholder="F-AUTH-001, F-PROFILE-002"
          style={{ fontSize: 12, padding: '4px 8px', fontFamily: 'monospace' }}
          spellCheck={false}
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          style={{
            fontSize: 11,
            padding: '4px 12px',
            cursor: !dirty || saving ? 'not-allowed' : 'pointer',
            opacity: !dirty || saving ? 0.5 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && !saving && (
          <span style={{ fontSize: 11, color: SUBTLE }}>Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

function parseList(raw: string): string[] {
  return Array.from(new Set(
    raw.split(',').map((s) => s.trim()).filter(Boolean),
  ));
}

export function FeatureMessagesList({
  slug,
  featureId,
}: {
  slug: string;
  featureId: string;
}): JSX.Element {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/harness/${slug}/features/${encodeURIComponent(featureId)}/messages`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { messages: MessageRow[] };
      setMessages(data.messages ?? []);
    } catch (e) {
      toast.error('Failed to load messages', { description: (e as Error).message });
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [slug, featureId]);

  useEffect(() => { void reload(); }, [reload]);

  const dismiss = useCallback(async (msgId: string) => {
    try {
      const r = await fetch(`/api/harness/${slug}/features/${encodeURIComponent(featureId)}/messages/${msgId}/dismiss`, {
        method: 'POST',
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody?.error ?? `HTTP ${r.status}`);
      }
      await reload();
    } catch (e) {
      toast.error('Dismiss failed', { description: (e as Error).message });
    }
  }, [slug, featureId, reload]);

  if (loading) {
    return <div style={{ fontSize: 12, color: SUBTLE }}>Loading messages…</div>;
  }
  if (messages.length === 0) {
    return <div style={{ fontSize: 12, color: SUBTLE }}>No pending messages.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {messages.map((m) => {
        const fromLabel = m.from_feature_id ? `${m.from_slug}/${m.from_feature_id}` : m.from_slug;
        const ts = (() => {
          try { return new Date(m.created_at).toLocaleString(); } catch { return m.created_at; }
        })();
        return (
          <div
            key={m.id}
            style={{
              border: ROW_BORDER,
              borderRadius: 4,
              padding: 8,
              fontSize: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong>{m.subject}</strong>
              <span style={{ color: SUBTLE, fontSize: 11 }}>[{m.kind}]</span>
              <span style={{ marginLeft: 'auto' }}>
                <button
                  type="button"
                  onClick={() => void dismiss(m.id)}
                  style={{ fontSize: 10, padding: '2px 8px', cursor: 'pointer' }}
                  title="Mark as archived; removes from prompt injection"
                >
                  Dismiss
                </button>
              </span>
            </div>
            <div style={{ color: SUBTLE, fontSize: 11 }}>
              From <code>{fromLabel}</code> · {ts}
            </div>
            {m.body && (
              <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11.5 }}>
                {m.body}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
