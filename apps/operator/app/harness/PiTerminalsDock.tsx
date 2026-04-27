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
import { MessageSquarePlus, Plus, TerminalSquare } from 'lucide-react';
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
 */
export interface OpenChatEventDetail {
  slug: string;
  chatId: string;
  title?: string;
  role?: string;
  featureId?: string;
}
export const OPEN_CHAT_EVENT = 'papercusp:open-chat';

/** Component rendered inside each dockview panel. */
function TerminalPanelComponent(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { slug, laneId } = props.params;
  return (
    <div style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex' }}>
      <PiPanel slug={slug} laneId={laneId} />
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

const VALID_CHAT_ROLES = [
  'worker', 'validator', 'scoper', 'reviewer', 'architect',
  'orchestrator', 'documenter', 'summarizer', 'curator', 'debugger',
] as const;

/** Header action: "+" to start a new ad-hoc chat from the dock. */
function AddChatAction({ api, slug }: { api: DockviewApi | null; slug: string }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string>('worker');
  const [featureId, setFeatureId] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async () => {
    if (!api) return;
    setCreating(true);
    setError(null);
    try {
      const fid = featureId.trim();
      if (fid && !/^F-[A-Z0-9-]+$/i.test(fid)) {
        setError(`Invalid feature id (expected F-XXX): ${fid}`);
        setCreating(false);
        return;
      }
      const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, feature_id: fid || undefined }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `HTTP ${r.status}`);
        setCreating(false);
        return;
      }
      const chat = await r.json();
      const title = chat.title ?? (fid ? `${role} · ${fid}` : role);
      api.addPanel({
        id: `chat-${chat.id}`,
        component: 'chat',
        title,
        params: { slug, chatId: chat.id } satisfies ChatPanelParams,
      });
      setOpen(false);
      setFeatureId('');
      setRole('worker');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [api, slug, role, featureId]);

  return (
    <div style={{ position: 'relative' }}>
      <Tooltip label="Start a new chat with an agent">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="pi-dock__add-btn"
        >
          <MessageSquarePlus size={13} />
          <span>chat</span>
        </button>
      </Tooltip>
      {open && (
        <div className="pi-dock__chat-popover" role="dialog" aria-label="New chat">
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
            <span>role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{
                background: '#0a0a0a', color: '#e7e7e7',
                border: '1px solid #2a2a2a', borderRadius: 4,
                padding: '4px 6px', fontSize: 12,
              }}
            >
              {VALID_CHAT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
            <span>feature (optional)</span>
            <input
              value={featureId}
              onChange={(e) => setFeatureId(e.target.value)}
              placeholder="F-001"
              style={{
                background: '#0a0a0a', color: '#e7e7e7',
                border: '1px solid #2a2a2a', borderRadius: 4,
                padding: '4px 6px', fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !creating) void create(); }}
            />
          </label>
          {error && (
            <div style={{ color: '#fca5a5', fontSize: 11 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={creating}
              style={{
                padding: '4px 10px', fontSize: 11,
                background: 'transparent', color: '#888',
                border: '1px solid #2a2a2a', borderRadius: 4,
                cursor: 'pointer',
              }}
            >cancel</button>
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating}
              style={{
                padding: '4px 10px', fontSize: 11,
                background: '#1d2533', color: '#6ea8ff',
                border: '1px solid #3a5070', borderRadius: 4,
                cursor: creating ? 'wait' : 'pointer',
              }}
            >{creating ? 'creating…' : 'create'}</button>
          </div>
        </div>
      )}
    </div>
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

      if (!restored) {
        event.api.addPanel({
          id: `term-initial`,
          component: 'terminal',
          title: 'terminal 1',
          params: { slug, laneId: initialLaneId } satisfies TerminalPanelParams,
        });
      }

      // Persist layout on every change.
      const persist = () => {
        try {
          window.localStorage.setItem(layoutKey(slug), JSON.stringify(event.api.toJSON()));
        } catch { /* quota / private mode — ignore */ }
      };
      event.api.onDidLayoutChange(persist);
      event.api.onDidAddPanel(persist);
      event.api.onDidRemovePanel(persist);
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

  // Listen for cross-component "open chat" events (dispatched by
  // FeaturePeekPanel when the user clicks "chat" on a feature). The
  // chat row has already been created by the dispatcher; we just add
  // it to the dock and activate.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenChatEventDetail>).detail;
      if (!detail || detail.slug !== slug) return;
      const a = apiRef.current;
      if (!a) return;
      const panelId = `chat-${detail.chatId}`;
      const existing = a.panels.find((p) => p.id === panelId);
      if (existing) {
        a.setActivePanel({ id: panelId } as { id: string });
        return;
      }
      a.addPanel({
        id: panelId,
        component: 'chat',
        title: detail.title ?? (detail.featureId ? `${detail.role ?? 'agent'} · ${detail.featureId}` : (detail.role ?? 'chat')),
        params: { slug: detail.slug, chatId: detail.chatId } satisfies ChatPanelParams,
      });
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
        <AddChatAction api={api} slug={slug} />
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
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    return { chatId: chat.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
