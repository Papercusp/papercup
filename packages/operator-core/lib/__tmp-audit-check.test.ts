import { describe, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMigrationList, formatStaleMigrationList } from '../test/_pg-helpers';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');
const all = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => [f, readFileSync(resolve(DIR, f), 'utf8')] as [string, string]);

const fixtures: Record<string, string[]> = {
  'dead-end-matcher-io': ['609-session-cursor.sql','444-agent-facts.sql','455-agent-facts-shareable.sql','461-agent-facts-federation.sql','462-agent-facts-fed-key.sql','505-agent-facts-surrogate-pk-replica-identity.sql','574-agent-facts-audience-provenance.sql','664-widen-fact-body-cap.sql','671-add-agent-facts-confidence.sql','689-agent-facts-append-versioning.sql','690-agent-facts-depends-on-kind-claim.sql','692-agent-facts-convention-enforcement.sql','693-agent-facts-federation-stamp-regime.sql','610-push-delivery.sql'],
  'ambient-acceptance-drills': ['605-session-turn-journal.sql','609-session-cursor.sql','610-push-delivery.sql','612-collision-hysteresis.sql','444-agent-facts.sql','455-agent-facts-shareable.sql','461-agent-facts-federation.sql','462-agent-facts-fed-key.sql','505-agent-facts-surrogate-pk-replica-identity.sql','574-agent-facts-audience-provenance.sql','664-widen-fact-body-cap.sql','671-add-agent-facts-confidence.sql','689-agent-facts-append-versioning.sql','690-agent-facts-depends-on-kind-claim.sql','692-agent-facts-convention-enforcement.sql','693-agent-facts-federation-stamp-regime.sql'],
  'peer-surface-source': ['143-agent-activity.sql','188-work-item-claims.sql','472-carry-notes.sql','680-carry-note-declared-deps.sql','605-session-turn-journal.sql','609-session-cursor.sql','610-push-delivery.sql'],
};

describe('TMP audit of real fixture lists', () => {
  it('prints the verdict', () => {
    for (const [name, list] of Object.entries(fixtures)) {
      const a = auditMigrationList(list, all);
      console.log(`\n##### ${name}: missing=${a.missing.length} wider=${a.wider.length}`);
      console.log(`  tables: ${a.tables.join(', ')}`);
      if (a.missing.length) console.log(formatStaleMigrationList(a, name));
      else console.log('  OK list COMPLETE - conversion will not throw');
    }
  });
});
