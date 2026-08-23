/**
 * WorkflowsLanding — the Workflows tab landing surface (the Blend).
 *
 * Plan: external-triggers-gmail-slack-2026-08-22 (P-027), governed by D-018.
 * Layout: /tmp/workflows-builder/Main.dc.html.
 *
 * Four regions, in the order D-018 names them:
 *   1. needs-you strip   — rendered ONLY when non-empty
 *   2. agent composer    — with source-derived suggestion chips
 *   3. active now        — what is actually firing
 *   4. all workflows     — the ledger
 *
 * All derivation lives in workflows-landing-model.ts; this file is presentation plus the
 * URL state. That split is what lets the "only when non-empty" rule and the source-derived
 * chips be tested without rendering anything.
 *
 * ── THE STRIP'S ABSENCE IS THE FEATURE ──────────────────────────────────────────────────
 * `needsYou.length === 0` renders NOTHING — no "all good" card, no empty frame. An
 * always-present strip is what D-018 rejects: an operator who sees the interrupt region
 * every day stops reading it, and then it fails on the one day it matters.
 */

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import {
  buildActiveNow,
  buildNeedsYou,
  buildSuggestionChips,
  buildWorkflowLedger,
  type LandingSourceInput,
  type LandingWorkflowInput,
  type NeedsYouItem,
  type WorkflowLedgerRow,
} from './workflows-landing-model';
import './adv-workflow-detail.css';
import './adv-workflows-landing.css';

export interface WorkflowsLandingProps {
  workflows: readonly LandingWorkflowInput[];
  sources: readonly LandingSourceInput[];
  /** Total fires in the activity window; null when not measured (never rendered as 0). */
  firesToday?: number | null;
  /** Total spend label for the active-now header, e.g. "$4.12"; null when unknown. */
  spendTodayLabel?: string | null;
  nowMs?: number;
  onOpenWorkflow: (workflowId: string) => void;
  onNeedsYouAction: (item: NeedsYouItem) => void;
  onInstallFromCupboard: () => void;
  /** Hand the operator's prompt to the workflow agent. */
  onComposeWorkflow: (prompt: string) => void;
}

export default function WorkflowsLanding({
  workflows,
  sources,
  firesToday = null,
  spendTodayLabel = null,
  nowMs,
  onOpenWorkflow,
  onNeedsYouAction,
  onInstallFromCupboard,
  onComposeWorkflow,
}: WorkflowsLandingProps) {
  // Draft text is mid-edit state, so it is useState by the repo's own split; the LEDGER
  // toggle below is user-meaningful navigation, so it is nuqs.
  const [draft, setDraft] = useState('');
  const [ledgerOpen, setLedgerOpen] = useQueryState('wfLedger', parseAsString);

  const needsYou = useMemo(() => buildNeedsYou({ sources, workflows }), [sources, workflows]);
  const chips = useMemo(() => buildSuggestionChips(sources), [sources]);
  const activeNow = useMemo(
    () => buildActiveNow(workflows, { nowMs, firesToday }),
    [workflows, nowMs, firesToday],
  );
  const ledger = useMemo(() => buildWorkflowLedger(workflows, { nowMs }), [workflows, nowMs]);

  const showFullLedger = ledgerOpen === 'open';

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const prompt = draft.trim();
      if (!prompt) return;
      onComposeWorkflow(prompt);
      setDraft('');
    },
    [draft, onComposeWorkflow],
  );

  return (
    <div className="pc-workflows">
      <header className="pc-workflows__masthead">
        <h2 className="pc-workflows__title">Workflows</h2>
        <button type="button" className="pc-workflows__install" onClick={onInstallFromCupboard}>
          Install from Cupboard
        </button>
      </header>

      {/* D-018: rendered ONLY when non-empty. No empty-state branch belongs here. */}
      {needsYou.length > 0 ? (
        <section className="pc-workflows__needsyou" aria-label="Needs you" data-testid="workflows-needs-you">
          <span className="pc-workflows__needsyou-lead">Needs you:</span>
          <ul className="pc-workflows__needsyou-list">
            {needsYou.map((item) => (
              <li key={item.id} className={`pc-workflows__needsyou-item is-${item.severity}`}>
                <span>{item.message}</span>
                <button
                  type="button"
                  className="pc-workflows__needsyou-action"
                  onClick={() => onNeedsYouAction(item)}
                >
                  {item.actionLabel}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="pc-workflows__hero" aria-label="Describe a workflow">
        <form onSubmit={submit}>
          <label className="pc-workflows__hero-label" htmlFor="pc-workflows-compose">
            What should happen automatically? The agent wires it.
          </label>
          <div className="pc-workflows__hero-row">
            <input
              id="pc-workflows-compose"
              className="pc-workflows__hero-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="When an email from a client arrives…"
            />
            <button type="submit" className="pc-workflows__hero-submit" disabled={draft.trim().length === 0}>
              Wire it
            </button>
          </div>
        </form>
        {chips.length > 0 ? (
          <div className="pc-workflows__chips" data-testid="workflows-chips">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className="pc-workflows__chip"
                onClick={() => setDraft(chip.text)}
              >
                {chip.text}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="pc-workflows__section" aria-label="Active now">
        <header className="pc-workflows__sectionhead">
          <h3>Active now</h3>
          <span className="pc-workflows__sectionmeta">
            {/* null means "not measured" — it must not render as "0 fires today". */}
            {activeNow.firesToday == null ? 'fires not counted' : `${activeNow.firesToday} fires today`}
            {spendTodayLabel ? ` · ${spendTodayLabel}` : ''}
          </span>
        </header>
        {activeNow.rows.length === 0 ? (
          <p className="pc-workflows__empty">
            Nothing has fired recently. Describe a workflow above and the agent will wire it.
          </p>
        ) : (
          <div className="pc-workflows__cards">
            {activeNow.rows.map((row) => (
              <WorkflowCard key={row.id} row={row} onOpen={() => onOpenWorkflow(row.id)} />
            ))}
          </div>
        )}
      </section>

      <section className="pc-workflows__section" aria-label="All workflows">
        <header className="pc-workflows__sectionhead">
          <h3>All workflows · {ledger.length}</h3>
          <button
            type="button"
            className="pc-workflows__linkbtn"
            onClick={() => void setLedgerOpen(showFullLedger ? null : 'open')}
          >
            {showFullLedger ? 'Show fewer ←' : 'Open full ledger →'}
          </button>
        </header>
        {ledger.length === 0 ? (
          <p className="pc-workflows__empty">No workflows installed yet.</p>
        ) : (
          <table className="pc-workflows__ledger">
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Chain</th>
                <th scope="col">Last</th>
                <th scope="col">Spend</th>
              </tr>
            </thead>
            <tbody>
              {(showFullLedger ? ledger : ledger.slice(0, LEDGER_PREVIEW)).map((row) => (
                <tr
                  key={row.id}
                  className={row.needsAttention ? 'is-attention' : undefined}
                  onClick={() => onOpenWorkflow(row.id)}
                >
                  <th scope="row">{row.label}</th>
                  <td>{row.chain}</td>
                  {/* A never-fired workflow shows an em dash, not a fabricated time. */}
                  <td>{row.lastLabel ?? '—'}</td>
                  <td>{row.spendLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!showFullLedger && ledger.length > LEDGER_PREVIEW ? (
          <p className="pc-workflows__more">{ledger.length - LEDGER_PREVIEW} more in the full ledger</p>
        ) : null}
      </section>
    </div>
  );
}

const LEDGER_PREVIEW = 5;

function WorkflowCard({ row, onOpen }: { row: WorkflowLedgerRow; onOpen: () => void }) {
  return (
    <button type="button" className="pc-workflows__card" onClick={onOpen}>
      <span className="pc-workflows__card-label">{row.label}</span>
      <span className="pc-workflows__card-chain">{row.chain}</span>
      <span className="pc-workflows__card-foot">
        {row.needsAttention ? (
          <span className="pc-workflows__card-attention">needs attention — review with the agent</span>
        ) : (
          <>
            {row.lastLabel ? <span>last {row.lastLabel}</span> : null}
            <span>{row.spendLabel}</span>
          </>
        )}
      </span>
    </button>
  );
}
