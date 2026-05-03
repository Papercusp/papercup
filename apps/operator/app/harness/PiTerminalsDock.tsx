'use client';

/**
 * PiTerminalsDock — multi-pane container for pi/omp terminals.
 *
 * Wraps `dockview-react` so the operator can open multiple terminals as
 * tabs, drag them into splits, and rearrange. Each panel mounts its own
 * `<PiPanel>` instance, which independently spawns a pty, owns its xterm
 * instance, and tears everything down on unmount.
 *
 * Layout is persisted in localStorage per harness slug. On reload, the
 * previous arrangement is restored; pty contents are NOT restored (each
 * pane spawns a fresh pty).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview';
import 'dockview-react/dist/styles/dockview.css';
import { Plus, TerminalSquare } from "lucide-react";
import PiPanel from './PiPanel';
import ChatPanel from './ChatPanel';
import { Tooltip } from './Tooltip';

interface PiTerminalsDockProps {
  slug: string;
  /** Optional initial laneId for the first terminal — typically the active feature. */
  initialLaneId?: string;
}

interface TerminalPanelParams {
  slug: string;
  laneId?: string;
}

interface ChatPanelParams {
  slug: string;
  chatId: string;
}

const LAYOUT_STORAGE_PREFIX = 'papercusp:pi-dock-layout:';

function layoutKey(slug: string): string {
  return `${LAYOUT_STORAGE_PREFIX}${slug}`;
}

/**
 * Cross-component event for opening a chat panel from elsewhere in the
 * dashboard (e.g., FeaturePeekPanel's "chat" button). Dispatched on
 * window; the dock listens. Detail = the chat metadata to mount.
 *
 * Race fix: the event is fired by `openFeatureChat()` *before* the
 * caller switches the dashboard to the consoles tab — so when the
 * dispatcher fires, the dock hasn't mounted yet and no listener exists.
 * To handle that, every dispatch ALSO pushes the detail onto the
 * module-level `pendingOpens` queue. When the dock mounts (or when its
 * event listener fires), it drains the queue. Either path opens the
 * panel exactly once; the queue entry is removed as part of opening.
 */
export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

const pendingOpens: OpenChatEventDetail[] = [];

function drainPendingOpens(api: DockviewApi, slug: string): void {
  for (let i = pendingOpens.length - 1; i >= 0; i--) {
    const detail = pendingOpens[i];
    if (detail.slug !== slug) continue;
    const panelId = `chat-${detail.chatId}`;
    const existing = api.panels.find((p) => p.id === panelId);
    if (existing) {
      try { existing.api.setActive(); } catch { /* ignore */ }
    } else {
      // Add into the currently-active group so the new chat appears as
      // a tab next to whatever the user was looking at, not as a fresh
      // split. Without this, dockview defaults to creating a new group
      // when the layout is non-empty and the active group's reference
      // becomes ambiguous (StrictMode double-mount can do this).
      const activeGroup = api.activeGroup;
      const panel = api.addPanel({
        id: panelId,
        component: 'chat',
        title:
          detail.title ??
          (detail.featureId
            ? `${detail.role ?? 'agent'} · ${detail.featureId}`
            : (detail.role ?? 'chat')),
        params: { slug: detail.slug, chatId: detail.chatId } satisfies ChatPanelParams,
        ...(activeGroup ? { position: { referenceGroup: activeGroup } } : {}),
      });
      // addPanel restores the previously-active panel from saved layout
      // by default — explicitly activate the new one so the user sees
      // their just-opened chat instead of a stale layout-restored panel.
      try { panel.api.setActive(); } catch { /* ignore */ }
    }
    pendingOpens.splice(i, 1);
  }
}

/**
 * Validate any restored chat panels against the live chat list. Any chat
 * panel whose chat row no longer exists (deleted or archived) gets closed
 * so the operator doesn't see ghost panels from past sessions.
 *
 * Async + best-effort: if the fetch fails, leave the layout alone.
 */
async function pruneStaleChatPanels(api: DockviewApi, slug: string): Promise<void> {
  const chatPanelIds = api.panels
    .map((p) => p.id)
    .filter((id) => id.startsWith('chat-'));
  if (chatPanelIds.length === 0) return;

  let liveChatIds: Set<string>;
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats`);
    if (!r.ok) return;
    const body = await r.json() as { chats?: Array<{ id: string }> };
    liveChatIds = new Set((body.chats ?? []).map((c) => c.id));
  } catch {
    return;
  }

  for (const panelId of chatPanelIds) {
    const chatId = panelId.slice('chat-'.length);
    if (!liveChatIds.has(chatId)) {
      const panel = api.getPanel(panelId);
      if (panel) {
        try { api.removePanel(panel); } catch { /* ignore */ }
      }
    }
  }
}

/** Component rendered inside each dockview panel. */
function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { slug, laneId } = props.params;
  // props.api.id is the dockview panel id (term-initial, term-<rand>, …)
  // and is stable across React unmount/remount, which is exactly what we
  // need for sessionStorage-keyed pty resume. Without this every panel
  // would key under 'default' and two terminals would clobber each
  // other's stored id.
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <PiPanel slug={slug} laneId={laneId} panelId={props.api.id} />
    </div>
  );
}

/** Component for chat panels in the dock. */
function ChatPanelComponent(props: IDockviewPanelProps<ChatPanelParams>) {
  const { slug, chatId } = props.params;
  const onArchive = useCallback(() => {
    // The dock keeps a reference to its api via closure on `props.api` —
    // remove this panel.
    props.api.close();
  }, [props.api]);
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <ChatPanel slug={slug} chatId={chatId} onArchive={onArchive} />
    </div>
  );
}

/** Header action: "+" to add another terminal as a new tab. */
function AddTerminalAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  const onClick = useCallback(() => {
    if (!api) return;
    // Fire prewarm BEFORE addPanel so the slot is reserved by the time
    // the new PiPanel's /pty/spawn POST arrives — otherwise spawn races
    // prewarm and cold-forks. Best-effort; failure falls through to
    // normal cold spawn.
    fetch(`/api/harness/${encodeURIComponent(slug)}/pty/prewarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => { /* best-effort */ });
    const id = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = api.panels.filter((p) => p.id.startsWith('term-')).length;
    api.addPanel({
      id,
      component: 'terminal',
      title: `terminal ${existing + 1}`,
      params: { slug } satisfies TerminalPanelParams,
    });
  }, [api, slug]);

  return (
    <Tooltip label="Open another terminal">
      <button
        type="button"
        onClick={onClick}
        className="pi-dock__add-btn"
      >
        <Plus size={13} />
        <span>terminal</span>
      </button>
    </Tooltip>
  );
}


export default function PiTerminalsDock({ slug, initialLaneId }: PiTerminalsDockProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {

      apiRef.current = event.api;
      setApi(event.api);

      // Try to restore a saved layout; on any failure, seed a single terminal.
      let restored = false;
      try {
        const raw = window.localStorage.getItem(layoutKey(slug));
        if (raw) {
          const parsed = JSON.parse(raw);
          event.api.fromJSON(parsed);
          restored = event.api.panels.length > 0;
        }
      } catch {
        restored = false;
      }

      // If the user is opening a chat from the dashboard, don't also
      // seed an initial terminal — they came here for the chat. Only
      // seed when the dock is opened cold (no saved layout, no queued
      // chats waiting).
      const hasPendingForThisSlug = pendingOpens.some((d) => d.slug === slug);
      if (!restored && !hasPendingForThisSlug) {
        event.api.addPanel({
          id: `term-initial`,
          component: 'terminal',
          title: 'terminal 1',
          params: { slug, laneId: initialLaneId } satisfies TerminalPanelParams,
        });
      }

      // Persist layout on every change. CRITICAL: registered BEFORE
      // drainPendingOpens so that any chat panels added by the drain
      // are persisted to localStorage. Otherwise React StrictMode's
      // double-mount in dev silently loses chat panels: round 1 drains
      // the queue and adds the panel but persist isn't wired yet, so
      // localStorage stays stale; round 2 restores from stale storage
      // and finds the queue already drained.
      const persist = () => {
        try {
          window.localStorage.setItem(layoutKey(slug), JSON.stringify(event.api.toJSON()));
        } catch { /* quota / private mode — ignore */ }
      };
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);

      // Race fix: drain any pending chat opens that arrived before this
      // mount. Without this, clicking "chat" on the dashboard tab silently
      // drops the event because the dock isn't mounted yet — the user sees
      // only the terminal restored from saved layout.
      // Drain any chat-open request stashed by the Oracle dock before
      // navigation. Survives the route change because it lives in
      // sessionStorage, not module memory.
      try {
        const raw = sessionStorage.getItem('oracle_pending_open_chat');
        if (raw) {
          const detail = JSON.parse(raw) as Partial<OpenChatEventDetail> & { slug?: string; chatId?: string };
          if (detail?.slug === slug && detail.chatId) {
            pendingOpens.push({
              slug: detail.slug,
              chatId: detail.chatId,
              role: detail.role,
              title: detail.title,
              featureId: detail.featureId,
            });
          }
          sessionStorage.removeItem('oracle_pending_open_chat');
        }
      } catch { /* ignore */ }

      drainPendingOpens(event.api, slug);

      // Async cleanup: remove chat panels for chats that no longer exist
      // (deleted, archived, expired). Runs after drain so we don't race
      // against new additions. Best-effort — fetches the live chat list
      // and closes panels whose chatId isn't in it.
      void pruneStaleChatPanels(event.api, slug);
    },
    [slug, initialLaneId],
  );

  // Reset stored layout when the harness slug changes (defensive — DockviewReact
  // remounts on key change so this is mostly belt-and-braces).
  useEffect(() => {
    return () => {
      apiRef.current = null;
    };
  }, [slug]);

  // Prewarm a pty as soon as the dock mounts. The server reserves it under
  // <slug>|<laneId>|<command> for ~60s; PiPanel's /pty/spawn POST adopts
  // it instead of forking fresh, eliminating omp's startup from the
  // user-visible critical path. Fire-and-forget; failures (slug missing,
  // pty cap reached) are surfaced when /spawn falls through to a real
  // spawn.
  useEffect(() => {
    fetch(`/api/harness/${encodeURIComponent(slug)}/pty/prewarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ laneId: initialLaneId }),
    }).catch(() => { /* best-effort */ });
  }, [slug, initialLaneId]);

  // Listen for cross-component "open chat" events. The dispatcher
  // (openFeatureChat) has already created the chat row AND pushed the
  // detail onto pendingOpens. If the dock is mounted, this handler
  // drains the queue immediately. If the dock isn't mounted yet (because
  // the dashboard tab is still active), the event is dropped — but the
  // queue entry remains, and onReady drains it when the dock mounts.
  useEffect(() => {
    const handler = () => {
      const a = apiRef.current;
      if (!a) return;
      drainPendingOpens(a, slug);
    };
    window.addEventListener(OPEN_CHAT_EVENT, handler);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, handler);
  }, [slug]);

  return (
    <div className="pi-dock">
      <div className="pi-dock__header">
        <span className="pi-dock__title">
          <TerminalSquare size={13} /> consoles
        </span>
        <AddTerminalAction api={api} slug={slug} />
        {/* Agent chat now lives in the floating Oracle dock (tab + picker).
            Use the chat bubble's "+" to start a new agent chat. */}
      </div>
      <div className="pi-dock__body">
        <DockviewReact
          key={slug}
          components={{ terminal: TerminalPanelComponent, chat: ChatPanelComponent }}
          onReady={onReady}
          className="dockview-theme-dark"
        />
      </div>
    </div>
  );
}

/**
 * Helper for callers (FeaturePeekPanel) to create a chat scoped to a
 * feature and open it in the dock. Returns the new chat id so the caller
 * can persist UI state if desired.
 */
export async function openFeatureChat(opts: {
  slug: string;
  role: string;
  featureId: string;
  title?: string;
}): Promise<{ chatId: string } | { error: string }> {
  try {
    const r = await fetch(`/api/harness/${encodeURIComponent(opts.slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: opts.role,
        feature_id: opts.featureId,
        title: opts.title,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      return { error: body.error ?? `HTTP ${r.status}` };
    }
    const chat = await r.json();
    const detail: OpenChatEventDetail = {
      slug: opts.slug,
      chatId: chat.id,
      title: chat.title,
      role: chat.role,
      featureId: chat.feature_id ?? undefined,
    };
    // Push to queue first so the dock can drain it on mount even if no
    // listener exists yet (dashboard tab is currently active). The
    // event dispatch handles the case where the dock IS already mounted.
    pendingOpens.push(detail);
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
