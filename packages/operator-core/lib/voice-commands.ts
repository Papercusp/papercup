/**
 * Voice command parser (Phase 1a of voice-mode plan v4).
 *
 * Pure parser — no NLU. Strict literal prefix matching with ordinal
 * extraction. Same input both panel-open commands and chrome-resident
 * intents consume.
 *
 * Grammar (case-insensitive, post-trim):
 *   cancel                                  → { kind: 'cancel' }
 *   dispatch [<ordinal>]                    → { kind: 'dispatch', ordinal? }
 *   dismiss  [<ordinal>]                    → { kind: 'dismiss',  ordinal? }
 *   scan [...rest]                          → { kind: 'scan', query? }
 *   rescan | re-scan | scan again           → { kind: 'scan' }
 *   pause                                   → { kind: 'pause' }
 *   resume | unpause                        → { kind: 'resume' }
 *   approve <slug> [<capability>]           → handled by voice-intents (operator-prefixed)
 *   <anything else, ≥2 chars>               → { kind: 'freeform', text }
 *
 * Ordinals accepted (case-insensitive):
 *   first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth
 *   one|two|three|...|ten
 *   1|2|3|...|10
 */

export type VoiceCommand =
  | { kind: 'cancel' }
  | { kind: 'dispatch'; ordinal?: number }
  | { kind: 'dismiss'; ordinal?: number }
  | { kind: 'scan'; query?: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'freeform'; text: string };

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function parseOrdinal(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const t = token.toLowerCase();
  if (ORDINAL_WORDS[t] !== undefined) return ORDINAL_WORDS[t];
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= 50) return n;
  return undefined;
}

export function parseVoiceCommand(utterance: string): VoiceCommand {
  const norm = utterance.trim();
  if (norm.length < 2) return { kind: 'freeform', text: norm };

  const lower = norm.toLowerCase();

  // Compound forms first.
  if (lower === 'rescan' || lower === 're-scan' || lower === 'scan again' || lower === 'rerun scan') {
    return { kind: 'scan' };
  }

  // Single-word commands.
  if (lower === 'cancel') return { kind: 'cancel' };
  if (lower === 'pause') return { kind: 'pause' };
  if (lower === 'resume' || lower === 'unpause') return { kind: 'resume' };

  // dispatch / dismiss [ordinal]
  const dispatchMatch = lower.match(/^dispatch(?:\s+(\S+))?$/);
  if (dispatchMatch) {
    return { kind: 'dispatch', ordinal: parseOrdinal(dispatchMatch[1]) };
  }
  // Some users say "dispatch the third one" — strip filler.
  const dispatchFiller = lower.match(/^dispatch\s+(?:the\s+)?(\S+)(?:\s+one)?$/);
  if (dispatchFiller) {
    const ord = parseOrdinal(dispatchFiller[1]);
    if (ord !== undefined) return { kind: 'dispatch', ordinal: ord };
  }
  const dismissMatch = lower.match(/^dismiss(?:\s+(\S+))?$/);
  if (dismissMatch) {
    return { kind: 'dismiss', ordinal: parseOrdinal(dismissMatch[1]) };
  }
  const dismissFiller = lower.match(/^dismiss\s+(?:the\s+)?(\S+)(?:\s+one)?$/);
  if (dismissFiller) {
    const ord = parseOrdinal(dismissFiller[1]);
    if (ord !== undefined) return { kind: 'dismiss', ordinal: ord };
  }

  // scan <query>
  const scanMatch = lower.match(/^scan\s+(.+)$/);
  if (scanMatch) return { kind: 'scan', query: norm.slice(5).trim() };
  if (lower === 'scan') return { kind: 'scan' };

  // Anything else falls through to freeform.
  return { kind: 'freeform', text: norm };
}
