/**
 * Pure utilities for the docs:* tool family.
 *
 * Kept free of fumadocs imports so the unit tests don't need to spin
 * up the loader. The tools (outline.ts, get.ts) compose these against
 * `source` from @/lib/source.
 */

export const MAX_PAYLOAD_BYTES = 50_000;

/** TOC entry shape we care about — narrower than fumadocs' full type. */
export interface TocEntry {
  url: string; // '#anchor-id'
  title: unknown; // string OR React element
  depth: number;
}

/**
 * Recursively extract plain text from a value that may be a string,
 * number, array, or React-element-shaped object (`{ props: { children } }`).
 *
 * Required because fumadocs' TOC sometimes yields React elements when
 * a heading contains inline code or other inline JSX — and `String(node)`
 * on those returns "[object Object]".
 */
export function reactToText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactToText).join('');
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return reactToText(props?.children);
  }
  return '';
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Title-case a kebab-case slug. Fallback when meta.json has no title. */
export function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Bounded Levenshtein distance. Short-circuits on length > 100 to keep
 * O(n*m) bounded — doc slugs are short, so this is purely defensive.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 100 || b.length > 100) return Infinity;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export interface NearestOpts {
  /** distance / max(target.length, candidate.length) must be ≤ this. Default 0.3. */
  maxRatio?: number;
  /** Max returned. Default 3. */
  k?: number;
}

export function levenshteinNearest(
  target: string,
  candidates: string[],
  opts: NearestOpts = {},
): string[] {
  const maxRatio = opts.maxRatio ?? 0.3;
  const k = opts.k ?? 3;
  return candidates
    .map((s) => ({ s, d: levenshtein(s, target) }))
    .filter(({ s, d }) => d !== Infinity && d / Math.max(s.length, target.length || 1) <= maxRatio)
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map(({ s }) => s);
}

/**
 * Slice markdown body to the section starting at `headingId` and ending
 * at the next heading of equal-or-shallower depth (or EOF).
 *
 * Returns null when the TOC entry is missing or the heading line can't
 * be located in the rendered markdown.
 */
export function sliceByHeading(md: string, headingId: string, toc: TocEntry[]): string | null {
  const target = toc.find((h) => (h.url ?? '').replace(/^#/, '') === headingId);
  if (!target) return null;

  const text = reactToText(target.title);
  if (!text) return null;

  const headerRe = new RegExp(`^#{${target.depth}}\\s+${escapeRegex(text)}\\s*$`, 'm');
  const startMatch = md.match(headerRe);
  if (!startMatch || startMatch.index === undefined) return null;

  const start = startMatch.index;
  const afterStart = md.slice(start + startMatch[0].length);
  const nextRe = new RegExp(`^#{1,${target.depth}}\\s+`, 'm');
  const nextMatch = afterStart.match(nextRe);
  const end =
    nextMatch?.index !== undefined ? start + startMatch[0].length + nextMatch.index : md.length;

  return md.slice(start, end).trim();
}

export function truncationTail(args: { firstH2Id?: string; h2Count: number }): string {
  if (args.firstH2Id) {
    return `\n\n…[truncated at ${MAX_PAYLOAD_BYTES} bytes; this page has ${args.h2Count} H2 headings — re-fetch with heading="${args.firstH2Id}" (or another id from docs:outline) for a slice]\n`;
  }
  return `\n\n…[truncated at ${MAX_PAYLOAD_BYTES} bytes; page has no H2 headings to slice on]\n`;
}
