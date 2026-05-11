'use client';

import { useEffect, useState } from 'react';

interface Workspace {
  id: string;
  name: string;
}

interface Props {
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
}

export default function WorkspacePicker({ selected, onChange }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then((r) => (r.ok ? r.json() : { workspaces: [] }))
      .then((d) => {
        if (cancelled) return;
        setWorkspaces(d.workspaces ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allSelected = selected === null;

  function toggle(id: string) {
    if (allSelected) {
      // switching from "all" to specific: start with everything except `id`
      onChange(workspaces.filter((w) => w.id !== id).map((w) => w.id));
      return;
    }
    const next = selected!.includes(id)
      ? selected!.filter((x) => x !== id)
      : [...selected!, id];
    // empty array → revert to "all"
    onChange(next.length === 0 ? null : next);
  }

  if (loading) return <div className="pc-dev-muted">…</div>;

  return (
    <div className="pc-dev-ws-picker">
      <label className="pc-dev-ws-row">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onChange(allSelected ? [] : null)}
        />
        <span>All workspaces</span>
      </label>
      {workspaces.map((w) => (
        <label key={w.id} className="pc-dev-ws-row">
          <input
            type="checkbox"
            checked={allSelected || (selected?.includes(w.id) ?? false)}
            onChange={() => toggle(w.id)}
          />
          <span>{w.name || w.id}</span>
        </label>
      ))}
    </div>
  );
}
