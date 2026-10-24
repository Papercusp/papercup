type AttentionRow = { id: string; kind: string; ref: Record<string, unknown> };

/** Full attention feed contract used by the native delivery rehearsal. */
export function ownerQuestionDelivery(value: unknown, msgId: string, conversationId: string) {
  const root = value as { data?: unknown; groups?: unknown; refs?: unknown } | null;
  const data = root?.data ?? root;
  const groups = Array.isArray(data) ? data : (data as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) {
    throw new Error('Owner-question delivery requires the full plans:attention feed; compact refs omit kind/ref.');
  }
  const rows = groups.flatMap((group) => {
    if (!group || !Array.isArray(group.items)) return [];
    return group.items.filter((item: AttentionRow) => item && typeof item.id === 'string'
      && typeof item.kind === 'string' && item.ref && typeof item.ref === 'object') as AttentionRow[];
  });
  return {
    choice: rows.find((item) => item.ref.msgId === msgId) ?? null,
    question: rows.find((item) => item.ref.conversationId === conversationId) ?? null,
  };
}
