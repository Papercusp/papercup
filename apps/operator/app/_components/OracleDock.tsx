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
import { useSyncQuery } from '@papercusp/sync';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { animate, stagger } from 'motion';
import { useReducedMotion } from 'motion/react';
import { useFancyEffectsEnabled } from '@/lib/visual-effects';
import { Tooltip } from '../harness/Tooltip';
import RouteLink from './RouteLink';
import { HudFrameCorners, HudReticleGlyph } from './hud/HudPrimitives';
import { ChatConversation, type ChatIconComponent } from './chat/ChatConversation';
import { renderCard } from '@/lib/chat-cards';
import { OracleLogoMark } from './OracleLogoMark';
import {
  Activity,
  Bot,
  Bug,
  ChartNetwork,
  ClipboardCheck,
  ClipboardList,
  Compass,
  Crown,
  Eye,
  FileText,
  FlaskConical,
  Hammer,
  Library,
  LifeBuoy,
  Lock,
  Monitor,
  PencilRuler,
  Plus,
  RefreshCcw,
  ScanSearch,
  ScrollText,
  Settings2,
  SendHorizontal,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from '@/lib/router-compat/navigation';
import { getOrCreateClientId } from '@papercusp/operator-core/lib/ui/client-id';

// gsap intro-easing equivalent (power3.out ≈ quart-out).
const INTRO_EASE: [number, number, number, number] = [0.165, 0.84, 0.44, 1];

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

// Roles are fetched at runtime from /api/harness/:slug/prompts (which
// reads the global prompts dir). The hardcoded list this replaced kept
// drifting from disk; now there's nothing to drift from.
//
// Roles excluded from the picker (none currently — the former 'feedback' +
// 'expert' entries were removed with the experts feature).
const PICKER_ROLE_EXCLUDE = new Set<string>([]);
type AgentRole = string;
const FALLBACK_AGENT_ROLES: string[] = [
  'worker', 'validator', 'scoper', 'reviewer', 'architect',
  'orchestrator', 'documenter', 'summarizer', 'curator', 'debugger',
];

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

// Chatwoot support URL for the inline universal chat Support tab.
const CHATWOOT_BASE_URL =
  process.env.NEXT_PUBLIC_CHATWOOT_BASE_URL ?? 'https://chat.papercupai.com';
const CHATWOOT_WEBSITE_TOKEN =
  process.env.NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN ?? 'CT5CTToo11YtPN3CVkhvbFs9';
const CHATWOOT_WIDGET_SRC = `${CHATWOOT_BASE_URL}/widget?website_token=${encodeURIComponent(CHATWOOT_WEBSITE_TOKEN)}`;
const CHATWOOT_TARGET_ORIGIN = (() => {
  try { return new URL(CHATWOOT_BASE_URL).origin; } catch { return '*'; }
})();

function readCssToken(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

function chatwootFrameTheme() {
  const widgetColor = readCssToken('--accent');
  return {
    event: 'config-set',
    locale: 'en',
    position: 'right',
    hideMessageBubble: true,
    showPopoutButton: false,
    showUnreadMessagesDialog: false,
    widgetStyle: 'flat',
    darkMode: 'dark',
    ...(widgetColor ? { widgetColor } : {}),
    welcomeTitle: 'Papercusp Support',
    welcomeDescription: 'Chat with a human from Papercusp.',
    availableMessage: '',
    unavailableMessage: '',
    enableFileUpload: true,
    enableEmojiPicker: true,
    enableEndConversation: true,
  };
}
function postChatwootFrameMessage(frame: HTMLIFrameElement | null, message: Record<string, unknown>) {
  frame?.contentWindow?.postMessage(`chatwoot-widget:${JSON.stringify(message)}`, CHATWOOT_TARGET_ORIGIN);
}

function targetLabel(t: ChatTarget): string {
  if (t.kind === 'oracle') return 'Oracle';
  if (t.kind === 'support') return 'Support';
  return t.role;
}
function targetSubtitle(t: ChatTarget): string {
  if (t.kind === 'oracle') return 'general help across Papercusp';
  if (t.kind === 'support') return 'chat with a human from Papercusp';
  return roleHint(t.role);
}

const ROLE_HINTS: Record<AgentRole, string> = {
  worker: 'implement changes',
  validator: 'check correctness',
  scoper: 'break goals into concrete work',
  reviewer: 'review plans and proposals before execution',
  architect: 'shape design and tradeoffs',
  orchestrator: 'coordinate the mission',
  documenter: 'write docs and notes',
  summarizer: 'condense progress and context',
  curator: 'organize relevant context',
  debugger: 'investigate failures',
};

function roleLabel(role: AgentRole): string {
  return role
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function roleHint(role: AgentRole): string {
  return ROLE_HINTS[role] ?? 'Chat directly with this agent.';
}

const ROLE_ICONS: Record<string, ChatIconComponent> = {
  worker: Hammer,
  validator: ShieldCheck,
  scoper: Compass,
  reviewer: Eye,
  architect: PencilRuler,
  orchestrator: ChartNetwork,
  documenter: FileText,
  summarizer: ScrollText,
  curator: Library,
  debugger: Bug,
  auditor: ClipboardCheck,
  ceo: Crown,
  coordinator: Users,
  crosscheck: ScanSearch,
  director: Crown,
  monitor: Activity,
  'plan-gate': ClipboardList,
  'security-reviewer': ShieldAlert,
  'test-writer': FileText,
  tester: FlaskConical,
  'ui-qa': Monitor,
};
function normalizeRoleKey(role: AgentRole): string {
  return role.toLowerCase().replace(/[_\s]+/g, '-');
}
function roleIcon(role: AgentRole): ChatIconComponent {
  const normalized = normalizeRoleKey(role);
  if (normalized === 'support') return LifeBuoy;
  if (normalized === 'oracle') return OracleLogoMark;
  if (normalized === 'security-reviewer') return Lock;
  return ROLE_ICONS[normalized] ?? ROLE_ICONS[normalized.replace(/^chief-/, '')] ?? Bot;
}
function targetIcon(t: ChatTarget): ChatIconComponent {
  if (t.kind === 'oracle') return OracleLogoMark;
  if (t.kind === 'support') return LifeBuoy;
  return roleIcon(t.role);
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
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(wsLocalKey('harness.activeProject')) : null;
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
  const reducedMotion = useReducedMotion() ?? false;
  const visualEffectsEnabled = useFancyEffectsEnabled();
  const fancyEffectsEnabled = visualEffectsEnabled && !reducedMotion;
  // URL-backed so agents can read dock state via ui:get_state and
  // open/close it via set_url.
  const [open, setOpen] = useQueryState('oracle', parseAsBoolean.withDefault(false));
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeId, setActiveId] = useQueryState('oracleId', parseAsString.withDefault(''));
  const [pickerOpen, setPickerOpen] = useQueryState('oraclePicker', parseAsBoolean.withDefault(false));
  const [supportEverOpened, setSupportEverOpened] = useState(false);
  const [agentRoles, setAgentRoles] = useState<string[]>(FALLBACK_AGENT_ROLES);
  const [pickerFocusSlug, setPickerFocusSlug] = useState<string | null>(null);
  const [pickerFocusRole, setPickerFocusRole] = useState<string | null>(null);
  const [pickerMenuOpen, setPickerMenuOpen] = useState<'harness' | 'agent' | null>(null);
  const [input, setInput] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [unreadMap, setUnreadMap] = useState<Record<string, boolean>>({});
  const [tutorialActive, setTutorialActiveState] = useState(false);
  const [chatwootFrameSrc, setChatwootFrameSrc] = useState(CHATWOOT_WIDGET_SRC);
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  // Holds the latest `send` so the tutorial-kickoff setTimeout can call
  // through a fresh closure (see startTutorial). Updated each render.
  const sendRef = useRef<(tabId: string, override?: string, opts?: { tutorialMode?: boolean; baseMessages?: Message[] }) => Promise<void>>(
    async () => {},
  );
  // Mirror of `tabs` so deferred callers (setTimeout from inside a state
  // reducer) read the post-commit list rather than the stale closure.
  const tabsRef = useRef<ChatTab[]>([]);
  // endRef removed — auto-scroll is now owned by ChatConversation's
  // internal endRef, triggered on messages.length and busy changes.
  // Tab-switch scrolling is preserved via `key={active.id}` so the
  // shared component remounts and auto-scrolls on activation.
  const chatwootFrameRef = useRef<HTMLIFrameElement>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  // Tracks the last path Oracle navigated the user to during a tutorial,
  // so we can detect when the user has manually moved elsewhere and
  // suppress further auto-navigation. See the navigate handler below.
  const lastExpectedPathRef = useRef<string>(typeof window !== 'undefined' ? window.location.pathname : '');

  // Re-evaluated on URL changes; also refreshed when the picker opens
  // so the localStorage-backed dashboard combobox selection is picked up.
  const [activeHarnessSlug, setActiveHarnessSlug] = useState<string | null>(null);
  useEffect(() => {
    setActiveHarnessSlug(slugFromUrl(pathname, searchParams));
  }, [pathname, searchParams]);
  const harnessSlug = activeHarnessSlug;

  // LIVE harness registry for the "+" picker (harnessProjects.lite). Replaces
  // the old lazy one-shot /api/harness/projects/lite fetch (data-sync-push-
  // completion P-010): the resolver is invalidated from the registry write seam,
  // so creates / deletes / renames / forks from ANY operator process live-update
  // the picker (EI-206). The resolver row is the same ProjectsLiteEntry shape the
  // REST endpoint put under `d.projects`, so we read slug + harness_kind off the
  // row with no field renaming. `data === undefined` is the unresolved/loading
  // state the picker previously modeled with `pickerHarnesses === null`.
  const pickerHarnessesQuery = useSyncQuery<{ slug: string; harness_kind?: string | null }>({
    queryName: 'harnessProjects.lite',
    args: {},
    staleTime: 60_000,
  });
  const pickerHarnesses = useMemo<{ slug: string; harness_kind?: string }[] | null>(() => {
    if (pickerHarnessesQuery.data === undefined) return null;
    return (pickerHarnessesQuery.data ?? []).map((p) => ({
      slug: String(p.slug),
      harness_kind: p.harness_kind ?? undefined,
    }));
  }, [pickerHarnessesQuery.data]);

  // Lazy-load the agent role list when the picker opens. Falls back
  // silently to FALLBACK_AGENT_ROLES on error so the picker stays usable.
  useEffect(() => {
    if (!pickerOpen) return;
    const slug = activeHarnessSlug;
    if (!slug) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/harness/${encodeURIComponent(slug)}/prompts`, { cache: 'no-store' });
        if (!r.ok) return;
        const d: any = await r.json();
        const all: unknown = d?.roles;
        if (!Array.isArray(all)) return;
        const filtered = (all as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .filter((r) => !PICKER_ROLE_EXCLUDE.has(r));
        if (!cancelled && filtered.length > 0) setAgentRoles(filtered);
      } catch { /* keep fallback */ }
    })();
    return () => { cancelled = true; };
  }, [pickerOpen, activeHarnessSlug]);

  // When the picker opens, refresh the active harness from URL +
  // localStorage and auto-expand it in the list.
  useEffect(() => {
    if (pickerOpen) {
      const fresh = slugFromUrl(pathname, searchParams);
      const current = tabs.find((t) => t.id === activeId) ?? tabs[0];
      const defaultSlug = current?.target.kind === 'agent' ? current.target.slug : fresh;
      setActiveHarnessSlug(fresh);
      setPickerFocusSlug(defaultSlug ?? null);
      setPickerFocusRole(current?.target.kind === 'agent' ? current.target.role : null);
      setPickerMenuOpen(null);
    }
  }, [pickerOpen, pathname, searchParams, tabs, activeId]);

  // Dismiss the picker on outside click. We attach to mousedown so closing
  // wins the race against any stray click bubbling into the picker itself.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.oracle-picker') || target.closest('.oracle-picker-body') || target.closest('.oracle-tab-add')) return;
      setPickerOpen(false);
      setPickerMenuOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickerMenuOpen) {
        setPickerMenuOpen(null);
        return;
      }
      setPickerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pickerOpen, pickerMenuOpen]);

  useEffect(() => {
    if (!open || pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        const v = (t as HTMLInputElement).value;
        if (typeof v === 'string' && v.length > 0) return;
      }
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, pickerOpen]);

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

    const firstRun = !localStorage.getItem(wsLocalKey(SEEN_KEY));
    const tutorialDone = !!localStorage.getItem(wsLocalKey(TUTORIAL_DONE_KEY));
    if (firstRun) {
      setOpen(true);
      localStorage.setItem(wsLocalKey(SEEN_KEY), '1');
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

  // External tutorial trigger. Also drains a one-shot intent flag set by
  // TutorialButton — covers the case where the user clicked the button
  // before this component finished its lazy-load + first-render cycle.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => startTutorial();
    window.addEventListener('oracle:start-tutorial', handler);
    try {
      if (localStorage.getItem(wsLocalKey('papercusp.tutorial.intent')) === '1') {
        localStorage.removeItem(wsLocalKey('papercusp.tutorial.intent'));
        setTimeout(() => startTutorial(), 0);
      }
    } catch { /* ignore */ }
    return () => window.removeEventListener('oracle:start-tutorial', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll on new content + tab activation is handled inside
  // <ChatConversation /> via its internal endRef + the `key={active.id}`
  // prop on the JSX site (forces remount on tab switch, which fires
  // the scroll-to-bottom effect).

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
      try { localStorage.setItem(wsLocalKey(TUTORIAL_DONE_KEY), '1'); } catch { /* ignore */ }
    }
    setTabs((prev) => {
      const oracleTab = prev.find((t) => t.target.kind === 'oracle');
      if (oracleTab) {
        const cleared = { ...oracleTab, messages: [] };
        const others = prev.filter((t) => t.id !== oracleTab.id);
        setActiveId(oracleTab.id);
        const next = [cleared, ...others];
        // Use the latest `send` via the ref — not the closure-captured
        // version. The setTimeout closure pins `send` from the render
        // that called startTutorial, but `send` itself reads `tabs` from
        // ITS render's closure, which lags one cycle behind this state
        // commit. If the lagged `tabs` doesn't contain `cleared`, the
        // `tabs.find(t => t.id === ...)` early-return fires and the
        // tutorial POST never goes out — visible symptom: dock opens,
        // empty state stays. Reading via the ref guarantees we hit the
        // post-commit `send` whose closure sees the cleared tab.
        setTimeout(() => {
          void sendRef.current(oracleTab.id, TUTORIAL_KICKOFF, { tutorialMode: true, baseMessages: [] });
        }, 0);
        return next;
      }
      const fresh: ChatTab = { id: newId(), target: ORACLE_TARGET, messages: [] };
      setActiveId(fresh.id);
      setTimeout(() => {
        void sendRef.current(fresh.id, TUTORIAL_KICKOFF, { tutorialMode: true, baseMessages: [] });
      }, 0);
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
        setOpen(false);
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
    setPickerMenuOpen(null);
    const sameTarget = (t: ChatTab) =>
      t.target.kind === target.kind &&
      (target.kind === 'oracle' || target.kind === 'support' ||
        (t.target.kind === 'agent' && t.target.slug === target.slug && t.target.role === target.role));
    const existing = tabs.find(sameTarget);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const fresh: ChatTab = {
      id: newId(),
      target,
      messages: target.kind === 'oracle' ? [WELCOME] : [],
    };
    setTabs((prev) => (prev.some(sameTarget) ? prev : [...prev, fresh]));
    setActiveId(fresh.id);
  }, [tabs]);

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
    // Look up via functional state read so we always see the latest tab
    // shape (post the most recent setTabs commit) — the closure-captured
    // `tabs` lags by one render cycle when send is called from inside
    // a state-update reducer (e.g. startTutorial's setTimeout).
    const tab = tabsRef.current.find((t) => t.id === tabId);
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
      let res: Response | null = null;
      if (tab.target.kind === 'oracle') {
        res = await fetch('/api/oracle/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: next.slice(0, -1).filter((m) => m.role !== 'assistant' || m.content),
            currentPath: typeof window !== 'undefined' ? window.location.pathname : '',
            // Pass our UI-client id so Oracle's ui:dispatch / ui:get_state
            // calls default to driving THIS tab (the one running the dock).
            // Threaded into the agentmcp spawn URL as ?client=<id> →
            // ctx.uiClientId on every Oracle tool call.
            uiClientId: typeof window !== 'undefined' ? getOrCreateClientId() : null,
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

      if (!res) return;
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
              // During the first-run tutorial, the user may have navigated
              // themselves to explore — auto-navigating would yank them
              // back. Skip the auto-navigate if the current pathname
              // differs from where Oracle last expected the user to be
              // (we sent it via `currentPath` at request time). The
              // assistant's text still mentions the page; the user can
              // navigate manually.
              const expectedFrom = typeof window !== 'undefined' ? window.location.pathname : '';
              const userMovedAway = tutorialActive && expectedFrom !== lastExpectedPathRef.current;
              if (!userMovedAway) {
                router.push(data.path);
                lastExpectedPathRef.current = data.path;
              }
              // If the user has moved away during a tutorial, treat that
              // as opting out — stop the tutorial so subsequent steps
              // don't keep yanking them back.
              if (userMovedAway) {
                setTutorialActive(false);
              }
            } else if (data?.type === 'openChat' && typeof data.slug === 'string' && typeof data.role === 'string') {
              // Oracle's openChat now opens a tab in the dock instead of
              // routing to /harness/<slug>?panel=pi.
              const role = data.role as AgentRole;
              if (agentRoles.includes(role)) {
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

  // Keep refs fresh so deferred callers (setTimeout inside reducers) hit
  // the most-recently-committed closures.
  useEffect(() => { sendRef.current = send; });
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const supportActive = activeTab?.target.kind === 'support';
  const supportFrameReady = chatwootFrameSrc.includes('cw_conversation=');

  const sendChatwootFrameTheme = useCallback(() => {
    const frame = chatwootFrameRef.current;
    postChatwootFrameMessage(frame, chatwootFrameTheme());
    postChatwootFrameMessage(frame, { event: 'set-color-scheme', darkMode: 'dark' });
  }, []);

  useEffect(() => {
    if (!supportActive || !supportEverOpened) return;
    const timer = window.setTimeout(sendChatwootFrameTheme, 350);
    return () => window.clearTimeout(timer);
  }, [supportActive, supportEverOpened, sendChatwootFrameTheme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string' || !event.data.startsWith('chatwoot-widget:')) return;
      try {
        const message = JSON.parse(event.data.replace('chatwoot-widget:', ''));
        if (message?.event === 'loaded') sendChatwootFrameTheme();
      } catch {
        /* ignore malformed widget messages */
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [sendChatwootFrameTheme]);

  // Lazy-mount the Chatwoot iframe the first time Support is shown, then
  // keep it mounted (display toggled) so the conversation isn't lost when
  // the user switches tabs.
  useEffect(() => {
    if (supportActive && !supportEverOpened) setSupportEverOpened(true);
  }, [supportActive, supportEverOpened]);

  useEffect(() => {
    if (!supportActive && !supportEverOpened) return;
    const findSdkConversationUrl = () => {
      const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src*="/widget"]'));
      const sdkFrame = frames.find((frame) => {
        if (frame === chatwootFrameRef.current) return false;
        return frame.src.includes(CHATWOOT_WEBSITE_TOKEN) && frame.src.includes('cw_conversation=');
      });
      if (sdkFrame?.src) setChatwootFrameSrc((prev) => (prev === sdkFrame.src ? prev : sdkFrame.src));
    };
    findSdkConversationUrl();
    // The SDK iframe appears (and its src gains cw_conversation=) at an
    // unpredictable moment after the Chatwoot script boots. React to the DOM
    // mutation instead of polling on a 750ms timer (audit P-064; A7-adjacent).
    const observer = new MutationObserver(findSdkConversationUrl);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    return () => observer.disconnect();
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
  const active = activeTab ?? tabs[0] ?? null;
  const activeBusy = active ? !!busyMap[active.id] : false;
  const activeError = active ? errors[active.id] : undefined;
  const lastMsg = active ? active.messages[active.messages.length - 1] : undefined;
  const showThinking = !!(activeBusy && lastMsg && lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.tools?.length);
  const headerLabel = active ? targetLabel(active.target) : 'Oracle';
  const ActiveTargetIcon = active ? targetIcon(active.target) : OracleLogoMark;
  const headerSubtitle = active ? targetSubtitle(active.target) : 'general help across Papercusp';

  // Entrance + ambient animations via motion's animate (gsap removed per the
  // perf-docs animation table). Notes vs the old gsap version:
  // - the reticle's intro no longer tweens rotate — the infinite spin loop
  //   owned that value anyway (later gsap tween won per-property);
  // - autoAlpha → opacity (visibility toggling was cosmetic for sub-second
  //   entrances).
  useEffect(() => {
    if (!fancyEffectsEnabled) return;

    const controls: Array<ReturnType<typeof animate>> = [];

    if (!open) {
      if (!fabRef.current) return;
      controls.push(
        animate(
          fabRef.current,
          { opacity: [0, 1], y: [18, 0], scale: [0.88, 1] },
          { duration: 0.48, ease: INTRO_EASE },
        ),
      );
      return () => controls.forEach((c) => c.stop());
    }

    const dock = dockRef.current;
    if (!dock) return;
    const sel = (s: string) => Array.from(dock.querySelectorAll<HTMLElement>(s));
    const run = (
      els: HTMLElement[],
      keyframes: Parameters<typeof animate>[1],
      options: Record<string, unknown>,
    ) => {
      if (els.length) controls.push(animate(els, keyframes as never, options as never));
    };

    // Intro (timeline offsets become per-group delays).
    run(sel('.oracle-hud-frame'), { opacity: [0, 1], scale: [0.72, 1], rotate: [-24, 0] }, { duration: 0.72, ease: INTRO_EASE });
    run(sel('.oracle-hud-reticle'), { opacity: [0, 1], scale: [0.72, 1] }, { duration: 0.72, ease: INTRO_EASE });
    run(sel('.oracle-dock-header'), { opacity: [0, 1], y: [-18, 0] }, { duration: 0.42, ease: INTRO_EASE, delay: 0.06 });
    run(sel('.oracle-tab, .oracle-tab-add'), { opacity: [0, 1], y: [12, 0] }, { duration: 0.32, ease: INTRO_EASE, delay: stagger(0.04, { startDelay: 0.12 }) });
    run(
      sel('.oracle-msg, .oracle-empty-state, .oracle-support-loading, .oracle-form'),
      { opacity: [0, 1], y: [18, 0] },
      { duration: 0.4, ease: INTRO_EASE, delay: stagger(0.05, { startDelay: 0.18 }) },
    );

    // Ambient loops while open.
    run(sel('.oracle-hud-reticle'), { rotate: 360 }, { duration: 18, ease: 'linear', repeat: Infinity });
    run(
      sel('.oracle-hud-scanline'),
      { x: ['-18%', '24%'], opacity: [0.12, 0.48] },
      { duration: 2.6, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' },
    );
    run(
      sel('.oracle-tab.is-active'),
      { boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-strong), transparent 84%), 0 0 24px color-mix(in srgb, var(--accent), transparent 82%)' },
      { duration: 1.2, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror' },
    );

    if (showThinking) {
      run(
        sel('.oracle-thinking-dots span'),
        { y: -4 },
        { duration: 0.42, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror', delay: stagger(0.1) },
      );
    }

    return () => controls.forEach((c) => c.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- replay the intro on the same triggers the gsap version used
  }, [open, activeId, active?.messages.length ?? 0, showThinking, supportActive, fancyEffectsEnabled]);

  if (!active) {
    // Pre-bootstrap; render only the FAB so we never flash an empty dock.
    return open ? null : (
      <button
        ref={fabRef}
        onClick={() => setOpen(true)}
        aria-label="Open Oracle assistant"
        className="oracle-fab oracle-fab--maximal-hud"
      >
        <img src="/mascot.svg" alt="" height={34} loading="lazy" style={{ display: 'block' }} />
        <span>Ask Oracle</span>
      </button>
    );
  }

  const pickerView = pickerOpen ? (() => {
    const allHarnesses = pickerHarnesses ?? [];
    const realHarnesses = allHarnesses.filter((h) => !isTestHarness(h.slug));
    const sortedHarnesses = [...realHarnesses].sort((a, b) => {
      if (a.slug === harnessSlug) return -1;
      if (b.slug === harnessSlug) return 1;
      return a.slug.localeCompare(b.slug);
    });
    const roles = agentRoles;
    const inferredSlug = pickerFocusSlug ?? harnessSlug ?? null;
    const displayHarnesses = sortedHarnesses.length > 0
      ? sortedHarnesses
      : inferredSlug ? [{ slug: inferredSlug }] : [];
    const selectedSlugBase = inferredSlug ?? displayHarnesses[0]?.slug ?? null;
    const selectedSlug = selectedSlugBase && displayHarnesses.some((h) => h.slug === selectedSlugBase)
      ? selectedSlugBase
      : displayHarnesses[0]?.slug ?? selectedSlugBase;
    const selectedRole = pickerFocusRole && roles.includes(pickerFocusRole)
      ? pickerFocusRole
      : roles[0] ?? null;
    const preferredRoleOrder = ['worker', 'architect', 'validator', 'scoper', 'orchestrator'];
    const orderedRoles = [...roles].sort((a, b) => {
      if (selectedRole && a === selectedRole) return -1;
      if (selectedRole && b === selectedRole) return 1;
      const ai = preferredRoleOrder.indexOf(a);
      const bi = preferredRoleOrder.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return roleLabel(a).localeCompare(roleLabel(b));
    });
    const SelectedRoleIcon = selectedRole ? roleIcon(selectedRole) : Bot;
    return (
      <div className="oracle-picker-body pc-animate-in pc-animate-in--down pc-animate-in--fast" role="region" aria-label="Start a new chat">
        <div className="oracle-picker-simple oracle-picker-form">
          <div className="oracle-picker-field">
            <label htmlFor="oracle-picker-harness-trigger">Harness</label>
            {pickerHarnesses === null ? (
              <div className="oracle-picker-empty compact">
                <strong>Loading harnesses…</strong>
              </div>
            ) : displayHarnesses.length === 0 ? (
              <div className="oracle-picker-empty compact">
                <strong>No harnesses</strong>
              </div>
            ) : (
              <>
                <button
                  id="oracle-picker-harness-trigger"
                  type="button"
                  className="oracle-picker-select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={pickerMenuOpen === 'harness'}
                  onClick={() => setPickerMenuOpen((v) => (v === 'harness' ? null : 'harness'))}
                >
                  <span>{selectedSlug}{selectedSlug === harnessSlug ? ' · current' : ''}</span>
                  <em>⌄</em>
                </button>
                {pickerMenuOpen === 'harness' && (
                  <div className="oracle-picker-menu pc-animate-in pc-animate-in--down pc-animate-in--fast" role="listbox" aria-label="Choose a harness">
                    {displayHarnesses.map((h) => {
                      const isSelected = h.slug === selectedSlug;
                      return (
                        <button
                          key={h.slug}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`oracle-picker-menu-option${isSelected ? ' is-selected' : ''}`}
                          onClick={() => {
                            setPickerFocusSlug(h.slug);
                            setPickerMenuOpen(null);
                          }}
                        >
                          <span>{h.slug}</span>
                          {h.slug === harnessSlug && <small>current</small>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="oracle-picker-field">
            <label htmlFor="oracle-picker-role-trigger">Agent</label>
            <button
              id="oracle-picker-role-trigger"
              type="button"
              className="oracle-picker-select-trigger"
              aria-haspopup="listbox"
              aria-expanded={pickerMenuOpen === 'agent'}
              disabled={roles.length === 0}
              onClick={() => setPickerMenuOpen((v) => (v === 'agent' ? null : 'agent'))}
            >
              <span className="oracle-picker-trigger-role">
                <span className="oracle-picker-role-icon-wrap">
                  <SelectedRoleIcon aria-hidden className="oracle-picker-role-icon" />
                </span>
                <span className="oracle-picker-trigger-role-label">
                  {selectedRole ? roleLabel(selectedRole) : 'No agents'}
                </span>
              </span>
              <em>⌄</em>
            </button>
            {pickerMenuOpen === 'agent' && roles.length > 0 && (
              <div className="oracle-picker-menu pc-animate-in pc-animate-in--down pc-animate-in--fast" role="listbox" aria-label="Choose an agent">
                {orderedRoles.map((role) => {
                  const isSelected = role === selectedRole;
                  const RoleIcon = roleIcon(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`oracle-picker-menu-option${isSelected ? ' is-selected' : ''}`}
                      onClick={() => {
                        setPickerFocusRole(role);
                        setPickerMenuOpen(null);
                      }}
                    >
                      <span className="oracle-picker-option-line">
                        <span className="oracle-picker-role-icon-wrap">
                          <RoleIcon aria-hidden className="oracle-picker-role-icon" />
                        </span>
                        <span className="oracle-picker-option-title">{roleLabel(role)}</span>
                      </span>
                      <small>{roleHint(role)}</small>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedRole && <span className="oracle-picker-field-hint">{roleHint(selectedRole)}</span>}
          </div>
          <button
            type="button"
            className="oracle-picker-start"
            disabled={!selectedSlug || !selectedRole}
            onClick={() => {
              if (selectedSlug && selectedRole) openTab({ kind: 'agent', slug: selectedSlug, role: selectedRole });
            }}
          >
            Chat with {selectedRole ? roleLabel(selectedRole) : 'agent'}
          </button>
          <div className="oracle-picker-secondary">
            <button type="button" className="oracle-picker-shortcut oracle-picker-shortcut-oracle" onClick={() => openTab(ORACLE_TARGET)}><OracleLogoMark aria-hidden className="oracle-picker-shortcut-icon" />Oracle</button>
            <button type="button" className="oracle-picker-shortcut oracle-picker-shortcut-support" onClick={() => openTab(SUPPORT_TARGET)}><LifeBuoy aria-hidden className="oracle-picker-shortcut-icon" />Support</button>
          </div>
        </div>
      </div>
    );
  })() : null;

  return (
    <>
      {!open && (
        <button
          ref={fabRef}
          onClick={() => setOpen(true)}
          aria-label="Open Oracle assistant"
          className={`oracle-fab oracle-fab--maximal-hud${Object.values(unreadMap).some(Boolean) ? ' has-unread' : ''}`}
        >
          <img src="/mascot.svg" alt="" height={34} loading="lazy" style={{ display: 'block' }} />
          <span>Ask Oracle</span>
          {Object.values(unreadMap).some(Boolean) && <span className="oracle-fab-badge" aria-label="unread" />}
        </button>
      )}

      {open && (
        <div
          ref={dockRef}
          className="oracle-dock oracle-dock--maximal-hud pc-animate-in pc-animate-in--right"
          data-oracle-dock
          data-target-kind={active.target.kind}
          role="dialog"
          aria-label="Oracle"
        >
          <div className="oracle-hud-overlay" aria-hidden="true">
            <div className="oracle-hud-scanline" />
            <HudReticleGlyph className="oracle-hud-reticle" size={92} />
            <HudFrameCorners className="oracle-hud-frame" />
          </div>
          <header className="oracle-dock-header pc-animate-in pc-animate-in--down pc-animate-in--fast">
            <div className="oracle-header-main">
              <span className="oracle-header-badge">
                <ActiveTargetIcon aria-hidden className="oracle-header-icon" />
              </span>
              <div className="oracle-header-copy">
                <strong>{headerLabel}</strong>
                <span>{headerSubtitle}</span>
              </div>
            </div>
            <div className="oracle-header-actions">
              <Tooltip label="Reset this chat"><button onClick={newOracleChat} aria-label="Reset this chat" className="oracle-icon-button"><RefreshCcw aria-hidden="true" className="oracle-header-action-icon" /></button></Tooltip>
              <Tooltip label="Configure"><RouteLink href="/settings/oracle" className="oracle-icon-button" aria-label="Configure"><Settings2 aria-hidden="true" className="oracle-header-action-icon" /></RouteLink></Tooltip>
              <button onClick={() => setOpen(false)} aria-label="Close" className="oracle-icon-button oracle-icon-button-close"><X aria-hidden="true" className="oracle-header-action-icon" /></button>
            </div>
          </header>

          {/* Tab strip */}
          <div className="oracle-tabs pc-animate-in pc-animate-in--down pc-animate-in--delay-1" role="tablist">
            {tabs.map((t, index) => {
              const isActive = t.id === active.id;
              const tabBusy = !!busyMap[t.id];
              const unread = !!unreadMap[t.id];
              const TabIcon = targetIcon(t.target);
              return (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={isActive}
                  data-tab-index={index}
                  data-busy={tabBusy ? 'true' : undefined}
                  data-unread={!tabBusy && unread ? 'true' : undefined}
                  className={`oracle-tab${isActive ? ' is-active' : ''}`}
                  onClick={() => setActiveId(t.id)}
                >
                  <span className="oracle-tab-label-wrap">
                    <TabIcon aria-hidden className="oracle-tab-icon" />
                    <span className="oracle-tab-label">{tabTitle(t.target, tabs, harnessSlug)}</span>
                  </span>
                  {tabBusy && <span className="oracle-tab-dot oracle-tab-dot-busy" aria-label="thinking" />}
                  {!tabBusy && unread && <span className="oracle-tab-dot oracle-tab-dot-unread" aria-label="unread" />}
                  <Tooltip label="Close"><button
                    type="button"
                    className="oracle-tab-close"
                    aria-label={`Close ${targetLabel(t.target)}`}

                    onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  ><X aria-hidden="true" className="oracle-tab-close-icon" /></button></Tooltip>
                </div>
              );
            })}
            <div style={{ position: 'relative', flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
              <Tooltip label="New chat"><button
                type="button"
                className={`oracle-tab-add${pickerOpen ? ' is-open' : ''}` }
                aria-label="New chat"

                onClick={() => setPickerOpen((v) => !v)}
              ><Plus aria-hidden="true" className="oracle-tab-add-icon" /></button></Tooltip>
            </div>
          </div>

          {pickerView ?? (
            <>
              {/* Migrated to shared <ChatConversation>. The chatwoot
                  iframe path is rendered separately below and toggled
                  via supportActive — when the support tab is active the
                  ChatConversation body + form are display:none'd via
                  bodyStyle / hideInput, and the iframe takes the space. */}
              <ChatConversation
                key={active.id}
                messages={active.messages}
                busy={!!showThinking}
                error={activeError}
                bodyClassName="pc-animate-in pc-animate-in--fade pc-animate-in--delay-2"
                bodyStyle={supportActive ? { display: 'none' } : undefined}
                emptyState={{
                  title: headerLabel,
                  body:
                    active.target.kind === 'oracle'
                      ? 'Ask me anything about Papercusp.'
                      : active.target.kind === 'support'
                        ? 'Connecting you to a human…'
                        : `Send a message to the ${active.target.role}.`,
                  icon: ActiveTargetIcon,
                }}
                iconForRole={(role) => (role === 'user' ? Users : ActiveTargetIcon)}
                labelForRole={(role) => (role === 'user' ? 'You' : headerLabel)}
                renderToolChip={(t, ti) => {
                  const summary = summarizeToolInput(t.input);
                  return (
                    <div key={ti} className="oracle-tool-chip" title={summary}>
                      🔧 <strong>{t.name}</strong>
                      {summary && <span className="oracle-tool-args">({summary})</span>}
                    </div>
                  );
                }}
                renderToolCard={(t, _msg, ti) => {
                  // Tool-card dispatch via the chat-cards registry
                  // (phase-4 T2.1). The registry maps tool names →
                  // renderers; Oracle supplies its own onAnswer
                  // because it's ephemeral (no transcript table) and
                  // mutates local tab state instead of POSTing to
                  // a turn-answer endpoint.
                  return renderCard(t.name, {
                    args: t.input ?? {},
                    answered: t.answered,
                    onAnswer: (payload) => {
                      const tab = active;
                      const { picks } = payload as { picks: Array<{ option_id: string; label: string }> };
                      if (!tab || picks.length === 0) return;
                      // Mark the local tool entry's `answered` so
                      // re-renders show the disabled/picked state.
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const tools = (tab.messages.find((m) => m.tools)?.tools ?? []) as any[];
                      if (tools[ti]) {
                        tools[ti].answered = {
                          picks,
                          at: Date.now(),
                        };
                      }
                      const joined = picks.map((p) => p.label).join(' · ');
                      setInput(joined);
                      void send(tab.id);
                    },
                  });
                }}
                inputValue={input}
                onInputChange={setInput}
                onSubmit={() => void send(active.id)}
                inputPlaceholder={
                  active.target.kind === 'agent'
                    ? `Message ${active.target.role}…`
                    : 'Ask the Oracle…'
                }
                inputIcon={ActiveTargetIcon}
                hideInput={supportActive}
              />

              {/* Chatwoot widget rendered inline. Mounted lazily on first
                  Support activation, then kept mounted so the conversation
                  survives tab switches. The iframe handles its own input so
                  ChatConversation's form is hideInput-suppressed for this tab. */}
              {supportActive && !supportFrameReady && (
                <div className="oracle-support-loading">Connecting to support…</div>
              )}
              {supportEverOpened && supportFrameReady && (
                <iframe
                  ref={chatwootFrameRef}
                  className="oracle-chatwoot-frame"
                  src={chatwootFrameSrc}
                  title="Papercusp Support chat"
                  style={supportActive ? undefined : { display: 'none' }}
                  onLoad={sendChatwootFrameTheme}
                  allow="clipboard-read; clipboard-write; microphone; camera"
                />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
