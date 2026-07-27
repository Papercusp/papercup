/**
 * EI-18808675015292160 — the fixture migration-list auditor.
 *
 * Pure tests (no Docker, no PG): every case below is a real shape taken from
 * libs/papercusp/libs/db/sql, because the two narrowings this auditor makes were
 * each forced by a specific migration that broke the naive rule.
 */
import { describe, expect, it } from 'vitest';
import {
  auditMigrationList,
  formatStaleMigrationList,
  migrationNumber,
  stripSqlComments,
  tablesTouchedBySql,
} from '../test/_pg-helpers';

describe('tablesTouchedBySql', () => {
  it('picks up CREATE TABLE and ALTER TABLE, with or without IF [NOT] EXISTS', () => {
    expect(tablesTouchedBySql('CREATE TABLE harness_shared.agent_facts (id int);')).toEqual(
      new Set(['harness_shared.agent_facts']),
    );
    expect(tablesTouchedBySql('CREATE TABLE IF NOT EXISTS harness_shared.a (id int);')).toEqual(
      new Set(['harness_shared.a']),
    );
    expect(tablesTouchedBySql('ALTER TABLE IF EXISTS harness_shared.b ADD COLUMN c text;')).toEqual(
      new Set(['harness_shared.b']),
    );
  });

  it('ignores a table named only in a comment — the naive "scan for the name" rule', () => {
    const sql = `
      -- this migration relates to harness_shared.agent_facts but does not touch it
      /* nor does harness_shared.carry_notes appear outside prose */
      CREATE TABLE harness_shared.something_else (id int);
    `;
    expect(tablesTouchedBySql(sql)).toEqual(new Set(['harness_shared.something_else']));
  });

  it('ignores a passing reference that is not a CREATE/ALTER TABLE — the 214 trap', () => {
    // 214 attaches triggers to tables a partial fixture does not have. Matching
    // mere mentions pulled it in, and applying it failed wholesale.
    const sql = `CREATE TRIGGER t BEFORE INSERT ON harness_shared.harness_plans
                 FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();`;
    expect(tablesTouchedBySql(sql)).toEqual(new Set());
  });
});

describe('stripSqlComments / migrationNumber', () => {
  it('strips both comment forms', () => {
    expect(stripSqlComments('a -- b\nc /* d */ e').replace(/\s+/g, ' ').trim()).toBe('a c e');
  });
  it('reads the leading migration number, and refuses a non-numbered file', () => {
    expect(migrationNumber('689-agent-facts-append-versioning.sql')).toBe(689);
    expect(migrationNumber('000-baseline.sql')).toBe(0);
    expect(migrationNumber('no-number.sql')).toBeNull();
  });
});

/** The real shape: a fixture builds agent_facts from an old list. */
const MIGRATIONS: [string, string][] = [
  ['444-agent-facts.sql', 'CREATE TABLE harness_shared.agent_facts (key text);'],
  ['505-agent-facts-surrogate-pk.sql', 'ALTER TABLE harness_shared.agent_facts ADD COLUMN id bigserial;'],
  ['488-federated-rls-backstop.sql',
    `ALTER TABLE harness_shared.agent_facts ENABLE ROW LEVEL SECURITY;
     ALTER TABLE harness_shared.bee_claim_specs ENABLE ROW LEVEL SECURITY;`],
  ['498-agent-facts-replica-identity.sql', 'ALTER TABLE harness_shared.agent_facts REPLICA IDENTITY FULL;'],
  ['689-agent-facts-append-versioning.sql', 'ALTER TABLE harness_shared.agent_facts ADD COLUMN superseded_at timestamptz;'],
  ['610-push-delivery.sql', 'CREATE TABLE harness_shared.push_delivery (id int);'],
  ['650-push-delivery-extra.sql', 'ALTER TABLE harness_shared.push_delivery ADD COLUMN extra text;'],
];

describe('auditMigrationList', () => {
  it('catches the exact rot that cost 9 red tests: a list stopping before later columns', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const files = audit.missing.map((m) => m.file);
    expect(files).toContain('505-agent-facts-surrogate-pk.sql');
    expect(files).toContain('689-agent-facts-append-versioning.sql');
    expect(audit.tables).toEqual(['harness_shared.agent_facts']);
  });

  it('does NOT demand a WIDE migration a partial fixture could never apply', () => {
    // 488 touches agent_facts AND bee_claim_specs. A fixture that only builds
    // agent_facts cannot apply it, so requiring it would be an unfixable error.
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('488-federated-rls-backstop.sql');
    expect(audit.wider.map((m) => m.file)).toContain('488-federated-rls-backstop.sql');
  });

  it('is silent when the list is complete', () => {
    const audit = auditMigrationList(
      [
        '444-agent-facts.sql',
        '498-agent-facts-replica-identity.sql',
        '505-agent-facts-surrogate-pk.sql',
        '689-agent-facts-append-versioning.sql',
      ],
      MIGRATIONS,
    );
    expect(audit.missing).toEqual([]);
  });

  it('ignores migrations for tables the fixture does not build', () => {
    const audit = auditMigrationList(['444-agent-facts.sql', '689-agent-facts-append-versioning.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('610-push-delivery.sql');
  });

  it('does not flag OLDER omissions — deliberately skipping an earlier migration is a choice, not rot', () => {
    // 498 is older than the newest declared (689) and omitted on purpose.
    const audit = auditMigrationList(['444-agent-facts.sql', '689-agent-facts-append-versioning.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('498-agent-facts-replica-identity.sql');
  });

  it('uses a PER-TABLE watermark, so a gap cannot hide behind a newer unrelated migration', () => {
    // The list carries 689 (agent_facts) and 610 (push_delivery). 650 alters
    // push_delivery. A single GLOBAL "newest declared" watermark would be 689
    // and would silently skip 650 — the exact silent rot this exists to stop.
    const audit = auditMigrationList(
      ['444-agent-facts.sql', '689-agent-facts-append-versioning.sql', '610-push-delivery.sql'],
      MIGRATIONS,
    );
    expect(audit.missing.map((m) => m.file)).toContain('650-push-delivery-extra.sql');
    expect(audit.missing.find((m) => m.file === '650-push-delivery-extra.sql')?.tables).toEqual([
      'harness_shared.push_delivery',
    ]);
  });

  it('reports missing files in numeric order', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const nums = audit.missing.map((m) => migrationNumber(m.file));
    expect(nums).toEqual([...nums].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe('formatStaleMigrationList', () => {
  it('names the FILE and the TABLE — the thing the column-level error never did', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const msg = formatStaleMigrationList(audit, 'dead-end-matcher-io');
    expect(msg).toContain('dead-end-matcher-io');
    expect(msg).toContain('STALE');
    expect(msg).toContain('689-agent-facts-append-versioning.sql');
    expect(msg).toContain('harness_shared.agent_facts');
    // the wide one appears as advisory context, clearly not as the fix
    expect(msg).toContain('488-federated-rls-backstop.sql');
    expect(msg).toContain('FYI only');
  });
});

describe('the REAL migration directory', () => {
  it('audits a real fixture list against the real sql/ dir without throwing', async () => {
    // Guards the parsing against the actual corpus (565 files): a regex that
    // blew up or matched nothing would surface here, not in a fixture months on.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../libs/papercusp/libs/db/sql',
    );
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')] as [string, string]);
    expect(all.length).toBeGreaterThan(100);

    const audit = auditMigrationList(['444-agent-facts.sql'], all);
    // The real corpus must yield a non-empty table set and find real later work.
    expect(audit.tables).toContain('harness_shared.agent_facts');
    expect(audit.missing.length + audit.wider.length).toBeGreaterThan(0);
  });
});
