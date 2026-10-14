/** P-009 cloud-owned logical export configuration. Pure builder: materializes
 * no resources, changes no IAM and arms no schedule. Reuses PROD_SPEC and the
 * Cloud SQL export API; runs outside the dev-box operator routine engine.
 * A separate project owns backup storage and workflow/scheduler identities.
 */
import { PROD_SPEC, type CloudSqlProdSpec } from './provision-cloud-sql';

export const BACKUP_COMPLETION_METRIC = 'custom.googleapis.com/papercusp/backup/export_completed';
const expression = (value: string) => '${' + value + '}';

export interface BackupPlanOptions {
  backupProject: string;
  bucket: string;
  cloudSqlServiceAccount: string;
  /** Existing, owner-approved Cloud Monitoring notification channels. */
  notificationChannels: string[];
  /** P-011 must approve customer-data retention before this config is deployed. */
  retentionDays: number;
  spec?: CloudSqlProdSpec;
}

export function buildNightlyBackupPlan(options: BackupPlanOptions) {
  const spec = options.spec ?? PROD_SPEC;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.backupProject) || options.backupProject === spec.project)
    throw new Error('backup_project_must_be_separate');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error('backup_bucket_invalid');
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(options.cloudSqlServiceAccount)) throw new Error('backup_sql_identity_invalid');
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 7 || options.retentionDays > 365) throw new Error('backup_retention_invalid');
  if (!options.notificationChannels.length || options.notificationChannels.some(ref => !new RegExp(`^projects/${options.backupProject}/notificationChannels/[0-9]+$`).test(ref)))
    throw new Error('backup_notification_channels_required');
  const workflow = 'pc-nightly-cloud-sql-export';
  const job = 'pc-nightly-cloud-sql-export';
  const exporter = `pc-backup-export@${options.backupProject}.iam.gserviceaccount.com`;
  const scheduler = `pc-backup-schedule@${options.backupProject}.iam.gserviceaccount.com`;
  const custodian = `pc-backup-custodian@${options.backupProject}.iam.gserviceaccount.com`;
  const workflowName = `projects/${options.backupProject}/locations/${spec.region}/workflows/${workflow}`;
  const sqlBase = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${spec.project}`;
  const workflowSource = {
    main: { steps: [
      { initialize: { assign: [
        { databases: [...spec.databases] }, { bucket: options.bucket },
        { execution: expression('sys.get_env("GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID")') },
      ] } },
      { exportDatabases: { for: { value: 'database', in: expression('databases'), steps: [
        { startExport: { call: 'http.post', args: {
          url: `${sqlBase}/instances/${spec.instance}/export`, auth: { type: 'OAuth2' },
          body: { exportContext: { fileType: 'SQL', databases: [expression('database')],
            uri: expression('"gs://" + bucket + "/" + execution + "/" + database + ".sql.gz"'), offload: false } },
        }, result: 'exportOperation' } },
        { setDeadline: { assign: [{ deadline: expression('sys.now() + 1800') }] } },
        { pollOperation: { call: 'http.get', args: {
          url: expression(JSON.stringify(`${sqlBase}/operations/`) + ' + exportOperation.body.name'), auth: { type: 'OAuth2' },
        }, result: 'operationState' } },
        { inspectOperation: { switch: [
          { condition: expression('map.get(operationState.body, "error") != null'), raise: 'cloud_sql_export_failed' },
          { condition: expression('operationState.body.status == "DONE"'), next: 'recordCompletion' },
          { condition: expression('sys.now() > deadline'), raise: 'cloud_sql_export_deadline_exceeded' },
        ] } },
        { sleepBeforePoll: { call: 'sys.sleep', args: { seconds: 15 }, next: 'pollOperation' } },
        // Only a settled successful operation produces the detector signal.
        { recordCompletion: { call: 'http.post', args: {
          url: `https://monitoring.googleapis.com/v3/projects/${options.backupProject}/timeSeries`, auth: { type: 'OAuth2' },
          body: { timeSeries: [{ metric: { type: BACKUP_COMPLETION_METRIC, labels: { database: expression('database') } },
            resource: { type: 'global', labels: { project_id: options.backupProject } }, metricKind: 'GAUGE', valueType: 'DOUBLE',
            points: [{ interval: { endTime: expression('time.format(sys.now())') }, value: { doubleValue: 1 } }],
          }] },
        } } },
      ] } } },
      { finished: { return: { exported: expression('databases'), execution: expression('execution') } } },
    ] },
  };
  const role = { title: 'Papercusp backup export only', stage: 'GA',
    includedPermissions: ['cloudsql.instances.export', 'cloudsql.instances.get', 'cloudsql.operations.get'] };
  const alertPolicies = spec.databases.map(database => ({
    displayName: `Production backup stale: ${database}`, enabled: true, combiner: 'OR',
    notificationChannels: options.notificationChannels,
    documentation: { mimeType: 'text/markdown', content: `No successful logical export for ${database} within 26 hours. Check the nightly workflow's failed execution and Cloud SQL operation. A stored object or attempted export is insufficient. Follow the P-009 backup runbook.` },
    conditions: [{ displayName: `No completed export: ${database}`, conditionAbsent: {
      filter: `metric.type="${BACKUP_COMPLETION_METRIC}" AND resource.type="global" AND metric.labels.database="${database}"`,
      duration: '93600s', aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_MAX' }], trigger: { count: 1 },
    } }],
  }));
  const lifecycle = { rule: [{ action: { type: 'Delete' }, condition: { age: options.retentionDays } }] };
  const projectFlag = `--project=${options.backupProject}`;
  // These are argv arrays, never shell strings. No command exports credentials,
  // grants the hosted runtime access, or grants the exporter delete/restore rights.
  const commands = [
    ['services', 'enable', 'workflows.googleapis.com', 'workflowexecutions.googleapis.com', 'cloudscheduler.googleapis.com', 'monitoring.googleapis.com', projectFlag],
    ...['pc-backup-export', 'pc-backup-schedule', 'pc-backup-custodian'].map(name => ['iam', 'service-accounts', 'create', name, projectFlag]),
    ['storage', 'buckets', 'create', `gs://${options.bucket}`, projectFlag, `--location=${spec.region}`,
      '--uniform-bucket-level-access', '--public-access-prevention', '--retention-period=7d', '--lifecycle-file=backup-lifecycle.json'],
    ['storage', 'buckets', 'add-iam-policy-binding', `gs://${options.bucket}`, `--member=serviceAccount:${options.cloudSqlServiceAccount}`, '--role=roles/storage.objectCreator'],
    ['storage', 'buckets', 'add-iam-policy-binding', `gs://${options.bucket}`, `--member=serviceAccount:${custodian}`, '--role=roles/storage.admin'],
    ['iam', 'roles', 'create', 'pcBackupExport', `--project=${spec.project}`, '--file=backup-export-role.json'],
    ['projects', 'add-iam-policy-binding', spec.project, `--member=serviceAccount:${exporter}`, `--role=projects/${spec.project}/roles/pcBackupExport`, '--condition=None'],
    ['projects', 'add-iam-policy-binding', options.backupProject, `--member=serviceAccount:${exporter}`, '--role=roles/monitoring.metricWriter', '--condition=None'],
    ['workflows', 'deploy', workflow, projectFlag, `--location=${spec.region}`, `--service-account=${exporter}`, '--source=backup-workflow.json', '--call-log-level=log-errors-only'],
    ['workflows', 'add-iam-policy-binding', workflow, projectFlag, `--location=${spec.region}`, `--member=serviceAccount:${scheduler}`, '--role=roles/workflows.invoker'],
    ['scheduler', 'jobs', 'create', 'http', job, projectFlag, `--location=${spec.region}`, '--schedule=0 7 * * *', '--time-zone=Etc/UTC',
      `--uri=https://workflowexecutions.googleapis.com/v1/${workflowName}/executions`, '--http-method=POST', '--message-body={}',
      `--oauth-service-account-email=${scheduler}`, '--max-retry-attempts=0'],
  ];
  return { mode: 'preview-only', backupProject: options.backupProject, bucket: options.bucket,
    identities: { exporter, scheduler, custodian, sqlWriter: options.cloudSqlServiceAccount },
    workflowSource, role, lifecycle, alertPolicies, commands,
    prerequisites: ['Existing separately administered backup project and billing attachment',
      'P-011 owner-approved retentionDays', 'Verified owner notification channels',
      'Idempotent provisioning + readback before applying commands',
      'Seed a successful export metric for each database, then prove the absence alarm',
      'Restore and verify one logical export; IAM and Cloud Scheduler readback'],
  };
}
