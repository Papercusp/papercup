/**
 * Tiny presentation helpers shared by the capability adapters.
 */

/** `'features:get'` / `'panel.toggle'` → `'Get'` / `'Toggle'` (last segment, title-cased). */
export function humanizeCapabilityId(id: string): string {
  const verb = id.includes(':') ? id.split(':').pop()! : id.split('.').pop()!;
  return verb
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Clamp a (possibly long, model-facing) description to a palette-subtitle length. */
export function shorten(text: string | undefined, max = 90): string {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}
