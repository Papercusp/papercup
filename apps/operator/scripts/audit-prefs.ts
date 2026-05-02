#!/usr/bin/env -S npx tsx
/**
 * audit-prefs — CLI for reviewing + curating Operator's preferences.md.
 *
 *   npx tsx apps/operator/scripts/audit-prefs.ts list
 *   npx tsx apps/operator/scripts/audit-prefs.ts list --filter user-typed
 *   npx tsx apps/operator/scripts/audit-prefs.ts list --filter operator-proposed
 *   npx tsx apps/operator/scripts/audit-prefs.ts remove <key>
 *   npx tsx apps/operator/scripts/audit-prefs.ts purge --before 2026-01-01
 *
 * For users with 50+ entries the per-entry settings UI gets unwieldy;
 * this CLI does the same operations against `preferences.md` directly.
 */

import {
  listPreferenceEntries,
  removePreferenceEntry,
} from '../lib/operator-preferences';

const [, , cmd, ...rest] = process.argv;

function listCmd() {
  const filterIdx = rest.indexOf('--filter');
  const filter = filterIdx >= 0 ? rest[filterIdx + 1] : 'all';
  let entries = listPreferenceEntries();
  if (filter === 'user-typed') {
    entries = entries.filter((e) => e.tags.includes('USER-TYPED'));
  } else if (filter === 'operator-proposed') {
    entries = entries.filter((e) => e.tags.some((t) => t.startsWith('OPERATOR-PROPOSED')));
  }
  if (!entries.length) {
    console.log('(no entries)');
    return;
  }
  for (const e of entries) {
    console.log(`\n[${e.key}] ${e.date} · ${e.tags.join(' ')}`);
    console.log(e.body);
  }
}

function removeCmd() {
  const key = rest[0];
  if (!key) {
    console.error('usage: audit-prefs remove <key>');
    process.exit(1);
  }
  const ok = removePreferenceEntry(key);
  if (!ok) {
    console.error(`no entry with key=${key}`);
    process.exit(1);
  }
  console.log(`removed ${key}`);
}

function purgeCmd() {
  const beforeIdx = rest.indexOf('--before');
  const before = beforeIdx >= 0 ? rest[beforeIdx + 1] : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error('usage: audit-prefs purge --before YYYY-MM-DD');
    process.exit(1);
  }
  const cutoff = new Date(`${before}T00:00:00.000Z`).getTime();
  const entries = listPreferenceEntries();
  let removed = 0;
  for (const e of entries) {
    if (new Date(e.addedAt).getTime() < cutoff) {
      if (removePreferenceEntry(e.key)) removed++;
    }
  }
  console.log(`removed ${removed} entries with date < ${before}`);
}

switch (cmd) {
  case 'list':
    listCmd();
    break;
  case 'remove':
    removeCmd();
    break;
  case 'purge':
    purgeCmd();
    break;
  default:
    console.error('usage: audit-prefs <list|remove|purge> [...args]');
    process.exit(1);
}
