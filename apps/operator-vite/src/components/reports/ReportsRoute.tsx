import { useState } from 'react';
import { parseAsBoolean, parseAsString, useQueryStates } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@papercusp/flags/client';
import { TextInput } from '@papercusp/ui-primitives/controls';
import { Button } from '@/app/harness/Button';
import { Select } from '@/app/harness/Select';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';
import type { toReportFull, toReportSummary } from '@papercusp/operator-core/lib/agent-tools/reports/_shared';
import type { ReportKind, ReportVisibility, ReportSubjectKind } from '@papercusp/operator-core/lib/report-library';
import './ReportsRoute.css';

type Summary = ReturnType<typeof toReportSummary>;
type Full = ReturnType<typeof toReportFull>;
const kinds: ReportKind[] = ['audit', 'review', 'analysis', 'postmortem', 'status-digest', 'proposal', 'other'];
const visibility: ReportVisibility[] = ['owner', 'pot', 'workspace'];
const subjects: ReportSubjectKind[] = ['pot', 'plan', 'work_item', 'fleet', 'goal', 'repo', 'external', 'none'];
const parsers = { kind: parseAsString.withDefault(''), subject: parseAsString.withDefault(''),
  pot: parseAsString.withDefault(''), vis: parseAsString.withDefault(''), q: parseAsString.withDefault(''),
  tag: parseAsString.withDefault(''), since: parseAsString.withDefault(''), sel: parseAsString.withDefault(''),
  hist: parseAsBoolean.withDefault(false) };

function published(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function ReportsRoute() {
  const enabled = useFlag(FLAGS.REPORTS_LIBRARY);
  return enabled ? <ReportsLibrary /> : <main className="reports-page"><h1>Reports</h1><p>Reports library is disabled.</p></main>;
}

export function ReportsLibrary() {
  const [state, setState] = useQueryStates(parsers, { history: 'push' });
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [subjectKind, ...subjectRef] = state.subject.split(':');
  const kind = kinds.find(k => k === state.kind);
  const vis = visibility.find(v => v === state.vis);
  const subject = subjects.find(s => s === subjectKind);
  const since = state.since && !Number.isNaN(Date.parse(state.since)) ? new Date(state.since).toISOString() : undefined;
  const library = useSyncQuery<Summary>({ queryName: 'reports.list', args: {
    ...(kind ? { kind } : {}), ...(vis ? { visibility: vis } : {}),
    ...(subject ? { subject: { kind: subject, ...(subjectRef.length ? { ref: subjectRef.join(':') } : {}) } } : {}),
    ...(state.pot ? { originHarnessSlug: state.pot } : {}), ...(state.q ? { query: state.q } : {}),
    ...(state.tag ? { tags: state.tag.split(',').map(t => t.trim()).filter(Boolean) } : {}),
    ...(since ? { since } : {}), limit: 200,
  } });
  const detail = useSyncQuery<Full>({ queryName: 'reports.get', args: { reportId: state.sel || '__none__' }, enabled: !!state.sel });
  // A disabled or changing subscription may still hold its previous snapshot.
  const report = state.sel ? detail.data.find(row => row.report_id === state.sel) : undefined;
  const history = useSyncQuery<Summary>({ queryName: 'reports.lineage', args: { lineageId: report?.lineage_id || '__none__' },
    enabled: !!report && state.hist });
  const change = (key: keyof typeof state, value: string) => { void setState({ [key]: value }); };
  const options = (values: string[]) => [{ value: '__all__', label: 'All' }, ...values.map(value => ({ value, label: value }))];
  const select = (id: string) => { void setState({ sel: id }); setCopied(null); setCopyError(null); };
  async function copyReport() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(`# ${report.title}\n\n${report.body_md}`);
      setCopied(report.report_id); setCopyError(null);
    } catch { setCopyError('Could not copy the report. Try copying the text directly.'); }
  }
  return <main className="reports-page" data-testid="reports-library">
    <header className="reports-heading"><div><h1>Reports</h1><p>Audits, reviews and written work from your workspace.</p></div>
      <Button onClick={() => { void setState({ kind: '', subject: '', pot: '', vis: '', q: '', tag: '', since: '' }); }}>Clear filters</Button>
    </header>
    <form className="reports-filters" onSubmit={event => event.preventDefault()} aria-label="Report filters">
      <label>Search<TextInput aria-label="Search reports" value={state.q} placeholder="Words or exact phrases" maxLength={500} onChange={e => change('q', e.target.value)} /></label>
      <label>Kind<Select ariaLabel="Report kind" value={state.kind || '__all__'} options={options(kinds)} onChange={v => change('kind', v === '__all__' ? '' : v)} /></label>
      <label>Visibility<Select ariaLabel="Report visibility" value={state.vis || '__all__'} options={options(visibility)} onChange={v => change('vis', v === '__all__' ? '' : v)} /></label>
      <label>Subject<TextInput aria-label="Report subject" value={state.subject} placeholder="plan:plan-slug" onChange={e => change('subject', e.target.value)} /></label>
      <label>Written in pot<TextInput aria-label="Origin pot" value={state.pot} onChange={e => change('pot', e.target.value)} /></label>
      <label>Tags<TextInput aria-label="Report tags" value={state.tag} placeholder="Comma-separated tags" onChange={e => change('tag', e.target.value)} /></label>
      <label>Since<TextInput aria-label="Published since" type="date" value={state.since} onChange={e => change('since', e.target.value)} /></label>
    </form>
    <div className="reports-workspace">
      <section className="reports-list" aria-label="Reports library">
        {library.loading && <p role="status">Loading reports…</p>}
        {library.error && <div role="alert"><p>{library.error.message}</p><Button onClick={library.invalidate}>Retry</Button></div>}
        {!library.loading && !library.error && !library.data.length && <p>No reports match these filters.</p>}
        {library.data.map(item => <button key={item.report_id} type="button" className="reports-list-item" aria-pressed={item.report_id === state.sel}
          onClick={() => select(item.report_id)}><strong>{item.title}</strong><span>{item.summary || item.kind}</span>
          <small>{item.origin.harness_slug || 'Workspace'} · {published(item.published_at)} · {item.visibility}</small></button>)}
        {library.data.length === 200 && <p>Narrow the filters to find more reports.</p>}
      </section>
      <section className="reports-reader" aria-label="Report reader">
        {!state.sel && <p>Select a report to read it.</p>}
        {state.sel && detail.loading && <p role="status">Loading report…</p>}
        {state.sel && detail.error && <div role="alert"><p>{detail.error.message}</p><Button onClick={detail.invalidate}>Retry</Button></div>}
        {state.sel && !detail.loading && !detail.error && !report && <p>This report is unavailable.</p>}
        {report && <article key={report.report_id}>
          <h2>{report.title}</h2>
          <dl className="reports-metadata">
            <div><dt>Kind</dt><dd>{report.kind}</dd></div>
            <div><dt>Written by</dt><dd>{report.origin.author_owner_id || 'Unknown author'}</dd></div>
            <div><dt>Pot</dt><dd>{report.origin.harness_slug || 'Workspace'}</dd></div>
            <div><dt>Subject</dt><dd>{report.subject.label || report.subject.ref || report.subject.kind}</dd></div>
            <div><dt>Visibility</dt><dd>{report.visibility}</dd></div>
            <div><dt>Published</dt><dd>{published(report.published_at)}</dd></div>
            <div><dt>Source</dt><dd>{report.source}</dd></div>
            <div><dt>Report ID</dt><dd>{report.report_id}</dd></div>
          </dl>
          {report.retired_at && <p role="status">This report was retired. Its saved citation remains readable.</p>}
          <div className="reports-actions"><Button onClick={() => { void copyReport(); }}>{copied === report.report_id ? 'Copied' : 'Copy as Markdown'}</Button>
            <Button onClick={() => { void setState({ hist: !state.hist }); }} aria-expanded={state.hist}>Version history</Button>
            {report.supersedes_report_id && <Button onClick={() => select(report.supersedes_report_id!)}>Previous version</Button>}
          </div>
          {copyError && <p role="alert">{copyError}</p>}
          {state.hist && <section aria-label="Version history"><h3>Version history</h3>
            {history.loading && <p role="status">Loading history…</p>}{history.error && <p role="alert">{history.error.message}</p>}
            {history.data.map(version => <button type="button" key={version.report_id} className="reports-history-item" onClick={() => select(version.report_id)}
              aria-current={version.report_id === report.report_id ? 'true' : undefined}>{version.title} · {published(version.published_at)}{version.retired_at ? ' · retired' : ''}</button>)}
          </section>}
          <MarkdownPreview value={report.body_md} className="reports-body" />
        </article>}
      </section>
    </div>
  </main>;
}
