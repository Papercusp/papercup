import { existsSync } from 'node:fs';
import { join } from 'node:path';

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

/** One enrollment contract for the canonical home writer and rolling-upgrade repair. */
export function codexManagedTurnHooks({ provenanceOwner, journalOwner, hookDir, provenanceDir }) {
  return [
    { event: 'UserPromptSubmit', script: 'userpromptsubmit-provenance.sh', owner: provenanceOwner,
      marker: `PAPERCUSP_TURN_PROVENANCE_DIR=${quote(provenanceDir)}` },
    { event: 'Stop', script: 'stop-turn-journal.sh', owner: journalOwner,
      marker: 'PAPERCUSP_JOURNAL_SYNC=1' },
  ].filter(row => row.owner && existsSync(join(hookDir, row.script))).map(row => ({
    ...row,
    group: { matcher: '.*', hooks: [{ type: 'command',
      command: `PAPERCUSP_SID=${quote(row.owner)} PAPERCUSP_AGENT=codex ${row.marker} ${quote(join(hookDir, row.script))}` }] },
  }));
}
