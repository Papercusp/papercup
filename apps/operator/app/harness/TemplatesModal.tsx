'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Checkbox } from './Checkbox';
import { MarkdownPreview } from '../_components/MarkdownEditor';
import { useConfirmDialog } from './useConfirmDialog';

interface Template {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  files: string[];
}

interface Props {
  slug: string;
  onClose: () => void;
  onBootstrapped: () => void;
}

export default function TemplatesModal({ slug, onClose, onBootstrapped }: Props) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selected, setSelected] = useState<Template | null>(null);
  const [preview, setPreview] = useState<{ file: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [working, setWorking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/templates`).then((r) => r.json());
      setTemplates(d.templates ?? []);
      if (d.templates?.length > 0) setSelected(d.templates[0]);
    } catch (e) {
      setToast(`load failed: ${e}`);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected || !selected.files.includes('SPEC.md')) {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    fetch(`/api/harness/templates/${selected.id}/file?name=SPEC.md`)
      .then((r) => r.ok ? r.text() : '')
      .then((content) => setPreview({ file: 'SPEC.md', content }))
      .catch(() => setPreview(null))
      .finally(() => setPreviewLoading(false));
  }, [selected]);

  const bootstrap = useCallback(async () => {
    if (!selected) return;
    if (!await askConfirm({
      title: `Bootstrap "${slug}" from "${selected.name}"?`,
      body: overwrite
        ? 'Existing SPEC.md / AGENTS.md / config.json will be overwritten.'
        : 'Copies template files into this harness. Existing files are kept.',
      confirmLabel: 'Bootstrap',
      destructive: overwrite,
    })) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/harness/${slug}/bootstrap-from-template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateId: selected.id, overwrite }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      const copied = (d.copied ?? []).join(', ') || 'none';
      const skipped = (d.skipped ?? []).join(', ');
      setToast(`copied: ${copied}${skipped ? ` · skipped: ${skipped}` : ''}`);
      onBootstrapped();
      setTimeout(() => { setToast(null); onClose(); }, 1500);
    } catch (e) {
      setToast(`bootstrap failed: ${e}`);
      setTimeout(() => setToast(null), 3500);
    } finally {
      setWorking(false);
    }
  }, [selected, slug, overwrite, onClose, onBootstrapped]);

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Templates`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: '80vw', maxWidth: 1000, height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'system-ui, sans-serif', color: 'var(--fg)' }}
    >
      {confirmEl}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong>Mission templates</strong>
          <span style={{ color: 'var(--fg-mute)', fontSize: '0.75rem', fontFamily: 'monospace' }}>→ {slug}</span>
          {toast && (
            <span style={{ marginLeft: 'auto', color: /failed/i.test(toast) ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem' }}>{toast}</span>
          )}
          <button
            onClick={onClose}
            style={{ marginLeft: toast ? 0 : 'auto', background: 'transparent', color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            close
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 36%', borderRight: '1px solid var(--border)', overflow: 'auto' }}>
            {templates === null ? (
              <div style={{ padding: '1rem', color: 'var(--fg-mute)' }}>loading…</div>
            ) : templates.length === 0 ? (
              <div style={{ padding: '1rem', color: 'var(--fg-mute)' }}>
                No templates found.<br/>
                Add directories under <code>~/autonomous-harness/templates/projects/&lt;id&gt;/</code> with a <code>meta.json</code> and SPEC.md/AGENTS.md.
              </div>
            ) : (
              <div>
                {templates.map((t) => {
                  const isActive = selected?.id === t.id;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setSelected(t)}
                      style={{
                        padding: '0.75rem 1rem',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border)',
                        background: isActive ? '#1f2937' : 'transparent',
                      }}
                    >
                      <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{t.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--fg-mute)', marginTop: '0.2rem' }}>{t.description}</div>
                      {t.tags && t.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.35rem' }}>
                          {t.tags.map((tag) => (
                            <span key={tag} style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: 'var(--bg-3)', color: 'var(--fg-dim)' }}>
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: '0.65rem', color: 'var(--fg-mute)', marginTop: '0.4rem', fontFamily: 'monospace' }}>
                        {t.files.join(' · ')}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {selected ? (
              <>
                <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', fontSize: '0.75rem', color: 'var(--fg-mute)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  SPEC.md preview
                  {previewLoading && <span style={{ color: 'var(--fg-mute)' }}>loading…</span>}
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: '0.75rem 1rem' }}>
                  <MarkdownPreview value={preview?.content ?? '(preview unavailable)'} outline="left" />
                </div>
                <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', cursor: 'pointer' }}>
                    <Checkbox checked={overwrite} onChange={setOverwrite} ariaLabel="Overwrite existing files" />
                    overwrite existing files
                  </label>
                  <button
                    onClick={bootstrap}
                    disabled={working}
                    style={{ marginLeft: 'auto', background: '#2563eb', color: 'white', border: 'none', borderRadius: 3, padding: '0.4rem 1rem', fontWeight: 600, cursor: working ? 'wait' : 'pointer', fontSize: '0.85rem' }}
                  >
                    {working ? 'bootstrapping…' : `bootstrap → ${slug}`}
                  </button>
                </div>
              </>
            ) : (
              <div style={{ color: 'var(--fg-mute)', textAlign: 'center', marginTop: '30%' }}>
                Select a template to preview.
              </div>
            )}
          </div>
        </div>
      </Modal>
  );
}
