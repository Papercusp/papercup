/** Independently labelled evaluation population, declared before measuring this
 * edition. Calibration passages (soleOwner, observe, model migration) are
 * deliberately excluded. Labels describe expertise; scores never set labels. */
export const HELD_OUT_SUBJECT_CASES = [
  { id: 'gui-paraphrase', subject: 'computer:provision_desktop', relevant: ['display-repair'], passages: [
    { id: 'display-repair', text: 'A sandbox display was still registered after its X server died. I verified the dead process, retired its lease and created a new isolated screen for the browser.' },
    { id: 'checkpoint-owner', text: 'I fixed the green checkpoint ownership claim. Only the elected release fixer should rerun the suite and promote the green commit.' },
  ] },
  { id: 'gui-no-expert', subject: 'computer:provision_desktop', relevant: [], passages: [
    { id: 'gate-policy', text: 'The release gate is held by another live agent. Send evidence once and stop running parallel checkpoint monitors.' },
    { id: 'memory-policy', text: 'A durable memory fact belongs in the shared store, while checkpoints hold the current lane and recovery context.' },
  ] },
  { id: 'widgets-paraphrase', subject: 'computer:observe', relevant: ['widget-reader'], passages: [
    { id: 'widget-reader', text: 'I repaired AT-SPI traversal so the application exposes focused controls, labels and widget roles. Each accessible element has a stable reference for activation.' },
    { id: 'deployment-monitor', text: 'I observe release telemetry and monitor the green checkpoint before deciding whether the deployment is stalled.' },
  ] },
  { id: 'database-paraphrase', subject: 'db:migrate', relevant: ['schema-author'], passages: [
    { id: 'schema-author', text: 'I applied a numbered DDL change to PostgreSQL after obtaining the schema lease. The database version ledger records the transaction and rollback procedure.' },
    { id: 'model-worker', text: 'I migrated the inference worker to another model endpoint. The scheduler drains prompts and preserves the account cache before switching model providers.' },
  ] },
  { id: 'database-no-expert', subject: 'db:migrate', relevant: [], passages: [
    { id: 'provider-change', text: 'The model migration changes provider credentials and inference routing. I moved generation calls to a new gateway and validated token usage.' },
    { id: 'fleet-transition', text: 'Migrate the headless fleet to the next account by restarting its inference sessions; retain warm carry across agent wakes.' },
  ] },
] as const;
