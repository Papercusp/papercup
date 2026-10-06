/**
 * The cheap "looks like a bug" classifier for chat suggestions
 * (slack-messages-to-bug-reports-2026-10-05 P-007, decisions D-002 and D-010).
 *
 * In a channel with a suggest rule, a person's ordinary post that scores at or above
 * CHAT_BUG_SUGGEST_THRESHOLD earns its author a private note naming how to report it. The
 * classifier never files anything: only the person's own report gesture does (D-002).
 *
 * It is deliberately a deterministic weighted-phrase scorer, not a model call:
 *   - it runs on every top-level post in an opted-in channel, so it must cost nothing;
 *   - message text never leaves the machine to be classified;
 *   - a false positive costs one private note, so the threshold favours precision.
 *
 * Precision and recall are measured against a frozen labelled holdout written before this file
 * (fixtures/chat-bug-suggest-holdout.json); features are tuned against
 * fixtures/chat-bug-suggest-tuning.json only. See chat-bug-suggest.test.ts.
 */

/** Bump when a feature, weight or the threshold changes; stored with every suggestion. */
export const CHAT_BUG_CLASSIFIER_VERSION = 'lexical-v1';

/**
 * A post scoring at or above this is suggested. Chosen on the tuning sample, where every
 * non-report scores 0 or below (2.5 points of margin) and recall is 0.75 at precision 1.0.
 */
export const CHAT_BUG_SUGGEST_THRESHOLD = 2.5;

interface Feature {
  id: string;
  weight: number;
  pattern: RegExp;
}

/** Evidence that the author is describing a malfunction they hit. */
const POSITIVE: readonly Feature[] = [
  // Strong evidence: one of these is a report on its own unless a negative feature says otherwise.
  {
    id: 'malfunction',
    weight: 3,
    pattern: /\b(?:broken|broke|crash(?:es|ed|ing)?|freez(?:e|es|ing)|frozen|hangs?|hanging|glitch(?:y|es|ing)?|buggy|regression|white screen|blank (?:page|screen))\b/,
  },
  { id: 'failure', weight: 2, pattern: /\b(?:fail(?:s|ed|ing|ure)?|errors? out|errored|throws?|threw)\b/ },
  { id: 'error-term', weight: 1.5, pattern: /\b(?:error|exception|stack ?trace|traceback|timeout|timed out|connection refused)\b/ },
  {
    id: 'not-working',
    weight: 3,
    pattern: /\b(?:not working|isn'?t working|doesn'?t work|does not work|don'?t work|stopped working|no longer|does nothing|won'?t (?:load|open|save|work|let)|doesn'?t (?:save|load|open|show|apply|remember|match|let|actually)|don'?t (?:show|apply|match|load|save)|didn'?t (?:save|load|work|show)|never (?:arrives?|loads?|shows?))\b/,
  },
  { id: 'cant', weight: 1.5, pattern: /\b(?:can'?t|cannot|unable to|not letting)\b/ },
  {
    id: 'wrong-result',
    weight: 1.5,
    pattern: /\b(?:wrong|incorrect|missing|disappear(?:ed|s)?|lost|blank|white screen|duplicated?|twice|cuts? off|revert(?:s|ed)?|resets?|gone|goes past|greyed out|grayed out)\b/,
  },
  { id: 'stuck', weight: 1.5, pattern: /\b(?:stuck|spins?|spinning|forever|kicked out)\b/ },
  { id: 'slow', weight: 1.5, pattern: /\b(?:slow|lag(?:gy|s|ging)?)\b/ },
  { id: 'duration', weight: 1.5, pattern: /\btakes? (?:like |about |over )?\d+ ?(?:s|secs?|seconds?|mins?|minutes?)\b/ },
  // A reproduction step: "when I click", "after I upload", "every time I switch".
  {
    id: 'repro-step',
    weight: 1.5,
    pattern: /\b(?:when(?:ever)?|after|once|time) i (?:try to |tried to )?(?:click|tap|press|open|close|switch|select|upload|download|save|submit|paste|type|scroll|drag|log ?in|log ?out|sign ?in|sign ?out|refresh|reload|rotate|stop|start|export|import|search|delete|edit|send|share|visit|navigate|go to)/,
  },
  // The author says what should have happened: "even after", "but it still", "instead of".
  { id: 'expectation', weight: 1.5, pattern: /\b(?:even (?:after|though|when|if|for)|but (?:it|the|nothing|still)|instead of|supposed to|should(?:n'?t)? (?:be|have|show))\b/ },
  { id: 'status-code', weight: 1.5, pattern: /\b(?:[45]0\d)\b|\bcode \d{3,}\b/ },
  { id: 'repetition', weight: 1, pattern: /\b(?:every ?time|keeps?|again|each time|still)\b/ },
  { id: 'onset', weight: 1, pattern: /\b(?:since (?:the|this|yesterday|today|last|updating|upgrading|\d)|after (?:the (?:last )?(?:update|upgrade|release)|updating|upgrading)|anymore|this morning|all day)\b/ },
  { id: 'symptom-report', weight: 1, pattern: /\b(?:i keep getting|i'?m getting|getting an?|i get|seeing|shows?|showing|says)\b/ },
  { id: 'others-too', weight: 1, pattern: /\banyone else\b/ },
];

/** An error literal is matched on the raw text: its casing is the signal. */
const ERROR_LITERAL: Feature = {
  id: 'error-literal',
  weight: 2,
  pattern: /`[^`]*(?:error|exception|undefined|null)[^`]*`|\b[A-Z][A-Za-z]*(?:Error|Exception)\b/i,
};

/** Evidence the post is something else: a question, a request, news, social chat, planning. */
const NEGATIVE: readonly Feature[] = [
  {
    id: 'how-to-question',
    weight: -3,
    pattern: /^(?:how (?:do|can|should|to|does)|where (?:can|do|is|are)|what(?:'s| is| are| time)|which|is there|is it possible|is the|are there|does (?:the|it|our|anyone)|do (?:we|you|i)|can (?:we|you|i|someone|anyone)|could (?:you|we|someone)|any idea|who(?:'s| is| owns)?\b|has the|have we|anyone know)/,
  },
  {
    id: 'request',
    weight: -3,
    pattern: /\b(?:would be (?:great|nice|cool|useful)|it'?d be (?:great|nice)|feature (?:request|idea)|we should|let'?s|can we (?:get|add|have)|on the roadmap|what if|idea:|brainstorm|wishlist|please add|could we)\b/,
  },
  {
    id: 'resolution',
    weight: -3,
    pattern: /\b(?:fixed|shipped|shipping|resolved|hotfix|deployed|release notes|postmortem|post-mortem|is green|green again|root cause was|ships? (?:in|tomorrow|today)|dropped to|after the (?:fix|hotfix)|deprecat(?:ed|ing))\b/,
  },
  {
    id: 'social',
    weight: -2,
    pattern: /\b(?:thanks?|thank you|congrats|congratulations|welcome (?:our|to|aboard|back)|great work|nice work|love the|happy|good morning|lunch|reminder:|remember to|standup|meeting|slides|survey|demo|presenting)/,
  },
  { id: 'review', weight: -2, pattern: /\b(?:pr|pull request|reviews?|merge)\b/ },
  { id: 'future', weight: -2, pattern: /\b(?:next sprint|will (?:tackle|look)|i'?ll (?:look|be)|we'?ll|plan(?:ning)? to|going to|thinking about)\b/ },
];

export interface ChatBugScore {
  score: number;
  /** Feature ids that fired, in evaluation order (negative ones included). */
  features: string[];
  suggest: boolean;
  version: string;
}

/** Strips what is not the author's own prose: mentions, channel refs, links, code fences. */
function prose(text: string): string {
  return text
    .replace(/<[@#!][^>]*>/g, ' ')
    .replace(/<https?:[^>]*>|https?:\/\/\S+/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Scores one chat post. Pure and deterministic. */
export function scoreChatBugLikelihood(text: string): ChatBugScore {
  const raw = prose(text);
  const lower = raw.toLowerCase().replace(/[’‘]/g, "'");
  const fired: string[] = [];
  let score = 0;
  for (const feature of POSITIVE) {
    if (feature.pattern.test(lower)) {
      score += feature.weight;
      fired.push(feature.id);
    }
  }
  if (ERROR_LITERAL.pattern.test(raw)) {
    score += ERROR_LITERAL.weight;
    fired.push(ERROR_LITERAL.id);
  }
  for (const feature of NEGATIVE) {
    if (feature.pattern.test(lower)) {
      score += feature.weight;
      fired.push(feature.id);
    }
  }
  return { score, features: fired, suggest: score >= CHAT_BUG_SUGGEST_THRESHOLD, version: CHAT_BUG_CLASSIFIER_VERSION };
}
