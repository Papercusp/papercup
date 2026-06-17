'use client';

/**
 * NewPlanButton — the "New plan" launcher with an EXPLICIT owning-hive choice
 * (steering-nested-hive-plan-tree-2026-06-17, P-005).
 *
 * Plan creation launches a drafting agent scoped to a harness; the plan it
 * authors inherits that harness. The old button silently used the active-pot
 * scope, so with NO active pot it drafted at the operator/workspace (`all`)
 * scope — the exact failure that created 4 orphan plans on 2026-06-17 (plans the
 * Queen's eligibleHives didn't cover, so they were silently un-workable).
 *
 * Fix: when the active scope is CONCRETE, launch in it (unchanged). When it is
 * AMBIGUOUS (no active pot), make the owning hive an EXPLICIT choice — a small
 * menu of the workspace's hives (+ an explicit "Workspace-level") — instead of a
 * silent default. The chosen slug becomes the drafting agent's harness.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { groupByHive, type HiveGroupProject } from '@papercusp/operator-core/lib/harness/hive-groups';

export interface NewPlanProject {
  slug: string;
  harness_kind?: string | null;
  hive_slug?: string | null;
  parent_slug?: string | null;
}

export interface NewPlanButtonProps {
  /** The active harness/pot scope, or null when ambiguous (no active pot). */
  resolvedHarnessSlug: string | null;
  /** The workspace projects (from /api/harness/projects/lite). */
  projects: readonly NewPlanProject[];
  launching: boolean;
  /** Lower-case pot label for the no-active-scope hint. */
  potLabel: string;
  /** Launch the drafting agent in `ownerSlug` (null ⇒ workspace-level, explicit). */
  onLaunch: (ownerSlug: string | null) => void;
}

/** Flatten the hive groups into selectable owning-hive options (root then members). Pure. */
export function ownerHiveOptions(
  projects: readonly NewPlanProject[],
): Array<{ value: string; label: string; member: boolean }> {
  const out: Array<{ value: string; label: string; member: boolean }> = [];
  for (const group of groupByHive(projects as HiveGroupProject[])) {
    out.push({ value: group.root.slug, label: group.root.slug, member: false });
    for (const member of group.members) {
      if (member.slug === group.root.slug) continue;
      out.push({ value: member.slug, label: member.slug, member: true });
    }
  }
  return out;
}

export default function NewPlanButton({ resolvedHarnessSlug, projects, launching, potLabel, onLaunch }: NewPlanButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hiveOptions = useMemo(() => ownerHiveOptions(projects), [projects]);

  // Dismiss the menu on outside-click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Concrete scope (or no hives to choose from) → the plain button, unchanged.
  const concrete = !!resolvedHarnessSlug || hiveOptions.length === 0;
  if (concrete) {
    return (
      <button
        type="button"
        className="pc-plans__new-plan"
        onClick={() => onLaunch(resolvedHarnessSlug ?? null)}
        disabled={launching}
        title={
          resolvedHarnessSlug
            ? `Launch an agent session to draft a new plan in ${resolvedHarnessSlug}`
            : `Launch an agent session to draft a new plan (no active ${potLabel} — agent will ask)`
        }
      >
        <Plus size={14} aria-hidden />
        {launching ? 'Launching…' : 'New plan'}
      </button>
    );
  }

  // Ambiguous scope → require an EXPLICIT owning-hive choice.
  const pick = (slug: string | null) => {
    setMenuOpen(false);
    onLaunch(slug);
  };
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="pc-plans__new-plan"
        onClick={() => setMenuOpen((o) => !o)}
        disabled={launching}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Choose the owning hive for the new plan"
      >
        <Plus size={14} aria-hidden />
        {launching ? 'Launching…' : 'New plan'}
        <ChevronDown size={12} aria-hidden style={{ marginLeft: 'auto' }} />
      </button>
      {menuOpen && (
        <div
          role="menu"
          aria-label="New plan in hive"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--border, rgba(125, 211, 252, 0.22))',
            background: 'var(--bg-1, #0b1626)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg-mute, #7f9bb4)', padding: '4px 8px' }}>
            New plan in…
          </div>
          {hiveOptions.map((h) => (
            <button
              key={h.value}
              type="button"
              role="menuitem"
              className="pc-plans__newplan-item"
              onClick={() => pick(h.value)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: h.member ? '5px 8px 5px 20px' : '5px 8px',
                fontSize: 12,
                color: 'var(--fg, #e7f7ff)',
                background: 'none',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              {h.member ? `↳ ${h.label}` : h.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="pc-plans__newplan-item"
            onClick={() => pick(null)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '5px 8px',
              marginTop: 4,
              fontSize: 11.5,
              color: 'var(--fg-mute, #7f9bb4)',
              background: 'none',
              border: 'none',
              borderTop: '1px solid var(--border, rgba(125, 211, 252, 0.14))',
              borderRadius: 0,
              cursor: 'pointer',
            }}
            title="Draft at the workspace level (no owning hive) — explicit, not the silent default"
          >
            Workspace-level (no hive)
          </button>
        </div>
      )}
    </div>
  );
}
