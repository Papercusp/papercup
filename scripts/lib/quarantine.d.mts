/**
 * Parse quarantine.txt content into the set of BARE (fully-quarantined)
 * workspace names. Per-file `workspace::glob` lines are deliberately excluded.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseQuarantineWorkspaces(text: string): Set<string>;
