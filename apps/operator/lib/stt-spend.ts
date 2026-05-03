/**
 * STT cost tracking + soft/hard cap state (parallel to tts-spend.ts).
 *
 * Tracks minutes of audio sent to paid cloud STT engines. Voicemode
 * (local Whisper) and Web Speech (browser's built-in) are free and do
 * not record. Deepgram Nova-2 ~ $0.0043/min is the first paid engine.
 *
 * Per-call spend is recorded in `<papercuspRoot>/system/operator/stt-spend.json`.
 * Schema mirrors tts-spend.json but in minutes:
 *   {
 *     perMinuteRate: 0.0043,         // user-configurable, default Deepgram Nova-2
 *     softCapUsd:   1,
 *     hardCapUsd:   5,
 *     lastSpendDate: 'YYYY-MM-DD',
 *     softCapAcknowledgedDate: null | 'YYYY-MM-DD',
 *     spend: [{ date, minutes, estimatedUsd }, ...]
 *   }
 *
 * Recording is split into pure logic (`computeNextSttState`) + IO
 * so cap-trip + rollover are unit-testable without a filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';

export interface SttSpendDay {
  date: string;
  minutes: number;
  estimatedUsd: number;
}

export interface SttSpendState {
  perMinuteRate: number;
  softCapUsd: number;
  hardCapUsd: number;
  lastSpendDate: string | null;
  softCapAcknowledgedDate: string | null;
  spend: SttSpendDay[];
}

export interface SttSpendUpdate {
  next: SttSpendState;
  fireSoftCap: boolean;
  hardCapTripped: boolean;
  todayUsd: number;
}

export const DEFAULT_STT_SPEND_STATE: SttSpendState = {
  perMinuteRate: 0.0043,
  softCapUsd: 1,
  hardCapUsd: 5,
  lastSpendDate: null,
  softCapAcknowledgedDate: null,
  spend: [],
};

function PATH(): string {
  return papercuspPath('system', 'operator', 'stt-spend.json');
}

function utcDateString(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function computeNextSttState(
  cur: SttSpendState,
  minutes: number,
  now: number = Date.now(),
): SttSpendUpdate {
  const today = utcDateString(now);
  let spend = [...cur.spend];
  let softCapAcknowledgedDate = cur.softCapAcknowledgedDate;

  if (cur.lastSpendDate !== today) {
    spend.unshift({ date: today, minutes: 0, estimatedUsd: 0 });
    spend = spend.slice(0, 7);
    softCapAcknowledgedDate = null;
  }

  spend[0].minutes += minutes;
  spend[0].estimatedUsd = spend[0].minutes * cur.perMinuteRate;
  const todayUsd = spend[0].estimatedUsd;

  const next: SttSpendState = {
    ...cur,
    lastSpendDate: today,
    softCapAcknowledgedDate,
    spend,
  };

  const fireSoftCap = todayUsd > cur.softCapUsd && softCapAcknowledgedDate !== today;
  const hardCapTripped = todayUsd > cur.hardCapUsd;
  if (fireSoftCap) next.softCapAcknowledgedDate = today;

  return { next, fireSoftCap, hardCapTripped, todayUsd };
}

export function loadSttSpend(): SttSpendState {
  const path = PATH();
  if (!existsSync(path)) return { ...DEFAULT_STT_SPEND_STATE };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SttSpendState>;
    return {
      ...DEFAULT_STT_SPEND_STATE,
      ...raw,
      spend: Array.isArray(raw.spend) ? raw.spend.slice(0, 7) : [],
    };
  } catch {
    return { ...DEFAULT_STT_SPEND_STATE };
  }
}

export function saveSttSpend(state: SttSpendState): void {
  const path = PATH();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function recordSttSpend(minutes: number, now: number = Date.now()): SttSpendUpdate {
  const cur = loadSttSpend();
  const update = computeNextSttState(cur, minutes, now);
  saveSttSpend(update.next);
  return update;
}
