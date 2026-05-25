'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import type { ActionBlock } from '@restart/agent-chat';
import {
  addPlanDecision,
  addPlanItem,
  createPlan,
  setPlanNow,
} from '@/app/admin/plans/plans-api';

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

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
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
  onAccepted,
}: {
  block: ActionBlock;
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

    const slug = slugify(parsed.title);
    try {
      const newRes = await createPlan({ slug, title: parsed.title, status: 'draft' });
      if (!('ok' in newRes) || !newRes.ok) {
        throw new Error('error' in newRes ? String((newRes as Record<string, unknown>).error) : 'plans:new failed');
      }
      const finalSlug: string =
        'slug' in newRes && typeof (newRes as Record<string, unknown>).slug === 'string'
          ? (newRes as Record<string, unknown>).slug as string
          : slug;

      if (parsed.nowState || parsed.nowNext) {
        const nowRes = await setPlanNow({
          slug: finalSlug,
          state: parsed.nowState || 'Plan created from architect proposal.',
          next: parsed.nowNext || 'Review and refine the plan items.',
        });
        if (!('ok' in nowRes) || !nowRes.ok) {
          const msg = 'error' in nowRes ? String((nowRes as Record<string, unknown>).error) : 'set-now failed';
          toast.warning(`Plan created but Now block failed: ${msg}`);
        }
      }

      for (const item of parsed.items) {
        const r = await addPlanItem({ slug: finalSlug, phase: item.phase, text: item.text });
        if (!('ok' in r) || !r.ok) {
          const msg = 'error' in r ? String((r as Record<string, unknown>).error) : 'add-item failed';
          toast.warning(`Item "${item.text.slice(0, 40)}" failed: ${msg}`);
        }
      }

      for (const dec of parsed.decisions) {
        const r = await addPlanDecision({ slug: finalSlug, title: dec.title, body: dec.body });
        if (!('ok' in r) || !r.ok) {
          const msg = 'error' in r ? String((r as Record<string, unknown>).error) : 'add-decision failed';
          toast.warning(`Decision "${dec.title.slice(0, 40)}" failed: ${msg}`);
        }
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
              href={`/adv/plans?slug=${encodeURIComponent(createdSlug)}`}
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
