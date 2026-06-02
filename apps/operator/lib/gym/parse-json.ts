/**
 * Recover a JSON object from an LLM reply that may be bare, ```-fenced, or wrapped
 * in prose. Pure + dependency-free on purpose: the gym's scoring/parsing modules
 * must NOT pull in the operator's credentials / workspace-registry module graph
 * (which `llm-testing/llm-client` drags in). Mirrors that module's `tryParseJson`.
 */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* unrecoverable */
    }
  }
  return null;
}
