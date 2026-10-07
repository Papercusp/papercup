/**
 * ReportProblemDialog — the desktop "Report a problem" door
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-014, D-048, D-013).
 *
 * Step 1: one sentence, "What went wrong?". Step 2, Review: the EXACT payload
 * that will be sent (built by problem-report.ts, redacted on the device), with
 * the opt-in "Attach recent log lines" tick, default off. Send posts that same
 * object plus its digest; the server refuses anything else. Anonymous.
 *
 * Open state is the `?report=true` URL param (nuqs), so agents can open it with
 * ui:dispatch; the palette command report.problem and the mod+shift+b shortcut
 * set the same param.
 */
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import './shortcuts-cheat-sheet.css';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useShortcutAction } from '../../lib/hotkeys';
import {
  PROBLEM_REPORT_LIMITS,
  buildProblemReport,
  previewDigest,
  type ProblemReportPayload,
} from '@papercusp/operator-core/lib/harness/improvements/problem-report';
import {
  installClientReportRing,
  readClientReportRing,
  type ClientReportError,
} from '@papercusp/operator-core/lib/client-report-ring';

// Record from app start, so the errors that led to a report are in the ring.
installClientReportRing();

interface Captured {
  route: string;
  search: string;
  errors: ClientReportError[];
  logLines: string[];
}

type SendResult = { routed: 'work-item' | 'memory'; id: string | null; delivery?: 'queued-for-federation' };

export default function ReportProblemDialog() {
  const [open, setOpen] = useQueryState('report', parseAsBoolean.withDefault(false));
  const [text, setText] = useState('');
  const [attachLog, setAttachLog] = useState(false);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SendResult | null>(null);

  useShortcutAction('report.problem', () => {
    void setOpen(!open);
  }, { enableOnFormTags: ['INPUT', 'TEXTAREA'] });

  useEffect(() => {
    if (!open) {
      setText('');
      setAttachLog(false);
      setCaptured(null);
      setError(null);
      setSent(null);
      return;
    }
    let cancelled = false;
    fetch('/api/desktop/version', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v: { appVersion?: string; sidecarSha?: string } | null) => {
        if (!cancelled && v?.appVersion) setAppVersion(v.sidecarSha ? `${v.appVersion} (${v.sidecarSha})` : v.appVersion);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The preview IS the payload: the Review step renders this object and Send posts it.
  const payload: ProblemReportPayload | null = useMemo(() => {
    if (!captured || !text.trim()) return null;
    return buildProblemReport({
      text,
      appVersion,
      route: captured.route,
      search: captured.search,
      recentErrors: captured.errors,
      attachLog,
      logLines: captured.logLines,
    });
  }, [captured, text, appVersion, attachLog]);

  const review = () => {
    const ring = readClientReportRing();
    setCaptured({ route: window.location.pathname, search: window.location.search, ...ring });
  };

  const send = async () => {
    if (!payload) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/desktop/report-problem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload, previewDigest: await previewDigest(payload) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`);
      setSent({ routed: body.routed, id: body.id ?? null, delivery: body.delivery });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) void setOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="kbd-cheat-overlay" />
        <Dialog.Content
          aria-label="Report a problem"
          data-testid="report-problem-dialog"
          style={{
            position: 'fixed', top: '12vh', left: '50%', transform: 'translateX(-50%)',
            width: 'min(640px, 92vw)', maxHeight: '76vh', overflow: 'hidden auto',
            background: 'var(--pc-surface, #16181d)', color: 'var(--pc-text, #e5e7eb)',
            border: '1px solid var(--pc-border, #2a2e37)', borderRadius: 10, padding: 16,
            zIndex: 1000, boxShadow: '0 18px 50px rgba(0,0,0,.5)', fontSize: 13,
          }}
        >
          <Dialog.Title style={{ fontSize: 14, margin: '0 0 6px' }}>Report a problem</Dialog.Title>
          <Dialog.Description style={{ fontSize: 11, opacity: 0.6, margin: '0 0 10px' }}>
            Nothing is sent until you press Send. No name, email or account is included.
          </Dialog.Description>

          {sent ? (
            <div data-testid="report-problem-sent">
              <p>Thanks — {sent.routed === 'memory' ? 'your note was saved' : 'your report was filed'}{sent.id ? ` as ${sent.id}` : ''}.</p>
              {sent.delivery === 'queued-for-federation' && <p>Queued for upstream delivery. Upstream receipt has not yet been confirmed.</p>}
              <button type="button" onClick={() => void setOpen(false)}>Close</button>
            </div>
          ) : !captured ? (
            <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) review(); }}>
              <label style={{ display: 'block', marginBottom: 6 }} htmlFor="report-problem-text">What went wrong?</label>
              <input
                id="report-problem-text"
                data-testid="report-problem-text"
                autoFocus
                value={text}
                maxLength={PROBLEM_REPORT_LIMITS.text}
                onChange={(e) => setText(e.target.value)}
                placeholder="One sentence"
                style={{ width: '100%', padding: '6px 8px', boxSizing: 'border-box' }}
              />
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => void setOpen(false)}>Cancel</button>
                <button type="submit" data-testid="report-problem-review" disabled={!text.trim()}>Review</button>
              </div>
            </form>
          ) : (
            <div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '0 0 8px' }}>
                <input
                  type="checkbox"
                  data-testid="report-problem-attach-log"
                  checked={attachLog}
                  onChange={(e) => setAttachLog(e.target.checked)}
                />
                Attach recent log lines ({captured.logLines.length})
              </label>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>This is exactly what will be sent:</div>
              <pre
                data-testid="report-problem-preview"
                style={{ maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, padding: 8, background: 'rgba(0,0,0,.25)', borderRadius: 6 }}
              >
                {payload ? JSON.stringify(payload, null, 2) : ''}
              </pre>
              {error ? <p role="alert" style={{ color: 'var(--pc-danger, #f87171)' }}>{error}</p> : null}
              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setCaptured(null)}>Back</button>
                <button type="button" data-testid="report-problem-send" disabled={!payload || sending} onClick={() => void send()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
