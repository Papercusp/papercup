'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import type { ActionBlock } from '@restart/agent-chat';
import { applyPlanBlock } from '@/app/admin/plans/plans-api';

// Preview-only parser. The server (plan-block-handler.ts) re-parses on
// apply with its own implementation — this one exists ONLY to render
// the user-facing summary (title, item count) before they click accept.
// On accept we send the raw block content to the server, which is the
// single source of truth for actually creating the plan.
interface ParsedPromotePlan {
  title: string;
  summary: string;
  hasSummary: boolean;
  body: string;
  nowState: string;
  nowNext: string;
  items: Array<{ phase: string; text: string }>;
  decisions: Array<{ title: string; body: string }>;
}

function parseBlock(content: string): ParsedPromotePlan {
  const trimmed = content.trim();
  const lines = trimmed.split('\n');
  const sep = lines.findIndex((l) => /^-{3,}$/.test(l.trim()));

  let title = '';
  let summary = '';
  let body = trimmed;

  if (sep > 0) {
    for (const line of lines.slice(0, sep)) {
      const m = /^TITLE:\s*(.+)/i.exec(line);
      if (m) title = m[1].trim();
      const s = /^SUMMARY:\s*(.+)/i.exec(line);
      if (s) summary = s[1].trim();
    }
    body = lines.slice(sep + 1).join('\n').trim();
  }

  // Extract ## Now → State / Next
  let nowState = '';
  let nowNext = '';
  const nowMatch = /##\s+Now\s*\n([\s\S]*?)(?=\n##\s|\n###\s|$)/.exec(body);
  if (nowMatch) {
    const nowBlock = nowMatch[1];
    const stateM = /\*\*State:\*\*\s*([\s\S]*?)(?=\*\*Next:\*\*|$)/.exec(nowBlock);
    if (stateM) nowState = stateM[1].trim();
    const nextM = /\*\*Next:\*\*\s*(.+)/.exec(nowBlock);
    if (nextM) nowNext = nextM[1].trim();
  }

  // Extract phase items — skip ## Now and ## Decisions headings
  const items: Array<{ phase: string; text: string }> = [];
  const phaseRe = /^##\s+(.+)$/gm;
  let phaseMatch: RegExpExecArray | null;
  const phasePositions: Array<{ phase: string; start: number }> = [];
  while ((phaseMatch = phaseRe.exec(body)) !== null) {
    phasePositions.push({ phase: phaseMatch[1].trim(), start: phaseMatch.index });
  }
  for (let i = 0; i < phasePositions.length; i++) {
    const { phase, start } = phasePositions[i];
    if (/^(Now|Decisions?)$/i.test(phase)) continue;
    const end = i + 1 < phasePositions.length ? phasePositions[i + 1].start : body.length;
    const section = body.slice(start, end);
    for (const line of section.split('\n')) {
      const m = /^-\s+\[[ xX]?\]\s+(?:P-\d+\s+)?(.+)$/.exec(line.trim());
      if (m) items.push({ phase, text: m[1].trim() });
    }
  }

  // Extract decisions
  const decisions: Array<{ title: string; body: string }> = [];
  const decisionsM = /##\s+Decisions?\s*\n([\s\S]*)$/.exec(body);
  if (decisionsM) {
    const decContent = decisionsM[1];
    const decBlocks = decContent.split(/(?=###\s)/);
    for (const block of decBlocks) {
      const titleM = /^###\s+(?:D-\d+:\s+)?(.+)$/m.exec(block);
      if (!titleM) continue;
      const decTitle = titleM[1].trim();
      const decBody = block.replace(/^###[^\n]*\n/, '').trim();
      if (decTitle && decBody) decisions.push({ title: decTitle, body: decBody });
    }
  }

  return { title, summary, hasSummary: !!summary, body, nowState, nowNext, items, decisions };
}

export function PromotePlanBlock({
  block,
  harnessSlug,
  onAccepted,
}: {
  block: ActionBlock;
  /** When set, the server invalidates plansDrafts.bySlug for this
   *  harness on success so ProposalsPanel sees the new card immediately. */
  harnessSlug?: string;
  onAccepted?: (planSlug: string) => void;
}) {
  const [stage, setStage] = useState<'idle' | 'applying' | 'applied' | 'error'>('idle');
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(() => parseBlock(block.content), [block.content]);

  const accept = async () => {
    if (!parsed.title) {
      setError('Block is missing TITLE — cannot create plan.');
      return;
    }
    setStage('applying');
    setError(null);

    try {
      // Single round-trip: send the raw block content; the server
      // (plan-block-handler.ts) parses, validates, and applies the
      // plans:new → set-now → add-item × N → add-decision × N
      // sequence atomically under the plan-lock.
      const res = await applyPlanBlock({
        blockContent: block.content,
        ...(harnessSlug && { harnessSlug }),
      });
      if (!('ok' in res) || !res.ok) {
        const errMsg = 'error' in res ? String((res as Record<string, unknown>).error) : 'apply-plan-block failed';
        const detail = 'detail' in res ? String((res as Record<string, unknown>).detail) : '';
        throw new Error(detail ? `${errMsg}: ${detail}` : errMsg);
      }
      const finalSlug =
        'slug' in res && typeof (res as Record<string, unknown>).slug === 'string'
          ? ((res as Record<string, unknown>).slug as string)
          : '';
      if (!finalSlug) {
        throw new Error('Server did not return a slug for the created plan.');
      }

      setCreatedSlug(finalSlug);
      setStage('applied');
      toast.success(`Plan "${parsed.title}" created as draft.`);
      onAccepted?.(finalSlug);
    } catch (e) {
      setStage('error');
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(`Failed to create plan: ${msg}`);
    }
  };

  const lineCount = parsed.body.split('\n').length;

  return (
    <div className="h-action-block">
      <div className="h-action-head">
        <span className="h-action-head-label">proposed →</span>
        <span className="h-action-head-target">new plan</span>
        <div className="h-action-head-btns">
          {stage === 'applied' && createdSlug ? (
            <a
              href={`/adv/plans?${harnessSlug ? `slug=${encodeURIComponent(harnessSlug)}&` : ''}plan=${encodeURIComponent(createdSlug)}`}
              className="h-btn ghost"
              style={{ padding: '2px 8px', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ExternalLink size={10} /> view plan
            </a>
          ) : (
            <button
              className={`h-btn ${stage === 'applied' ? 'ghost' : 'primary'}`}
              onClick={accept}
              disabled={stage === 'applying' || stage === 'applied'}
              style={{ padding: '2px 8px', fontSize: 10 }}
            >
              {stage === 'applied' ? (
                <><Check size={10} /> created</>
              ) : stage === 'applying' ? (
                <><Loader2 size={10} className="h-spin" /> creating…</>
              ) : (
                'accept'
              )}
            </button>
          )}
        </div>
      </div>

      {parsed.hasSummary && (
        <div style={{
          padding: '10px 12px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--fg)',
          background: 'color-mix(in oklab, var(--bg-2), white 2%)',
          borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 40%)',
        }}>
          <strong style={{ display: 'block', marginBottom: 3 }}>{parsed.title}</strong>
          {parsed.summary}
          {parsed.items.length > 0 && (
            <span style={{ color: 'var(--fg-mute)', fontSize: 11, marginLeft: 6 }}>
              · {parsed.items.length} item{parsed.items.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {error && (
        <div style={{
          padding: '8px 12px',
          fontSize: 11,
          color: 'var(--error, #f7768e)',
          borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 40%)',
        }}>
          {error}
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          width: '100%',
          padding: '5px 12px',
          background: 'transparent',
          border: 'none',
          borderBottom: expanded ? '1px solid color-mix(in oklab, var(--border), transparent 40%)' : 'none',
          color: 'var(--fg-dim)',
          fontSize: 10,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {expanded
          ? 'hide plan'
          : `show plan · ${lineCount} line${lineCount === 1 ? '' : 's'}`}
      </button>

      {expanded && (
        <pre className="h-action-body expanded" style={{ maxHeight: '40vh', overflow: 'auto' }}>
          {parsed.body}
        </pre>
      )}
    </div>
  );
}
