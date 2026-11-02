import { parsePlan } from './parser';

/** Execution scope excludes progress, but includes decisions and dependencies. */
export function planExecutionMeaning(content: string): string {
  const parsed = parsePlan(content);
  const { status: _status, updated: _updated, ...frontmatter } = parsed.frontmatter.raw;
  let body = parsed.prose;
  if (parsed.now) body = body.replace(parsed.now.raw, '');
  for (const item of parsed.items) body = body.replace(item.rawLine,
    item.rawLine.replace(/`[a-z-]+`/, item.storedStatus === 'dropped' ? '`dropped`' : '`live`'));
  return JSON.stringify([Object.entries(frontmatter).sort(), body.replace(/\s+/g, ' ').trim()]);
}
