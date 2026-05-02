/**
 * Operator prompt assembly (v5).
 *
 * Composition (top-to-bottom):
 *   1. First-run intro block (only on first interaction in a workspace,
 *      gated by per-(workspace, user) marker).
 *   2. Substrate-owned `prompt-system.md` — tier table, schema, anti-patterns.
 *      Shipped with the substrate; the user CANNOT edit it from settings.
 *   3. User-editable `prompt-user.md` — voice, tone, free-form preferences.
 *   4. `preferences.md` — workspace-scoped learned preferences with
 *      provenance tags.
 *   5. The current request — typically "scan the workspace…" or a
 *      freeform user message.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { papercuspPath } from './papercusp-root';
import { loadPreferences } from './operator-preferences';
import { OPERATOR_SUBSTRATE_PROMPT } from './operator-prompt-system';

function OPERATOR_DIR() {
  return papercuspPath('system', 'operator');
}
function USER_PROMPT_PATH() {
  return join(OPERATOR_DIR(), 'prompt-user.md');
}
function FIRST_RUN_MARKER_PATH() {
  return join(OPERATOR_DIR(), 'first-run.json');
}

const FIRST_RUN_INTRO = `\
Hi, I'm the Operator. I have full write authority across all harnesses
in this workspace and will work with you to implement your vision.

By default, any far-reaching or underspecified actions I will surface to
you before proceeding. I'll learn your preferences through our
interactions, so please correct me if I behave in a way you didn't like
so I can adjust for next time.

You can edit my voice/tone in prompt-user.md, and I keep a separate
notebook of preferences I've learned about you in this workspace. Both
are editable from my settings page (/settings/operator). My substrate
prompt (tier rules and schema) is read-only.
`;

function readOr(path: string, def: string): string {
  if (!existsSync(path)) return def;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return def;
  }
}

export interface BuildPromptArgs {
  /** The user's request, or 'scan' for an unprompted scan. */
  request: string;
  /** The active user id (used to gate the first-run intro). */
  userId: string;
  /** Force the first-run intro even if the marker already lists this user. */
  showFirstRun?: boolean;
}

export interface BuildPromptResult {
  promptText: string;
  isFirstRun: boolean;
}

export function buildOperatorPrompt(args: BuildPromptArgs): BuildPromptResult {
  const isFirstRun = args.showFirstRun ?? !hasShownFirstRunFor(args.userId);

  const systemPrompt = OPERATOR_SUBSTRATE_PROMPT;
  const userPrompt = readOr(USER_PROMPT_PATH(), '').trim();
  const prefs = loadPreferences().raw.trim();

  const sections: string[] = [];
  if (isFirstRun) sections.push(FIRST_RUN_INTRO);
  sections.push(systemPrompt);
  if (userPrompt) sections.push(`## User-editable prompt\n\n${userPrompt}`);
  if (prefs) sections.push(`## Preferences (workspace-scoped, learned)\n\n${prefs}`);
  sections.push(`## Request\n\n${args.request}`);

  return { promptText: sections.join('\n\n---\n\n'), isFirstRun };
}

interface FirstRunMarker {
  shownAt: string; // ISO of first time intro was shown in this workspace
  shownToUserIds: string[];
}

function readFirstRunMarker(): FirstRunMarker | null {
  const path = FIRST_RUN_MARKER_PATH();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FirstRunMarker>;
    if (!raw || typeof raw !== 'object') return null;
    return {
      shownAt: typeof raw.shownAt === 'string' ? raw.shownAt : new Date().toISOString(),
      shownToUserIds: Array.isArray(raw.shownToUserIds) ? raw.shownToUserIds.filter((u) => typeof u === 'string') : [],
    };
  } catch {
    return null;
  }
}

export function hasShownFirstRunFor(userId: string): boolean {
  const marker = readFirstRunMarker();
  return !!marker && marker.shownToUserIds.includes(userId);
}

/** Mark first-run as shown for the given user. Idempotent. */
export function markFirstRunShown(userId: string): void {
  const path = FIRST_RUN_MARKER_PATH();
  mkdirSync(dirname(path), { recursive: true });
  const existing = readFirstRunMarker();
  const next: FirstRunMarker = existing
    ? {
        shownAt: existing.shownAt,
        shownToUserIds: existing.shownToUserIds.includes(userId)
          ? existing.shownToUserIds
          : [...existing.shownToUserIds, userId],
      }
    : { shownAt: new Date().toISOString(), shownToUserIds: [userId] };
  writeFileSync(path, JSON.stringify(next, null, 2));
}
