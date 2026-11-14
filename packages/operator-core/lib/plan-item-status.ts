/**
 * Pure plan-item status classification. Keep this separate from fleet-drain
 * orchestration so lightweight worker paths can use the terminal-state rule
 * without importing the host event and DBOS graph.
 */
export const TERMINAL_ITEM_STATUSES = ['done', 'dropped'] as const;

/** Is this stored item status terminal (the item is finished, held/assigned by no one)? */
export function isTerminalItemStatus(status: string): boolean {
  return (TERMINAL_ITEM_STATUSES as readonly string[]).includes(status);
}
