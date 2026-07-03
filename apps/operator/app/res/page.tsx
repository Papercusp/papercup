/**
 * /res — Resources: workspace-scoped resource → fleet allocation.
 *
 * Hand your account pools and local GPUs to the fleets inside this
 * workspace's hive tree. The hive tree nests without limit (hives inside
 * hives); a FLEET is the terminal drop-target. Each assignment carries a
 * share %: accounts are adjustable, GPUs are locked at 100% until local
 * inference (P-207) lands.
 *
 * Gated by FLAGS.RES_ALLOCATION (default ON). Fully tokenized to the frost
 * semantic scale (design/tokens).
 *
 * STATUS: the UI (tree, drag/%, tokens) is real, and the PERSISTENCE BACKEND is
 * now landed (P-201) — harness_shared.resource_allotments (mig 473), the
 * `p2p.allotments` sync read resolver, and the `p2p-allotment-set` write route
 * (set/remove → notifySyncInvalidate('p2p.allotments')). What remains is the
 * CLIENT wire. This page still runs on the `useResData()` FIXTURE, so it is NOT
 * yet safe to persist: allotments keyed to fixture fleet/resource ids would
 * pollute the live table that P-206 reads. Remaining steps, in order:
 *   1. Replace the fixture inventory with real sources — accounts from the
 *      `accounts.pool` sync query; the hive→fleet tree from a (new) workspace
 *      tree query; GPUs stay an honest empty/stub until local inference (P-207).
 *   2. Seed `assignments` from useSyncQuery({ queryName: 'p2p.allotments' })
 *      (map fleetSlug / resourceRef / sharePct onto the board).
 *   3. On assign/unassign/setPct, POST /api/agent-mcp/p2p-allotment-set
 *      ({ action:'set'|'remove', fleetSlug, resourceKind, resourceRef, sharePct }).
 *   4. Live-verify the round-trip in the Tauri shell.
 * The account axis is ungated; the GPU axis waits on the owner's option-(a/b)
 * (inference-server vs foreign-spawn) decision, so build accounts first.
 */
'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import './res.css';

type ResType = 'account' | 'gpu';

interface FleetNode {
  kind: 'fleet';
  id: string;
  name: string;
  who: string;
  spendUsed: number;
  spendCap: number;
}
interface HiveNode {
  kind: 'hive';
  id: string;
  name: string;
  who: string;
  children: ResNode[];
}
type ResNode = HiveNode | FleetNode;

interface ResourceCard {
  id: string;
  type: ResType;
  label: string;
  meta: string;
}

interface Assignment {
  resId: string;
  type: ResType;
  label: string;
  pct: number;
}

/**
 * Data seam. TODO(res-allocation backend): replace the fixture with
 * useSyncQuery({ queryName: 'resAllocation', args: { workspace } }) — hive tree
 * from the hive registry, accounts from accounts:list, GPUs from the
 * provisioner/capacity ads, and existing allocations from the workspace-scoped
 * `resource_allocations` table.
 */
function useResData(): { tree: HiveNode; accounts: ResourceCard[]; gpus: ResourceCard[] } {
  return useMemo(
    () => ({
      tree: {
        kind: 'hive',
        id: 'root',
        name: 'Home hive',
        who: '@marsh',
        children: [
          { kind: 'fleet', id: 'widgets', name: 'Widgets', who: '@marsh', spendUsed: 4.1, spendCap: 12 },
          { kind: 'fleet', id: 'scout', name: 'Scout gym', who: '@marsh', spendUsed: 0, spendCap: 5 },
          {
            kind: 'hive',
            id: 'labs',
            name: 'Labs',
            who: 'shared',
            children: [
              { kind: 'fleet', id: 'render', name: 'Render farm', who: '@kite-labs', spendUsed: 0.6, spendCap: 7 },
              {
                kind: 'hive',
                id: 'vision',
                name: 'Vision sub-hive',
                who: 'shared',
                children: [
                  { kind: 'fleet', id: 'ocr', name: 'OCR batch', who: '@jpeg-dev', spendUsed: 0, spendCap: 3 },
                  { kind: 'fleet', id: 'seg', name: 'Segmentation', who: '@jpeg-dev', spendUsed: 1.2, spendCap: 4 },
                ],
              },
            ],
          },
        ],
      },
      accounts: [
        { id: 'a-main', type: 'account', label: 'Anthropic · main', meta: '5 accounts · auto-failover' },
        { id: 'a-over', type: 'account', label: 'Anthropic · overflow', meta: '3 accounts · reserve' },
        { id: 'a-oai', type: 'account', label: 'OpenAI · personal', meta: '1 account' },
      ],
      gpus: [
        { id: 'g-0', type: 'gpu', label: 'GPU 0 · RTX 4090', meta: '24 GB · idle' },
        { id: 'g-1', type: 'gpu', label: 'GPU 1 · RTX 4090', meta: '24 GB · idle' },
      ],
    }),
    [],
  );
}

function countFleets(n: ResNode): number {
  return n.kind === 'fleet' ? 1 : n.children.reduce((s, c) => s + countFleets(c), 0);
}

export default function ResourcesPage() {
  const { tree, accounts, gpus } = useResData();
  const workspace = 'papercusp-workspace'; // TODO: from the active workspace context

  // Tree expansion is user-meaningful view state → URL (nuqs). We store the
  // COLLAPSED hive ids (default: everything expanded).
  const [collapsedParam, setCollapsedParam] = useQueryState('collapsed', parseAsString.withDefault(''));
  const collapsed = useMemo(
    () => new Set(collapsedParam.split(',').filter(Boolean)),
    [collapsedParam],
  );
  const toggleHive = useCallback(
    (id: string) => {
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      void setCollapsedParam([...next].join(',') || null);
    },
    [collapsed, setCollapsedParam],
  );

  // Assignments are a mid-edit DRAFT until the backend lands → local state.
  const [assignments, setAssignments] = useState<Record<string, Assignment[]>>({});
  const dragRef = useRef<ResourceCard | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [overFleet, setOverFleet] = useState<string | null>(null);

  const allCards = useMemo(() => [...accounts, ...gpus], [accounts, gpus]);

  const assign = useCallback((fleetId: string, card: ResourceCard) => {
    setAssignments((prev) => {
      const list = prev[fleetId] ?? [];
      if (list.some((a) => a.resId === card.id)) return prev; // already assigned
      return {
        ...prev,
        [fleetId]: [...list, { resId: card.id, type: card.type, label: card.label, pct: 100 }],
      };
    });
  }, []);
  const unassign = useCallback((fleetId: string, resId: string) => {
    setAssignments((prev) => ({
      ...prev,
      [fleetId]: (prev[fleetId] ?? []).filter((a) => a.resId !== resId),
    }));
  }, []);
  const setPct = useCallback((fleetId: string, resId: string, pct: number) => {
    setAssignments((prev) => ({
      ...prev,
      [fleetId]: (prev[fleetId] ?? []).map((a) => (a.resId === resId ? { ...a, pct } : a)),
    }));
  }, []);

  const fleetsFor = useCallback(
    (resId: string): string[] => {
      const names: string[] = [];
      const walk = (n: ResNode) => {
        if (n.kind === 'fleet') {
          if ((assignments[n.id] ?? []).some((a) => a.resId === resId)) names.push(n.name);
        } else n.children.forEach(walk);
      };
      walk(tree);
      return names;
    },
    [assignments, tree],
  );

  const onCardClick = useCallback(
    (id: string) => setPickedId((cur) => (cur === id ? null : id)),
    [],
  );
  const onFleetActivate = useCallback(
    (fleetId: string) => {
      if (!pickedId) return;
      const card = allCards.find((c) => c.id === pickedId);
      if (card) assign(fleetId, card);
      setPickedId(null);
    },
    [pickedId, allCards, assign],
  );

  const renderNode = (n: ResNode): React.ReactNode => {
    if (n.kind === 'hive') {
      const isCollapsed = collapsed.has(n.id);
      const fleets = countFleets(n);
      return (
        <div key={n.id} className="res-branch">
          <button
            type="button"
            className="res-node"
            aria-expanded={!isCollapsed}
            onClick={() => toggleHive(n.id)}
          >
            <span className="res-chev" aria-hidden="true">▾</span>
            <span className="res-ico" aria-hidden="true">🐝</span>
            <span className="nm">{n.name}</span>
            <span className="who">{n.who}</span>
            <span className="cnt">{fleets} fleet{fleets !== 1 ? 's' : ''}</span>
          </button>
          {!isCollapsed && <div className="res-children">{n.children.map(renderNode)}</div>}
        </div>
      );
    }
    const list = assignments[n.id] ?? [];
    const pctW = n.spendCap > 0 ? Math.min(100, Math.round((n.spendUsed / n.spendCap) * 100)) : 0;
    return (
      <div key={n.id} className="res-branch">
        <div
          className={`res-fleet${overFleet === n.id ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOverFleet(n.id); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverFleet((c) => (c === n.id ? null : c)); }}
          onDrop={(e) => {
            e.preventDefault();
            setOverFleet(null);
            const card = dragRef.current;
            if (card) assign(n.id, card);
          }}
          onClick={() => onFleetActivate(n.id)}
        >
          <div className="res-fhead">
            <span className="dia" aria-hidden="true">◆</span>
            <span className="nm">{n.name}</span>
            <span className="who">{n.who}</span>
            <span className="res-cap">
              <span className="res-bar"><i style={{ width: `${pctW}%` }} /></span>
              <span>${n.spendUsed.toFixed(2)} / ${n.spendCap}</span>
            </span>
          </div>
          <div className="res-drop">
            {list.length === 0 && <span className="hint">Drop accounts or cards here</span>}
            {list.map((a) => (
              <span key={a.resId} className={`res-chip ${a.type === 'account' ? 'a' : 'g'}`}>
                <span className="lbl">{a.label}</span>
                {a.type === 'gpu' ? (
                  <span
                    className="pct locked"
                    title="Fractional GPU share arrives with local inference (P-207). Locked at 100% for now."
                  >
                    100%<span className="lock" aria-hidden="true">🔒</span>
                  </span>
                ) : (
                  <>
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={5}
                      value={a.pct}
                      aria-label={`${a.label} share percent`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setPct(n.id, a.resId, Number(e.target.value))}
                    />
                    <span className="pct">{a.pct}%</span>
                  </>
                )}
                <button
                  type="button"
                  className="x"
                  aria-label={`Remove ${a.label} from ${n.name}`}
                  onClick={(e) => { e.stopPropagation(); unassign(n.id, a.resId); }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const card = (c: ResourceCard) => {
    const on = fleetsFor(c.id);
    return (
      <div
        key={c.id}
        className={`res-card${dragId === c.id ? ' dragging' : ''}${pickedId === c.id ? ' picked' : ''}`}
        data-type={c.type}
        draggable
        onDragStart={(e) => { dragRef.current = c; setDragId(c.id); e.dataTransfer.effectAllowed = 'copy'; }}
        onDragEnd={() => { dragRef.current = null; setDragId(null); }}
        onClick={() => onCardClick(c.id)}
      >
        <span className="res-grip" aria-hidden="true">⠿</span>
        <div className="body">
          <div className="nm">{c.label}</div>
          <div className="mt">{c.meta}</div>
          <div className="assignedto">{on.length ? `→ ${on.join(', ')}` : ''}</div>
        </div>
        <span className={`res-tag ${c.type === 'account' ? 'a' : 'g'}`}>{c.type === 'account' ? 'POOL' : 'CARD'}</span>
      </div>
    );
  };

  return (
    <div className="res-page">
      <div className="res-head">
        <h1>Resources</h1>
        <p className="res-lede">
          Allocation is scoped to this workspace. Drag an account or a graphics card onto a{' '}
          <b>fleet</b> — the terminal level inside the hive tree — to hand it over.
        </p>
        <span className="res-ws">
          <span className="k">Workspace</span>
          <span className="v">{workspace}</span>
        </span>
      </div>

      <div className="res-board">
        <div className="res-col">
          <div className="res-colhead">
            <h2>Hives &amp; fleets</h2>
            <span className="ct">{countFleets(tree)} fleets</span>
          </div>
          <div className="res-tree">{renderNode(tree)}</div>
        </div>

        <div className="res-col">
          <div className="res-colhead">
            <h2>Accounts</h2>
            <span className="ct">{accounts.length} pools</span>
          </div>
          {accounts.map(card)}
        </div>

        <div className="res-col">
          <div className="res-colhead">
            <h2>Graphics cards</h2>
            <span className="ct">{gpus.length} local</span>
          </div>
          <div className="res-locknote">Share locked at 100% until local inference (P-207) ships.</div>
          {gpus.map(card)}
        </div>
      </div>

      <div className="res-hintbar">
        <span aria-hidden="true">💡</span>
        <div>
          Hives nest without limit — expand them to reach the fleets inside. Drop only lands on a{' '}
          <b>fleet</b>. Click a card then a fleet also works. Accounts take a <b>%</b>; GPUs are
          locked at 100% for now.
        </div>
      </div>

      <div className="res-draft-note">
        Draft — the tree, drag-and-drop, and share % are live, and the persistence backend is landed,
        but this board still runs on placeholder inventory, so nothing is saved yet. Real accounts,
        fleets, and save-on-drop are the next step.
      </div>
    </div>
  );
}
