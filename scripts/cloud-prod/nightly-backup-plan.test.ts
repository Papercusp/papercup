import { describe, expect, it } from 'vitest';
import { buildNightlyBackupPlan, BACKUP_COMPLETION_METRIC } from './nightly-backup-plan';

const input = { backupProject:'papercusp-cloud-backup',bucket:'papercusp-cloud-backup-exports',
  cloudSqlServiceAccount:'p46711101119-ook5aw@gcp-sa-cloud-sql.iam.gserviceaccount.com',
  notificationChannels:['projects/papercusp-cloud-backup/notificationChannels/123'],retentionDays:7 };

describe('independent backup storage boundary', () => {
  it('refuses production-project storage and missing alert recipients before producing a plan', () => {
    expect(()=>buildNightlyBackupPlan({...input,backupProject:'papercusp-cloud-prod'})).toThrow('separate');
    expect(()=>buildNightlyBackupPlan({...input,notificationChannels:[]})).toThrow('notification_channels');
    expect(()=>buildNightlyBackupPlan({...input,notificationChannels:['projects/other/notificationChannels/123']})).toThrow('notification_channels');
  });
  it('separates scheduler, exporter, SQL writer and custodian without private keys or hosted-runtime grants', () => {
    const plan=buildNightlyBackupPlan(input);
    expect(new Set(Object.values(plan.identities)).size).toBe(4);
    const commands=plan.commands.map(c=>c.join(' '));
    expect(commands.some(c=>c.includes('roles/storage.objectCreator'))).toBe(true);
    expect(commands.some(c=>c.includes('pc-backup-custodian')&&c.includes('roles/storage.admin'))).toBe(true);
    expect(commands.some(c=>/keys create|pc-hosted-control-plane|roles\/editor|roles\/owner/.test(c))).toBe(false);
    expect(plan.role.includedPermissions).not.toContain('cloudsql.instances.delete');
    expect(plan.role.includedPermissions).not.toContain('cloudsql.instances.restoreBackup');
  });
});

describe('export completion detector', () => {
  it('does not signal completion until a successful DONE operation; bounds polling', () => {
    const plan=buildNightlyBackupPlan(input);
    const iteration=plan.workflowSource.main.steps[1]!.exportDatabases!.for.steps;
    const switchStep=iteration[3]!.inspectOperation!.switch;
    expect(switchStep[0]!.raise).toBe('cloud_sql_export_failed');
    expect(switchStep[1]!.next).toBe('recordCompletion');
    expect(switchStep[2]!.raise).toBe('cloud_sql_export_deadline_exceeded');
    expect(JSON.stringify(iteration[5])).toContain(BACKUP_COMPLETION_METRIC);
    expect(plan.alertPolicies).toHaveLength(3);
    expect(plan.alertPolicies.every(p=>p.enabled&&p.conditions[0]!.conditionAbsent.duration==='93600s')).toBe(true);
  });
  it('uses unique gzipped SQL exports and enumerates every production database', () => {
    const plan=buildNightlyBackupPlan(input);
    expect(plan.workflowSource.main.steps[0]!.initialize!.assign[0]!.databases).toEqual(['papercusp_hosted','portal','dbos_system']);
    const exportContext=plan.workflowSource.main.steps[1]!.exportDatabases!.for.steps[0]!.startExport!.args.body.exportContext;
    expect(exportContext.uri).toContain('execution');
    expect(exportContext.uri).toContain('.sql.gz');
    expect(exportContext.offload).toBe(false);
    expect(plan.commands.at(-1)).toContain('--schedule=0 7 * * *');
  });
});
