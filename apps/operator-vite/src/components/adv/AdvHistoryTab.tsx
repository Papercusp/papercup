import { useEffect, useMemo, useState } from 'react';
import {
  ProjectHistoryView,
  type BuildHistoryPlan,
  type BuildHistoryProject,
  type BuildHistorySnapshotSource,
} from '@papercusp/ui-primitives';
import { useAdvScope } from './AdvShell';

interface ProjectHistoryDocument {
  schemaVersion: number;
  project: BuildHistoryProject;
  source: BuildHistorySnapshotSource;
  plans: Array<Omit<BuildHistoryPlan, 'project' | 'snapshot'>>;
}

function materialize(document: ProjectHistoryDocument): BuildHistoryPlan[] {
  return document.plans.map((plan) => ({ ...plan, project: document.project, snapshot: document.source }));
}

/**
 * Defence in depth. The route strips escapes from the generator's stderr, but any
 * failure that reaches this box is text we did not author, so never render it raw
 * — an unstripped SGR sequence shows the user a literal `[31m` before the message.
 */
function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '');
}

/** Carries the route's machine-readable `code` so the view can tell "empty" from "broken". */
class HistoryError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'HistoryError';
  }
}

export default function AdvHistoryTab() {
  const scope = useAdvScope();
  const slug = scope.allMode ? null : scope.slug;
  const [document, setDocument] = useState<ProjectHistoryDocument | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!slug) {
      setDocument(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/project-history`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as ProjectHistoryDocument & { error?: string; code?: string };
        if (!response.ok) throw new HistoryError(body.error || `HTTP ${response.status}`, body.code);
        return body;
      })
      .then((body) => setDocument(body))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError({
          message: stripAnsi(cause instanceof Error ? cause.message : String(cause)),
          code: cause instanceof HistoryError ? cause.code : undefined,
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [slug, revision]);

  const plans = useMemo(() => document ? materialize(document) : [], [document]);
  return (
    <section className="pc-project-history build-history-page" aria-busy={loading}>
      <header className="build-history-hero">
        <div>
          <span className="pc-project-history__eyebrow">Verified delivery record</span>
          <h1>History</h1>
          <p>Plans, completed work, commits, and the validation evidence that proves each change.</p>
        </div>
      </header>
      {!slug ? (
        <div className="build-history-empty"><h2>Select a pot</h2><p>History is scoped to one project at a time.</p></div>
      ) : error?.code === 'not-a-git-repository' ? (
        <div className="build-history-empty">
          <h2>No history to show</h2>
          <p>{error.message}</p>
        </div>
      ) : error ? (
        <div className="build-history-error" role="alert">
          <strong>History is unavailable.</strong><span>{error.message}</span>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button>
        </div>
      ) : loading && !document ? (
        <p className="build-history-loading" role="status">Generating project history…</p>
      ) : (
        <ProjectHistoryView plans={plans} now={new Date()} />
      )}
      <style>{HISTORY_CSS}</style>
    </section>
  );
}

const HISTORY_CSS = `
  .pc-project-history { display:grid; gap:18px; min-width:0; padding:18px; color:var(--fg); overflow:auto; }
  .build-history-hero { display:flex; justify-content:space-between; gap:16px; }
  .build-history-hero h1 { margin:4px 0; font-size:22px; }
  .build-history-hero p { margin:0; color:var(--fg-mute); font-size:13px; }
  .pc-project-history__eyebrow { color:var(--accent); font-size:10px; font-weight:800; text-transform:uppercase; }
  .build-metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
  .build-metric,.build-plan-card,.build-validation-contract,.build-history-toolbar,.build-verification-banner { border:1px solid var(--border); border-radius:10px; background:var(--bg-1); }
  .build-metric { display:grid; gap:4px; padding:12px; } .build-metric span,.build-evidence-block h4 { color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-metric strong { font-size:18px; } .build-metric small { color:var(--fg-mute); }
  .build-verification-banner { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; padding:12px; }
  .build-verification-banner p { margin:3px 0 0; color:var(--fg-mute); font-size:12px; }
  .build-verification-mark { color:var(--good); font-weight:900; } .build-verification-status { color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-history-toolbar { display:grid; grid-template-columns:minmax(220px,2fr) repeat(3,minmax(120px,1fr)); gap:8px; padding:10px; }
  .build-history-toolbar label { display:grid; gap:4px; color:var(--fg-mute); font-size:10px; text-transform:uppercase; }
  .build-history-toolbar input,.build-history-toolbar select { min-width:0; padding:7px; border:1px solid var(--border); border-radius:6px; color:var(--fg); background:var(--bg-2); }
  .build-history-results-heading,.build-plan-actions,.build-plan-meta-row,.build-item-meta,.build-validation-heading,.build-validation-contract>header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
  .build-history-results-heading h2 { margin:0; } .build-history-results-heading p { margin:2px 0 0; color:var(--fg-mute); }
  .build-plan-list { display:grid; gap:10px; } .build-plan-card { overflow:hidden; }
  .build-plan-heading { display:grid; grid-template-columns:1fr auto; gap:12px; padding:14px; cursor:pointer; list-style:none; }
  .build-plan-heading::-webkit-details-marker { display:none; } .build-plan-title h2 { margin:7px 0 4px; } .build-plan-title p,.build-plan-title code { color:var(--fg-mute); }
  .build-plan-status,.build-item-kind,.build-item-state { padding:3px 6px; border-radius:5px; background:color-mix(in oklab,var(--accent),transparent 82%); font-size:10px; text-transform:uppercase; }
  .build-plan-body { display:grid; gap:12px; padding:0 14px 14px; } .build-plan-evidence-grid,.build-item-evidence-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .build-evidence-block { padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--bg-2); } .build-evidence-block h4,.build-evidence-block p { margin:0 0 5px; }
  .build-validation-contract { display:grid; gap:8px; padding:10px; } .build-validation-contract ul,.build-item-list,.build-item-commits ul { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
  .build-validation-contract li,.build-item { padding:10px; border:1px solid var(--border); border-radius:8px; background:var(--bg-2); }
  .build-validation-contract p { font-size:12px; } .build-validation-contract dl { display:grid; grid-template-columns:auto 1fr; gap:4px 8px; font-size:11px; } .build-validation-contract dd { margin:0; }
  .build-work-items-disclosure>summary { cursor:pointer; color:var(--accent); } .build-item-heading { display:flex; justify-content:space-between; gap:8px; }
  .build-item-commits { margin-top:10px; } .build-commit-title,.build-commit-meta { display:flex; justify-content:space-between; gap:8px; } .build-commit-meta { color:var(--fg-mute); font-size:10px; }
  .build-history-empty,.build-history-error,.build-history-loading { padding:24px; border:1px solid var(--border); border-radius:10px; background:var(--bg-1); text-align:center; }
  .build-history-error { color:var(--bad); } button,.button { cursor:pointer; }
  .build-plan-dialog-overlay { position:fixed; inset:0; z-index:1200; background:rgba(0,0,0,.7); }
  .build-plan-dialog { position:fixed; inset:5vh 5vw; z-index:1201; display:grid; grid-template-rows:auto auto 1fr; overflow:hidden; padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--bg-popover); color:var(--fg); }
  .build-plan-dialog-header { display:flex; justify-content:space-between; } .build-plan-dialog-provenance { display:flex; flex-wrap:wrap; gap:12px; } .build-plan-dialog-document { min-height:0; overflow:auto; }
  @media(max-width:800px){.build-metric-grid,.build-plan-evidence-grid,.build-item-evidence-grid,.build-history-toolbar{grid-template-columns:1fr}.build-verification-banner{grid-template-columns:auto 1fr}.build-verification-status{grid-column:2}}
`;
