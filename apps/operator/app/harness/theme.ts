/**
 * Linear-inspired design tokens for the harness dashboard.
 * Dense, low-chrome, keyboard-first.
 */

export const COLORS = {
  bg: 'var(--hive-harness-bg, #0b0e14)',
  surface: 'var(--hive-harness-surface, #0f1420)',
  surfaceRaised: 'var(--hive-harness-surface-raised, #111827)',
  surfaceHover: 'var(--hive-harness-surface-hover, #1a2332)',
  border: 'var(--hive-harness-border, #1f2937)',
  borderStrong: 'var(--hive-harness-border-strong, #374151)',
  borderSubtle: 'var(--hive-harness-border-subtle, #161b26)',

  text: 'var(--hive-harness-text, #e5e7eb)',
  textMuted: 'var(--hive-harness-text-muted, #9ca3af)',
  textDim: 'var(--hive-harness-text-dim, #6b7280)',
  textFaint: 'var(--hive-harness-text-faint, #4b5563)',

  accent: 'var(--hive-harness-accent, #5e6ad2)',
  accentHover: 'var(--hive-harness-accent-hover, #7178d8)',

  danger: '#7f1d1d',
  dangerBg: '#2a1315',
  dangerText: '#fca5a5',
  success: '#065f46',
  successBg: '#0f3024',
  successText: '#a7f3d0',
} as const;

// Status palette — dot uses COLOR_SOLID, pill bg uses COLOR_BG for subtler look.
// Wrapped in a Proxy that returns a neutral fallback for any status not in the
// coding-harness state machine (e.g. parent-harness `proposed`, `approved`).
// Without this, `STATUS[unknownStatus].label` crashes the entire FeatureList
// subtree at hydration when a parent harness's features are loaded — see
// `getStatusMeta()` below for the canonical config-aware lookup.
const _STATUS_TABLE = {
  todo:        { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)',  text: '#d1d5db', label: 'Todo' },
  in_progress: { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',   text: '#93c5fd', label: 'In progress' },
  validating:  { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',   text: '#d8b4fe', label: 'Validating' },
  failing:     { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',    text: '#fca5a5', label: 'Failing' },
  blocked:     { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',   text: '#fcd34d', label: 'Blocked' },
  passed:      { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',   text: '#6ee7b7', label: 'Passed' },
  deprecated:  { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',     text: '#a1a1aa', label: 'Deprecated' },
} as const;

const _STATUS_FALLBACK = { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown' } as const;

export const STATUS = new Proxy(_STATUS_TABLE as Record<string, { solid: string; bg: string; text: string; label: string }>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_FALLBACK;
  },
}) as typeof _STATUS_TABLE;

export type HarnessStatus = keyof typeof _STATUS_TABLE;

// Ordering used for list sort.
// Active work first, terminal states last. `deprecated` is a soft-retired
// state — sorts to the very end so it doesn't crowd active work.
export const STATUS_ORDER: HarnessStatus[] = [
  'in_progress', 'validating', 'failing', 'todo', 'blocked', 'passed', 'deprecated',
];

// Ordering used for board column layout (left → right).
// Read like a workflow: queue → in motion → blocked → done.
export const BOARD_COLUMN_ORDER: HarnessStatus[] = [
  'todo', 'in_progress', 'validating', 'failing', 'blocked', 'passed', 'deprecated',
];

// ─── Issue severity + status palettes ──────────────────────────────
//
// Issues carry their own `severity` (critical|major|minor|nit) and
// `status` (open|acknowledged|fixing|closed|wontfix) axes — distinct from
// the feature STATUS machine above. These are the SINGLE source for issue
// coloring; the /adv Issues panel + Detail pane read them via the
// <SeverityPill> / issue-status helpers in primitives.tsx instead of
// re-declaring local tone maps. Hues align to the bluefrost semantic
// family (red → amber → accent → grey) so issues stay on-theme; `minor` uses
// the accent token rather than the legacy yellow.
//
// Same Proxy fallback as STATUS — an unknown severity/status returns a
// neutral grey rather than crashing the row subtree at render.

const _SEVERITY_TABLE = {
  critical: { solid: '#ef4444', bg: 'rgba(239,68,68,0.16)',   text: '#fca5a5', label: 'Critical' },
  major:    { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Major' },
  minor:    { solid: 'var(--accent)', bg: 'color-mix(in oklab, var(--accent), transparent 86%)',  text: 'var(--accent-strong, var(--accent))', label: 'Minor' },
  nit:      { solid: '#94a3b8', bg: 'rgba(148,163,184,0.14)', text: '#cbd5e1', label: 'Nit' },
} as const;

const _STATUS_META_FALLBACK = { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown' } as const;

export const SEVERITY = new Proxy(_SEVERITY_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _SEVERITY_TABLE;

export type IssueSeverityKey = keyof typeof _SEVERITY_TABLE;

// Severity ordering, most-urgent first — used to sort the Issues list.
export const SEVERITY_ORDER: IssueSeverityKey[] = ['critical', 'major', 'minor', 'nit'];

const _ISSUE_STATUS_TABLE = {
  open:         { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',  text: '#fca5a5', label: 'Open' },
  acknowledged: { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)', text: '#fcd34d', label: 'Acknowledged' },
  fixing:       { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)', text: '#d8b4fe', label: 'Fixing' },
  // `resolved` = fixed (the work_items issue-family state between fixing and
  // closed) — emerald family like closed, lighter so the two read as
  // related-but-distinct.
  resolved:     { solid: '#34d399', bg: 'rgba(52,211,153,0.15)', text: '#a7f3d0', label: 'Resolved' },
  closed:       { solid: '#10b981', bg: 'rgba(16,185,129,0.15)', text: '#6ee7b7', label: 'Closed' },
  wontfix:      { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',   text: '#a1a1aa', label: 'Won’t fix' },
} as const;

export const ISSUE_STATUS = new Proxy(_ISSUE_STATUS_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _ISSUE_STATUS_TABLE;

export type IssueStatusKey = keyof typeof _ISSUE_STATUS_TABLE;

// Unified work_items `kind` coloring — feature-family {feature, research-task,
// chunk} + issue-family {bug, change, task} (unify-work-items D-001). The
// SINGLE source for kind chips (<KindPill> in primitives.tsx), same hue
// discipline + Proxy fallback as SEVERITY / ISSUE_STATUS above so the
// Work-items table's pill columns speak one visual language.
const _WORK_ITEM_KIND_TABLE = {
  feature:         { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',  text: '#93c5fd', label: 'Feature' },
  'research-task': { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',  text: '#d8b4fe', label: 'Research' },
  chunk:           { solid: '#14b8a6', bg: 'rgba(20,184,166,0.15)',  text: '#5eead4', label: 'Chunk' },
  bug:             { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',   text: '#fca5a5', label: 'Bug' },
  change:          { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Change' },
  task:            { solid: '#94a3b8', bg: 'rgba(148,163,184,0.14)', text: '#cbd5e1', label: 'Task' },
} as const;

export const WORK_ITEM_KIND = new Proxy(_WORK_ITEM_KIND_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _WORK_ITEM_KIND_TABLE;

export type WorkItemKindKey = keyof typeof _WORK_ITEM_KIND_TABLE;

// Agent pane-kind coloring — the colony vocabulary {queen, bee, sentinel,
// planner, su} (apps/tui agent_pane_kind.rs). The SINGLE source for agent-kind
// chips (<AgentKindPill> in primitives.tsx), same hue discipline + Proxy
// fallback as WORK_ITEM_KIND so the Agents table's pill columns speak the same
// visual language as Work items.
const _AGENT_KIND_TABLE = {
  queen:    { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Queen' },
  bee:      { solid: 'var(--accent)', bg: 'color-mix(in oklab, var(--accent), transparent 86%)',  text: 'var(--accent-strong, var(--accent))', label: 'Bee' },
  sentinel: { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',  text: '#6ee7b7', label: 'Sentinel' },
  planner:  { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',  text: '#d8b4fe', label: 'Planner' },
  su:       { solid: '#ec4899', bg: 'rgba(236,72,153,0.15)',  text: '#f9a8d4', label: 'SU' },
  // overwatch-role-2026-06-15 B-01: the autonomous system-health supervisor (a sibling to
  // the Queen). Indigo — distinct from the queen's amber so the roster separates them.
  overwatch: { solid: '#6366f1', bg: 'rgba(99,102,241,0.15)',  text: '#a5b4fc', label: 'Overwatch' },
} as const;

export const AGENT_KIND = new Proxy(_AGENT_KIND_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _AGENT_KIND_TABLE;

export type AgentKindKey = keyof typeof _AGENT_KIND_TABLE;

/**
 * Canonical role color/label overrides. Roles not listed here get a
 * stable color derived from their name (see getRoleStyle below) — adding
 * a new role file under libs/papercusp/packages/harness/prompts/ gives
 * it a distinct UI color without a code edit.
 *
 * Use getRoleStyle(role) instead of ROLE[role] directly. The legacy
 * ROLE export is kept for the small handful of call sites that index
 * statically (e.g. ROLE.unknown for the fallback grey).
 */
export const ROLE = {
  planner:      { solid: '#a855f7', label: 'Planner' },
  orchestrator: { solid: '#ec4899', label: 'Orchestrator' },
  worker:       { solid: '#3b82f6', label: 'Worker' },
  validator:    { solid: '#10b981', label: 'Validator' },
  escalator:    { solid: '#f59e0b', label: 'Escalator' },
  unknown:      { solid: '#6b7280', label: 'Unknown' },
} as const;

export type RoleKey = keyof typeof ROLE;

/**
 * Stable hash for deriving a hue from a role name. djb2 — small, fast,
 * adequate distribution for ~50 distinct strings (which is all we'll
 * ever have here). Returns a value in [0, 2^32).
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0; // unsigned
}

/**
 * Title-case a role name. Splits on dashes/underscores so 'infra-reviewer'
 * → 'Infra Reviewer' and 'project_manager' → 'Project Manager'.
 */
function titleCase(s: string): string {
  return s
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve a role to its color + label. Falls back to a hash-derived HSL
 * color for roles not in the canonical ROLE map. Use this everywhere
 * agent role colors are looked up — including for roles loaded at runtime
 * from the prompts/ directory (getKnownRoles).
 */
export function getRoleStyle(role: string | null | undefined): { solid: string; label: string } {
  const key = (role ?? '').toLowerCase();
  if (!key) return ROLE.unknown;
  if (key in ROLE) return ROLE[key as RoleKey];
  // Stable hash-derived hue. 65% sat / 55% light gives consistent
  // perceived brightness across the wheel and stays distinguishable
  // from the 5 canonical role colors.
  const hue = djb2(key) % 360;
  return { solid: `hsl(${hue} 65% 55%)`, label: titleCase(key) };
}

export const FONTS = {
  ui: 'system-ui, -apple-system, "Inter", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "Menlo", monospace',
} as const;

export const SIZES = {
  xs: '0.7rem',
  sm: '0.75rem',
  base: '0.8rem',
  md: '0.85rem',
  lg: '0.95rem',
  xl: '1.1rem',
} as const;

export const RADIUS = {
  sm: 3,
  md: 4,
  lg: 6,
} as const;

// ─── Config-aware helpers (harness-of-harnesses Layer 1-A) ──────────
//
// The legacy STATUS / STATUS_ORDER / BOARD_COLUMN_ORDER consts above hard-code
// the coding-harness state machine. Parent harnesses (e.g. restart-org) and
// future harness types declare their own itemStates in .papercusp/config.json.
//
// These helpers read from a HarnessConfig if provided, falling back to the
// coding-harness defaults so legacy callers behave identically.
//
// Migration policy: existing components keep using the literal consts; new
// components for non-coding harnesses (parent, department, etc.) use these
// helpers.

export interface StatusMeta {
  solid: string;
  bg: string;
  text: string;
  label: string;
}

export interface HarnessConfig {
  itemStates?: string[];
  terminalStates?: string[];
  successState?: string;
  boardColumnOrder?: string[];
  statusOrder?: string[];
  statusColors?: Record<string, Partial<StatusMeta>>;
  savedViews?: Array<{ id: string; name: string; filter: { statuses: string[] } }>;
}

const DEFAULT_STATUS_COLORS: Record<string, StatusMeta> = {
  proposed:    { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#d1d5db', label: 'Proposed' },
  approved:    { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)', text: '#d8b4fe', label: 'Approved' },
  in_progress: { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)', text: '#93c5fd', label: 'In progress' },
  launched:    { solid: '#10b981', bg: 'rgba(16,185,129,0.15)', text: '#6ee7b7', label: 'Launched' },
  paused:      { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)', text: '#fcd34d', label: 'Paused' },
  cancelled:   { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Cancelled' },
};

const DEFAULT_FALLBACK: StatusMeta = {
  solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown',
};

/** Resolve display metadata for a status string against config (or coding defaults). */
export function getStatusMeta(status: string, config?: HarnessConfig): StatusMeta {
  // Coding-harness statuses: use the legacy STATUS const.
  if (status in STATUS) {
    return STATUS[status as HarnessStatus];
  }
  // Org-level statuses: use defaults from this module.
  const defaultMeta = DEFAULT_STATUS_COLORS[status];
  // Per-config overrides.
  const override = config?.statusColors?.[status];
  if (override) {
    return { ...DEFAULT_FALLBACK, ...defaultMeta, ...override, label: override.label ?? defaultMeta?.label ?? humanize(status) };
  }
  if (defaultMeta) return defaultMeta;
  return { ...DEFAULT_FALLBACK, label: humanize(status) };
}

/** Board column layout (left → right). Falls back to coding-harness BOARD_COLUMN_ORDER. */
export function getBoardColumnOrder(config?: HarnessConfig): string[] {
  if (config?.boardColumnOrder?.length) return config.boardColumnOrder;
  if (config?.itemStates?.length) return config.itemStates;
  return BOARD_COLUMN_ORDER as unknown as string[];
}

/** Sort ordering for list views (active first, terminal last). */
export function getStatusOrder(config?: HarnessConfig): string[] {
  if (config?.statusOrder?.length) return config.statusOrder;
  if (config?.itemStates?.length) {
    const term = new Set(config.terminalStates ?? []);
    const nonTerm = config.itemStates.filter((s) => !term.has(s));
    return [...nonTerm, ...config.itemStates.filter((s) => term.has(s))];
  }
  return STATUS_ORDER as unknown as string[];
}

/** The "completed" / success status — used by InsightsPanel KPIs. */
export function getSuccessState(config?: HarnessConfig): string {
  return config?.successState ?? 'passed';
}

/** Saved-view filter list. Falls back to coding-harness defaults. */
export function getSavedViews(config?: HarnessConfig): Array<{ id: string; name: string; filter: { statuses: string[] } }> {
  if (config?.savedViews?.length) return config.savedViews;
  return [
    { id: 'running', name: 'Running', filter: { statuses: ['in_progress', 'validating'] } },
    { id: 'blocked', name: 'Blocked', filter: { statuses: ['blocked', 'failing'] } },
    { id: 'todo', name: 'Todo', filter: { statuses: ['todo'] } },
    { id: 'done', name: 'Passed', filter: { statuses: ['passed'] } },
  ];
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
