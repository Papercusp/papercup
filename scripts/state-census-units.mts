#!/usr/bin/env -S npx tsx
/** Read-only unit-plane census. This is NOT a whole-install completion verdict. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { generateStateCensus } from '../packages/backup/src/state-census';
import { unitCensusEntries, unitCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';

if (process.platform !== 'linux') throw new Error('Systemd census requires Linux');
const scope = process.argv.includes('--system') ? 'system' : 'user';
const runtime = scope === 'system' ? '/run/systemd' : `/run/user/${process.getuid!()}/systemd`;
const sources = scope === 'system'
  ? ['/usr/lib/systemd/system', '/etc/systemd/system', '/run/systemd/system']
  : [join(homedir(), '.config/systemd/user'), '/usr/lib/systemd/user', '/etc/systemd/user'];
sources.push(...['generator', 'generator.early', 'generator.late'].map(name => join(runtime, name)));
const declarations = [];
for (const source of [...sources, join(runtime, 'transient')]) {
  try { await stat(source); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  declarations.push(...await unitCensusDeclarations(source, scope,
    source === join(runtime, 'transient') ? 'dev-only' : 'config'));
}
const census = generateStateCensus(await unitCensusEntries(scope), declarations);
console.log(JSON.stringify({ scope: `systemd-${scope}-only`, ...census }, null, 2));
if (!census.ok) process.exitCode = 1;
