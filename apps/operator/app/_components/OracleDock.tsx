'use client';

/**
 * Always-mounted Oracle assistant dock.
 *
 * - Floating mascot button bottom-right of every page.
 * - Multi-tab: each tab is a chat with the Oracle or with one of the
 *   agent roles in the current harness. "+" opens a picker; tabs run
 *   their fetches independently so you can have several conversations
 *   in flight at once.
 * - Streams SSE from /api/oracle/chat (Oracle) or
 *   /api/harness/<slug>/agent-chats/<chatId>/messages (agents).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

interface ToolCallEntry {
  kind: 'tool';
  name: string;
  input?: unknown;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return String(input);
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s && s.length > 40) s = s.slice(0, 37) + '…';
    return `${k}: ${s}`;
  });
  return parts.join(', ');
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCallEntry[];
}

const WELCOME: Message = {
  role: 'assistant',
  content:
    "Hi, I'm the Oracle. I know how everything in Papercusp works, and I can help you get things done across the app. Configure my prompt and memory in Settings → Oracle to make me yours.",
};

const TABS_KEY = 'oracle_tabs_v1';
const ACTIVE_KEY = 'oracle_active_tab_v1';
const LEGACY_HISTORY_KEY = 'oracle_history_v1';
const SEEN_KEY = 'oracle_seen_v1';
const TUTORIAL_DONE_KEY = 'papercusp_tutorial_done_v1';
const TUTORIAL_ACTIVE_KEY = 'oracle_tutorial_active_v1';
const TUTORIAL_KICKOFF = 'Start the tutorial.';

// Mirrors the role list from PiTerminalsDock so the Oracle dock can
// fully replace that surface for ad-hoc agent chat.
const AGENT_ROLES = [
  'worker', 'validator', 'scoper', 'plan-gate', 'architect',
  'orchestrator', 'documenter', 'summarizer', 'curator', 'debugger',
  'project_manager',
] as const;
type AgentRole = typeof AGENT_ROLES[number];

type ChatTarget =
  | { kind: 'oracle' }
  | { kind: 'support' }
  | { kind: 'agent'; slug: string; role: AgentRole };

interface ChatTab {
  id: string;
  target: ChatTarget;
  messages: Message[];
}

const ORACLE_TARGET: ChatTarget = { kind: 'oracle' };
const SUPPORT_TARGET: ChatTarget = { kind: 'support' };

// Chatwoot widget URL — same as the SDK iframe target. Mirrors the
// defaults in ChatwootWidget.tsx; override via env at deploy time.
const CHATWOOT_BASE_URL =
  process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? 'https://chat.papercupai.com';
const CHATWOOT_WEBSITE_TOKEN =
  process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN ?? 'CT5CTToo11YtPN3CVkhvbFs9';

function targetLabel(t: ChatTarget): string {
  if (t.kind === 'oracle') return 'Oracle';
  if (t.kind === 'support') return 'Support';
  return t.role;
}

// Title shown in the tab strip. Agents from a different harness than the
// current page get prefixed with the harness slug so users can tell which
// crew they're talking to. Same-role tabs within one harness still get
// disambiguated by a short slug suffix.
function tabTitle(t: ChatTarget, allTabs: ChatTab[], currentSlug: string | null): string {
  if (t.kind === 'oracle') return 'Oracle';
  if (t.kind === 'support') return 'Support';
  if (t.slug !== currentSlug) return `${t.slug}/${t.role}`;
  const sameRole = allTabs.filter((x) => x.target.kind === 'agent' && x.target.role === t.role);
  if (sameRole.length <= 1) return t.role;
  return `${t.role}·${t.slug.slice(0, 6)}`;
}

function newId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Per-(slug, role) chatId cache so the dock reuses the same agent-chat
// conversation across messages instead of spinning up a fresh one each
// turn. If the chat is gone server-side, send() recreates on 404.
function chatIdKeyFor(slug: string, role: AgentRole): string {
  return `oracle_dock_chat:${slug}:${role}`;
}

function readChatId(slug: string, role: AgentRole): string | null {
  try { return sessionStorage.getItem(chatIdKeyFor(slug, role)); } catch { return null; }
}
function writeChatId(slug: string, role: AgentRole, id: string) {
  try { sessionStorage.setItem(chatIdKeyFor(slug, role), id); } catch { /* ignore */ }
}
function clearChatId(slug: string, role: AgentRole) {
  try { sessionStorage.removeItem(chatIdKeyFor(slug, role)); } catch { /* ignore */ }
}

// Derive the harness slug from the URL — "+" only exposes agent
// targets when the user is on a route that's scoped to a harness.
// Operator uses three patterns: path-based (/harness/<slug>/...),
// query-based (?harness=<slug> on the /pi route, ?slug=<slug> elsewhere),
// and the dashboard combobox which only writes to localStorage.
function slugFromUrl(pathname: string | null, query: URLSearchParams | null): string | null {
  if (pathname) {
    const m = pathname.match(/^\/harness\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  if (query) {
    const q = query.get('harness') ?? query.get('slug');
    if (q) return q;
  }
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem('harness.activeProject') : null;
    if (v) return v;
  } catch { /* ignore */ }
  return null;
}

// Test/smoke harnesses fill the registry; hide them from the picker so
// the user only sees real ones. Tweak the patterns here when more
// fixture-name conventions land.
const TEST_HARNESS_PATTERNS = [
  /^smoke[-_]/i,
  /^v1[_-](test|e2e|final|fork)/i,
  /^bclp[-_]/i,
  /[-_]fork[-_]/i,
  /^r30[-_]?test$/i,
  /^test$/i,
];
function isTestHarness(slug: string): boolean {
  return TEST_HARNESS_PATTERNS.some((re) => re.test(slug));
}

function defaultOracleTab(): ChatTab {
  return { id: newId(), target: ORACLE_TARGET, messages: [WELCOME] };
}

export function OracleDock() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [supportEverOpened, setSupportEverOpened] = useState(false);
  const [pickerHarnesses, setPickerHarnesses] = useState<{ slug: string; harness_kind?: string }[] | null>(null);
  const [pickerFocusSlug, setPickerFocusSlug] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [input, setInput] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({});
  const [tutorialActive, setTutorialActiveState] = useState(false);
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  const endRef = useRef<HTMLDivElement>(null);

  // Re-evaluated on URL changes; also refreshed when the picker opens
  // so the localStorage-backed dashboard combobox selection is picked up.
  const [activeHarnessSlug, setActiveHarnessSlug] = useState<string | null>(null);
  useEffect(() => {
    setActiveHarnessSlug(slugFromUrl(pathname, searchParams));
  }, [pathname, searchParams]);
  const harnessSlug = activeHarnessSlug;

  // Lazy-load harness list the first time the picker opens. Cached for
  // the dock's lifetime; reopening the picker is instant after that.
  useEffect(() => {
    if (!pickerOpen || pickerHarnesses !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/harness/projects', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d: any = await r.json();
        const list = Array.isArray(d?.projects)
          ? (d.projects as any[]).map((p) => ({ slug: String(p.slug), harness_kind: p.harness_kind }))
          : [];
        if (!cancelled) setPickerHarnesses(list);
      } catch {
        if (!cancelled) setPickerHarnesses([]);
      }
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, pickerHarnesses]);

  // When the picker opens, refresh the active harness from URL +
  // localStorage and auto-expand it in the list.
  useEffect(() => {
    if (pickerOpen) {
      const fresh = slugFromUrl(pathname, searchParams);
      setActiveHarnessSlug(fresh);
      setPickerFocusSlug(fresh ?? null);
      setPickerSearch('');
    }
  }, [pickerOpen, pathname, searchParams]);

  // Dismiss the picker on outside click. We attach to mousedown so closing
  // wins the race against any stray click bubbling into the picker itself.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.oracle-picker') || target.closest('.oracle-tab-add')) return;
      setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const setTutorialActive = (v: boolean) => {
    setTutorialActiveState(v);
    if (typeof window === 'undefined') return;
    try {
      if (v) sessionStorage.setItem(TUTORIAL_ACTIVE_KEY, '1');
      else sessionStorage.removeItem(TUTORIAL_ACTIVE_KEY);
    } catch { /* ignore */ }
  };

  // First mount: restore tabs (or migrate from legacy single-history key).
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (sessionStorage.getItem(TUTORIAL_ACTIVE_KEY) === '1') {
      setTutorialActiveState(true);
      setOpen(true);
    }

    let restored: ChatTab[] | null = null;
    try {
      const raw = sessionStorage.getItem(TABS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((t) => t && typeof t.id === 'string' && t.target && Array.isArray(t.messages))) {
          restored = parsed as ChatTab[];
        }
      }
    } catch { /* corrupt — fall through */ }

    if (!restored) {
      // Legacy: migrate single-history Oracle thread into a single tab.
      try {
        const legacy = sessionStorage.getItem(LEGACY_HISTORY_KEY);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          if (Array.isArray(parsed) && parsed.length) {
            restored = [{ id: newId(), target: ORACLE_TARGET, messages: parsed }];
          }
        }
      } catch { /* ignore */ }
    }

    if (!restored || restored.length === 0) {
      restored = [defaultOracleTab()];
    }
    setTabs(restored);
    const savedActive = sessionStorage.getItem(ACTIVE_KEY);
    setActiveId(savedActive && restored.some((t) => t.id === savedActive) ? savedActive : restored[0].id);

    const firstRun = !localStorage.getItem(SEEN_KEY);
    const tutorialDone = !!localStorage.getItem(TUTORIAL_DONE_KEY);
    if (firstRun) {
      setOpen(true);
      localStorage.setItem(SEEN_KEY, '1');
      if (!tutorialDone) {
        setTimeout(() => startTutorial(), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist tabs + active id.
  useEffect(() => {
    if (typeof window === 'undefined' || tabs.length === 0) return;
    try { sessionStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* quota */ }
  }, [tabs]);
  useEffect(() => {
    if (typeof window === 'undefined' || !activeId) return;
    try { sessionStorage.setItem(ACTIVE_KEY, activeId); } catch { /* quota */ }
  }, [activeId]);

  // External tutorial trigger.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => startTutorial();
    window.addEventListener('oracle:start-tutorial', handler);
    return () => window.removeEventListener('oracle:start-tutorial', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll the active tab on new content.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [tabs, activeId, open]);

  // Clear unread when activating a tab or opening the dock.
  useEffect(() => {
    if (!open || !activeId) return;
    setUnreadMap((m) => (m[activeId] ? { ...m, [activeId]: false } : m));
  }, [open, activeId]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const updateTab = useCallback((tabId: string, fn: (t: ChatTab) => ChatTab) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? fn(t) : t)));
  }, []);

  const setBusy = (tabId: string, v: boolean) => {
    setBusyMap((m) => ({ ...m, [tabId]: v }));
  };

  const setError = (tabId: string, err: string | null) => {
    setErrors((m) => {
      const next = { ...m };
      if (err) next[tabId] = err; else delete next[tabId];
      return next;
    });
  };

  const startTutorial = () => {
    setOpen(true);
    setInput('');
    setTutorialActive(true);
    if (typeof window !== 'undefined') {
      try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch { /* ignore */ }
    }
    setTabs((prev) => {
      const oracleTab = prev.find((t) => t.target.kind === 'oracle');
      if (oracleTab) {
        const cleared = { ...oracleTab, messages: [] };
        const others = prev.filter((t) => t.id !== oracleTab.id);
        setActiveId(oracleTab.id);
        const next = [cleared, ...others];
        setTimeout(() => { void send(oracleTab.id, TUTORIAL_KICKOFF, { tutorialMode: true, baseMessages: [] }); }, 0);
        return next;
      }
      const fresh: ChatTab = { id: newId(), target: ORACLE_TARGET, messages: [] };
      setActiveId(fresh.id);
      setTimeout(() => { void send(fresh.id, TUTORIAL_KICKOFF, { tutorialMode: true, baseMessages: [] }); }, 0);
      return [fresh, ...prev];
    });
  };

  const newOracleChat = () => {
    if (!activeTab) return;
    if (activeTab.target.kind === 'oracle') {
      updateTab(activeTab.id, (t) => ({ ...t, messages: [WELCOME] }));
      setError(activeTab.id, null);
      setTutorialActive(false);
      return;
    }
    // For agent tabs, "+ new chat" creates a fresh server-side agent chat
    // by clearing the cached chatId; next send() will POST a new one.
    if (activeTab.target.kind === 'agent') {
      clearChatId(activeTab.target.slug, activeTab.target.role);
      updateTab(activeTab.id, (t) => ({ ...t, messages: [] }));
      setError(activeTab.id, null);
    }
  };

  const closeTab = (tabId: string) => {
    const ctrl = inFlightRef.current.get(tabId);
    if (ctrl) { ctrl.abort(); inFlightRef.current.delete(tabId); }
    setBusyMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
    setUnreadMap((m) => { const n = { ...m }; delete n[tabId]; return n; });
    setErrors((m) => { const n = { ...m }; delete n[tabId]; return n; });
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        const fresh = defaultOracleTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (tabId === activeId) {
        setActiveId(next[0].id);
      }
      return next;
    });
  };

  const openTab = useCallback((target: ChatTarget) => {
    setPickerOpen(false);
    setTabs((prev) => {
      // Coalesce: if a tab for this exact target already exists, just activate it.
      const existing = prev.find((t) =>
        t.target.kind === target.kind &&
        (target.kind === 'oracle' || target.kind === 'support' ||
          (t.target.kind === 'agent' && t.target.slug === target.slug && t.target.role === target.role))
      );
      if (existing) { setActiveId(existing.id); return prev; }
      const fresh: ChatTab = {
        id: newId(),
        target,
        messages: target.kind === 'oracle' ? [WELCOME] : [],
      };
      setActiveId(fresh.id);
      return [...prev, fresh];
    });
  }, []);

  // Resolve (creating if necessary) the agent-chat id for an agent tab.
  const ensureAgentChatId = async (slug: string, role: AgentRole): Promise<string> => {
    const cached = readChatId(slug, role);
    if (cached) return cached;
    const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/agent-chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(body.error ?? `failed to create chat (HTTP ${r.status})`);
    }
    const chat = await r.json();
    if (!chat?.id) throw new Error('agent-chats response missing id');
    writeChatId(slug, role, chat.id);
    return chat.id;
  };

  const send = async (
    tabId: string,
    override?: string,
    opts?: { tutorialMode?: boolean; baseMessages?: Message[] },
  ) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (busyMap[tabId]) return;
    const text = (override ?? input).trim();
    if (!text) return;
    if (override === undefined) setInput('');
    setError(tabId, null);

    const base = opts?.baseMessages ?? tab.messages;
    const next: Message[] = [
      ...base.filter((m) => m !== WELCOME),
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ];
    updateTab(tabId, (t) => ({ ...t, messages: next }));
    setBusy(tabId, true);

    const ctrl = new AbortController();
    inFlightRef.current.set(tabId, ctrl);

    const appendDelta = (delta: string) => {
      setTabs((prev) => prev.map((t) => {
        if (t.id !== tabId) return t;
        const copy = [...t.messages];
        const last = copy[copy.length - 1];
        copy[copy.length - 1] = { ...last, role: 'assistant', content: last.content + delta };
        return { ...t, messages: copy };
      }));
      // Mark unread if user is looking at a different tab.
      setUnreadMap((m) => (tabId !== activeId && !m[tabId] ? { ...m, [tabId]: true } : m));
    };

    const appendTool = (name: string, input?: unknown) => {
      setTabs((prev) => prev.map((t) => {
        if (t.id !== tabId) return t;
        const copy = [...t.messages];
        const last = copy[copy.length - 1];
        const tools = [...(last.tools ?? []), { kind: 'tool' as const, name, input }];
        copy[copy.length - 1] = { ...last, role: 'assistant', tools };
        return { ...t, messages: copy };
      }));
    };

    try {
      let res: Response;
      if (tab.target.kind === 'oracle') {
        res = await fetch('/api/oracle/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: next.slice(0, -1).filter((m) => m.role !== 'assistant' || m.content),
            currentPath: typeof window !== 'undefined' ? window.location.pathname : '',
            tutorialMode: opts?.tutorialMode ?? tutorialActive,
          }),
          signal: ctrl.signal,
        });
      } else if (tab.target.kind === 'agent') {
        const { slug, role } = tab.target;
        let chatId: string;
        try {
          chatId = await ensureAgentChatId(slug, role);
        } catch (e: any) {
          setError(tabId, e?.message ?? 'failed to create agent chat');
          return;
        }
        res = await fetch(
          `/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: text }),
            signal: ctrl.signal,
          },
        );
        // 404 — server-side chat was deleted; clear cache and retry once.
        if (res.status === 404) {
          clearChatId(slug, role);
          try {
            chatId = await ensureAgentChatId(slug, role);
            res = await fetch(
              `/api/harness/${encodeURIComponent(slug)}/agent-chats/${encodeURIComponent(chatId)}/messages`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: text }),
                signal: ctrl.signal,
              },
            );
          } catch (e: any) {
            setError(tabId, e?.message ?? 'failed to recreate agent chat');
            return;
          }
        }
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        setError(tabId, errText);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventMatch = frame.match(/^event:\s*(.+)$/m);
          const dataMatch = frame.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1].trim();
          let data: any;
          try { data = JSON.parse(dataMatch[1]); } catch { data = dataMatch[1]; }

          if (event === 'delta' && typeof data?.text === 'string') {
            appendDelta(data.text);
          } else if (event === 'tool_call' && typeof data?.name === 'string') {
            appendTool(data.name, data.input);
          } else if (event === 'ui_command' && tab.target.kind === 'oracle') {
            if (data?.type === 'navigate' && typeof data.path === 'string') {
              router.push(data.path);
            } else if (data?.type === 'openChat' && typeof data.slug === 'string' && typeof data.role === 'string') {
              // Oracle's openChat now opens a tab in the dock instead of
              // routing to /harness/<slug>?panel=pi.
              const role = data.role as AgentRole;
              if ((AGENT_ROLES as readonly string[]).includes(role)) {
                openTab({ kind: 'agent', slug: data.slug, role });
                if (typeof data.chatId === 'string') {
                  // Pin the server's chosen chat as our cached chat for this
                  // (slug, role) so subsequent sends reuse it.
                  writeChatId(data.slug, role, data.chatId);
                }
              }
            }
          } else if (event === 'tutorial_end') {
            setTutorialActive(false);
          } else if (event === 'error') {
            setError(tabId, typeof data?.message === 'string' ? data.message : 'stream error');
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setError(tabId, e?.message ?? String(e));
      }
    } finally {
      inFlightRef.current.delete(tabId);
      setBusy(tabId, false);
    }
  };

  const supportActive = activeTab?.target.kind === 'support';

  // Lazy-mount the Chatwoot iframe the first time Support is shown, then
  // keep it mounted (display toggled) so the conversation isn't lost when
  // the user switches tabs.
  useEffect(() => {
    if (supportActive && !supportEverOpened) setSupportEverOpened(true);
  }, [supportActive, supportEverOpened]);

  // Mounted-marker + event bridge so SupportChatButton (and anything else
  // on the page) can pop open the Support tab without importing the dock.
  useEffect(() => {
    (window as unknown as { __papercuspDockMounted?: boolean }).__papercuspDockMounted = true;
    const onOpenSupport = () => {
      setOpen(true);
      openTab(SUPPORT_TARGET);
    };
    window.addEventListener('papercusp:open-support', onOpenSupport);
    return () => {
      window.removeEventListener('papercusp:open-support', onOpenSupport);
      (window as unknown as { __papercuspDockMounted?: boolean }).__papercuspDockMounted = false;
    };
  }, [openTab]);

  // ── Render ────────────────────────────────────────────────────────────
  if (tabs.length === 0) {
    // Pre-bootstrap; render only the FAB so we never flash an empty dock.
    return open ? null : (
      <button onClick={() => setOpen(true)} aria-label="Open Oracle assistant" className="oracle-fab">
        <img src="/mascot.svg" alt="" height={34} style={{ display: 'block' }} />
        <span>Ask Oracle</span>
      </button>
    );
  }

  const active = activeTab!;
  const activeBusy = !!busyMap[active.id];
  const activeError = errors[active.id];
  const lastMsg = active.messages[active.messages.length - 1];
  const showThinking = activeBusy && lastMsg && lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.tools?.length;
  const headerLabel = targetLabel(active.target);

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} aria-label="Open Oracle assistant" className="oracle-fab">
          <img src="/mascot.svg" alt="" height={34} style={{ display: 'block' }} />
          <span>Ask Oracle</span>
          {Object.values(unreadMap).some(Boolean) && <span className="oracle-fab-badge" aria-label="unread" />}
        </button>
      )}

      {open && (
        <div className="oracle-dock" role="dialog" aria-label="Oracle">
          <header className="oracle-dock-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <img src="/mascot.svg" alt="" height={24} style={{ display: 'block' }} />
              <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerLabel}</strong>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={newOracleChat} aria-label="Reset this chat" title="Reset this chat" className="oracle-link" style={{ background: 'transparent', border: 0, padding: '2px 6px', cursor: 'pointer', font: 'inherit' }}>↻</button>
              <Link href="/settings/oracle" className="oracle-link" title="Configure">⚙</Link>
              <button onClick={() => setOpen(false)} aria-label="Close" className="oracle-close">×</button>
            </div>
          </header>

          {/* Tab strip */}
          <div className="oracle-tabs" role="tablist">
            {tabs.map((t) => {
              const isActive = t.id === active.id;
              const tabBusy = !!busyMap[t.id];
              const unread = !!unreadMap[t.id];
              return (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={isActive}
                  className={`oracle-tab${isActive ? ' is-active' : ''}`}
                  onClick={() => setActiveId(t.id)}
                >
                  <span className="oracle-tab-label">{tabTitle(t.target, tabs, harnessSlug)}</span>
                  {tabBusy && <span className="oracle-tab-dot oracle-tab-dot-busy" aria-label="thinking" />}
                  {!tabBusy && unread && <span className="oracle-tab-dot oracle-tab-dot-unread" aria-label="unread" />}
                  <button
                    type="button"
                    className="oracle-tab-close"
                    aria-label={`Close ${targetLabel(t.target)}`}
                    title="Close"
                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  >×</button>
                </div>
              );
            })}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="oracle-tab-add"
                aria-label="New chat"
                title="New chat"
                onClick={() => setPickerOpen((v) => !v)}
              >＋</button>
              {pickerOpen && (() => {
                const allHarnesses = pickerHarnesses ?? [];
                const realHarnesses = allHarnesses.filter((h) => !isTestHarness(h.slug));
                const sortedHarnesses = [...realHarnesses].sort((a, b) => {
                  if (a.slug === harnessSlug) return -1;
                  if (b.slug === harnessSlug) return 1;
                  return a.slug.localeCompare(b.slug);
                });
                const q = pickerSearch.trim().toLowerCase();
                const expandedSlug = pickerFocusSlug ?? harnessSlug ?? null;
                // Search mode flattens to a single ranked list of matches.
                const flatMatches: ChatTarget[] = [];
                if (q) {
                  if ('oracle'.includes(q)) flatMatches.push(ORACLE_TARGET);
                  if ('support'.includes(q) || 'human'.includes(q) || 'help'.includes(q)) flatMatches.push(SUPPORT_TARGET);
                  for (const h of sortedHarnesses) {
                    for (const role of AGENT_ROLES) {
                      const hay = `${h.slug}/${role}`;
                      if (hay.toLowerCase().includes(q)) {
                        flatMatches.push({ kind: 'agent', slug: h.slug, role });
                      }
                    }
                  }
                }
                return (
                  <div className="oracle-picker oracle-picker-wide" role="menu">
                    <div className="oracle-picker-search">
                      <input
                        autoFocus
                        type="text"
                        value={pickerSearch}
                        onChange={(e) => setPickerSearch(e.target.value)}
                        placeholder="Search harness or role…"
                      />
                    </div>
                    {q ? (
                      <div className="oracle-picker-results">
                        {flatMatches.length === 0 && (
                          <div className="oracle-picker-section" style={{ opacity: 0.7 }}>No matches.</div>
                        )}
                        {flatMatches.map((t, i) => (
                          <button
                            key={i}
                            type="button"
                            className="oracle-picker-item"
                            onClick={() => openTab(t)}
                          >
                            {t.kind === 'oracle'
                              ? <><strong>Oracle</strong><span className="oracle-picker-hint">general help</span></>
                              : t.kind === 'support'
                                ? <><strong>Support</strong><span className="oracle-picker-hint">chat with a human</span></>
                                : <><strong>{t.role}</strong><span className="oracle-picker-hint">{t.slug}</span></>}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="oracle-picker-list">
                        <button
                          type="button"
                          className="oracle-picker-row"
                          onClick={() => openTab(ORACLE_TARGET)}
                        >
                          <strong>Oracle</strong>
                          <span className="oracle-picker-hint">general help</span>
                        </button>
                        <button
                          type="button"
                          className="oracle-picker-row"
                          onClick={() => openTab(SUPPORT_TARGET)}
                        >
                          <strong>Support</strong>
                          <span className="oracle-picker-hint">chat with a human</span>
                        </button>
                        <div className="oracle-picker-section">Harnesses</div>
                        {pickerHarnesses === null && (
                          <div className="oracle-picker-section" style={{ opacity: 0.7 }}>Loading…</div>
                        )}
                        {pickerHarnesses !== null && sortedHarnesses.length === 0 && (
                          <div className="oracle-picker-section" style={{ opacity: 0.7 }}>No harnesses.</div>
                        )}
                        {sortedHarnesses.map((h) => {
                          const isExpanded = h.slug === expandedSlug;
                          return (
                            <div key={h.slug} className={`oracle-picker-group${isExpanded ? ' is-expanded' : ''}`}>
                              <button
                                type="button"
                                className="oracle-picker-row oracle-picker-harness-row"
                                aria-expanded={isExpanded}
                                onClick={() => setPickerFocusSlug(isExpanded ? null : h.slug)}
                              >
                                <span className="oracle-picker-caret" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                                <strong>{h.slug}</strong>
                                {h.slug === harnessSlug && <span className="oracle-picker-hint">current</span>}
                              </button>
                              {isExpanded && (
                                <div className="oracle-picker-roles">
                                  {AGENT_ROLES.map((role) => (
                                    <button
                                      key={role}
                                      type="button"
                                      className="oracle-picker-row oracle-picker-role-row"
                                      onClick={() => openTab({ kind: 'agent', slug: h.slug, role })}
                                    >
                                      {role}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="oracle-body" style={supportActive ? { display: 'none' } : undefined}>
            {active.messages.length === 0 ? (
              <div style={{ color: 'var(--fg-mute)', fontSize: 13, padding: 16, textAlign: 'center' }}>
                {active.target.kind === 'oracle'
                  ? 'Ask me anything about Papercusp.'
                  : active.target.kind === 'support'
                    ? 'Connecting you to a human…'
                    : `Send a message to the ${active.target.role}.`}
              </div>
            ) : (
              active.messages.map((m, i) => (
                <div key={i} className={`oracle-msg oracle-msg-${m.role}`}>
                  <div className="oracle-msg-role">{m.role === 'user' ? 'You' : headerLabel}</div>
                  {m.tools?.map((t, ti) => {
                    const summary = summarizeToolInput(t.input);
                    return (
                      <div key={ti} className="oracle-tool-chip" title={summary}>
                        🔧 <strong>{t.name}</strong>
                        {summary && <span className="oracle-tool-args">({summary})</span>}
                      </div>
                    );
                  })}
                  {m.content && <div className="oracle-msg-content">{m.content}</div>}
                </div>
              ))
            )}
            {showThinking && (
              <div className="oracle-thinking-row" aria-live="polite">
                <span>{headerLabel} is thinking</span>
                <span className="oracle-thinking-dots"><span /><span /><span /></span>
              </div>
            )}
            {activeError && <div className="oracle-error">⚠ {activeError}</div>}
            <div ref={endRef} />
          </div>

          {/* Chatwoot widget rendered inline. Mounted lazily on first
              Support activation, then kept mounted so the conversation
              survives tab switches. The iframe handles its own input so
              we suppress the native dock form for this tab. */}
          {supportEverOpened && (
            <iframe
              className="oracle-chatwoot-frame"
              src={`${CHATWOOT_BASE_URL}/widget?website_token=${encodeURIComponent(CHATWOOT_WEBSITE_TOKEN)}`}
              title="Papercusp Support chat"
              style={supportActive ? undefined : { display: 'none' }}
              allow="clipboard-read; clipboard-write; microphone; camera"
            />
          )}
          {!supportActive && (
            <form className="oracle-form" onSubmit={(e) => { e.preventDefault(); void send(active.id); }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={activeBusy ? 'thinking…' : (active.target.kind === 'agent' ? `Message ${active.target.role}…` : 'Ask the Oracle…')}
                disabled={activeBusy}
              />
              <button type="submit" disabled={activeBusy || !input.trim()} className="pc-button">
                {activeBusy ? '…' : 'Send'}
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
