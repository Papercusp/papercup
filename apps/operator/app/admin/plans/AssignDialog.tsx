'use client';

/**
 * AssignDialog — cross-user handoff / @-mention assign UI
 * (shared-hive-collaboration-2026-06-14 P-008, Brief B8).
 *
 * "Assign this plan / item to @user": a Popover-anchored picker over the live
 * coord roster (useCoordRoster → dev.coordPresence), with a filter typeahead +
 * an optional note. Assigning fires coord:send wake:true (assignToUser) — the
 * message lands in the assignee's inbox AND re-invokes them now (deliver-and-
 * wake). Open-state is a nuqs param (`assign`) so only one picker is open at a
 * time and the surface is agent-controllable; the in-flight selection/note are
 * local drafts.
 *
 * Reuses: Popover (anchored panel), ownerColor (P-003 per-user color) for the
 * member dot, sonner toast for feedback. No new design-system component.
 */

import { useMemo, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { AtSign } from 'lucide-react';
import { Popover } from '@/app/harness/Popover';
import { ownerColor } from '@/app/_components/owner-color';
import { useCoordRoster, assignToUser, type CoordRosterMember } from './plans-api';

interface AssignDialogProps {
  planSlug: string;
  /** Plan-item id (e.g. 'P-005') when assigning one item; omit/null for the whole plan. */
  itemRef?: string | null;
  /** Compact trigger (icon-only) for dense per-item rows; default false (labeled). */
  compact?: boolean;
}

/** A roster member reads as a "person" (vs a local bee session) when it carries
 *  a github identity / is a federated peer — sort those to the top. */
function isPerson(m: CoordRosterMember): boolean {
  return m.federated === true || (m.userId != null && m.userId !== '');
}

function memberMatches(m: CoordRosterMember, needle: string): boolean {
  if (!needle) return true;
  const hay = `${m.ownerLabel ?? ''} ${m.ownerId} ${m.intent ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

export default function AssignDialog({ planSlug, itemRef, compact = false }: AssignDialogProps) {
  const myKey = itemRef ? `item:${planSlug}:${itemRef}` : `plan:${planSlug}`;
  const [assign, setAssign] = useQueryState('assign', parseAsString);
  const open = assign === myKey;

  const roster = useCoordRoster();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const members = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = (roster.data ?? []).filter((m) => m.ownerId && memberMatches(m, needle));
    // People (federated peers / identified) first, then by label; stable.
    return [...all].sort((a, b) => {
      const pa = isPerson(a) ? 0 : 1;
      const pb = isPerson(b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.ownerLabel ?? a.ownerId).localeCompare(b.ownerLabel ?? b.ownerId);
    });
  }, [roster.data, filter]);

  const targetLabel = itemRef ? `item ${itemRef}` : 'this plan';

  function close() {
    void setAssign(null);
    setFilter('');
    setSelected(null);
    setNote('');
  }

  async function doAssign() {
    if (!selected || submitting) return;
    setSubmitting(true);
    const picked = members.find((m) => m.ownerId === selected);
    const who = picked?.ownerLabel ?? selected;
    try {
      const r = await assignToUser({
        to: [selected],
        planSlug,
        itemRef: itemRef ?? null,
        note: note.trim() || null,
      });
      if (r.error) {
        toast.error('Assign failed', { description: r.error });
        return;
      }
      const woken = r.wake?.woken ?? 0;
      toast.success(`Assigned ${targetLabel} to ${who}`, {
        description: woken > 0 ? 'Notified + woke them now.' : 'Delivered to their inbox.',
      });
      close();
    } catch (e) {
      toast.error('Assign failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => (o ? void setAssign(myKey) : close())}
      trigger={
        <button
          type="button"
          className={`pc-assign__trigger${compact ? ' is-compact' : ''}`}
          aria-label={`Assign ${targetLabel} to a user`}
          title={`Assign ${targetLabel} to @user`}
        >
          <AtSign size={compact ? 13 : 14} aria-hidden="true" />
          {compact ? null : <span>Assign</span>}
        </button>
      }
      contentClassName="pc-assign__panel"
      ariaLabel={`Assign ${targetLabel} to a user`}
    >
      <div className="pc-assign" role="group" aria-label={`Assign ${targetLabel}`}>
        <div className="pc-assign__head">Assign {targetLabel} to…</div>
        <input
          type="search"
          className="pc-assign__filter"
          placeholder="Filter people…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter roster"
          autoFocus
        />
        <ul className="pc-assign__list" role="listbox" aria-label="Roster">
          {roster.loading && members.length === 0 ? (
            <li className="pc-assign__empty">Loading roster…</li>
          ) : members.length === 0 ? (
            <li className="pc-assign__empty">No one online to assign.</li>
          ) : (
            members.slice(0, 50).map((m) => (
              <li key={m.ownerId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === m.ownerId}
                  className={`pc-assign__member${selected === m.ownerId ? ' is-selected' : ''}`}
                  onClick={() => setSelected(m.ownerId)}
                >
                  <span
                    className="pc-assign__dot"
                    aria-hidden="true"
                    style={{ background: ownerColor(m.userId ?? m.ownerId) }}
                  />
                  <span className="pc-assign__label">{m.ownerLabel ?? m.ownerId}</span>
                  {m.intent ? <span className="pc-assign__intent">{m.intent}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <textarea
          className="pc-assign__note"
          placeholder="Optional note for the assignee…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          aria-label="Assignment note"
        />
        <div className="pc-assign__actions">
          <button type="button" className="pc-assign__cancel" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="pc-assign__confirm"
            onClick={doAssign}
            disabled={!selected || submitting}
          >
            {submitting ? 'Assigning…' : 'Assign + notify'}
          </button>
        </div>
      </div>
    </Popover>
  );
}
