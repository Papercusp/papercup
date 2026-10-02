/**
 * Hidden-delegate reads of the Personal Vault (plan
 * personal-data-reader-set-labels-2026-10-01, P-007 / BAR R-12, D-007).
 *
 * A caller asks a question; a DELEGATE answers it from the matching personal
 * documents. The delegate is a bare model call with no tools, so it cannot send
 * anything anywhere — what it learns can leave only through its answer. The
 * answer is therefore the one thing judged:
 *
 *   - it carries no restricted document text or fields → delivered, and the
 *     caller's disclosure ledger is NOT touched;
 *   - it carries restricted content → WITHHELD by default; with `acceptLabel`
 *     it is delivered and every restricted document it carries is recorded on
 *     the caller through `discloseDocuments`, the same delivery-time rule
 *     personal:search applies, so the caller's later sends are bound by those
 *     documents' reader sets (R-1). A caller with no attributable identity
 *     cannot carry a label (D-004), so its answer is withheld either way.
 *
 * Classification is lexical and runs against EXACTLY the text the delegate was
 * shown (`renderDelegateDocuments` and `classifyDelegateAnswer` read the same
 * fields), so nothing the delegate saw is outside the check:
 *   - text: any `DELEGATE_SHINGLE_WORDS`-word run of a restricted document's
 *     title or snippet appearing in the answer; a segment shorter than that is
 *     matched whole once it has `DELEGATE_MIN_SEGMENT_WORDS` words;
 *   - fields: the sender and non-owner participant addresses of a restricted
 *     document appearing in the answer.
 * A value the caller already holds — present in its question, or in an
 * unrestricted document the delegate also saw — is not counted: delivering it
 * discloses nothing the caller could not read unlabelled.
 *
 * Limit (stated, tracked as residue): a paraphrase that shares no run of
 * `DELEGATE_SHINGLE_WORDS` words and no field value with a restricted document
 * passes as content-free. The delegate is instructed not to quote or name
 * people; the classifier is the enforcement, and it is lexical.
 *
 * Labelling and the ledger write happen in ONE transaction, after the model
 * call: the delegate's answer can take longer than Postgres's
 * idle_in_transaction_session_timeout, so no transaction is held across it.
 */
import type postgres from 'postgres';
import { discloseDocuments, loadOwnerAddresses, loadPrivacyRules } from './disclosure-ledger';
import {
  documentSender,
  labelDocument,
  readerSetFor,
  type DocumentLabel,
  type LabelableDocument,
} from './disclosure-labels';

type Db = postgres.Sql | postgres.TransactionSql;

/** Length of the word run that counts as quoting a restricted document. */
export const DELEGATE_SHINGLE_WORDS = 8;
/** A title/snippet segment this short or shorter is too generic to identify a document. */
export const DELEGATE_MIN_SEGMENT_WORDS = 3;
/** The ledger's `delivered_via` for a delegated read. */
export const DELEGATED_READ_VIA = 'personal:ask';

export interface DelegateSourceDocument extends LabelableDocument {
  title: string;
  snippet: string;
  kind?: string | null;
  occurredAt?: string | null;
}

export type DelegateEvidence = 'text' | 'sender' | 'participant';

export interface DelegateCarry {
  documentId: string;
  evidence: DelegateEvidence[];
}

export interface DelegateClassification {
  carriesRestricted: boolean;
  carried: DelegateCarry[];
}

/** Produces the delegate's answer. Production: a tool-less model call (personal:ask). */
export type DelegateAnswerer = (input: { question: string; documents: string }) => Promise<string>;

export interface DelegatedReadParams {
  workspaceId: string;
  userId: string;
  /** The caller's disclosure identity (`disclosureSubject(ctx)`); null = unattributable. */
  callerOwnerId: string | null;
  question: string;
  documents: readonly DelegateSourceDocument[];
  /** Take on the label of any restricted document the answer carries, rather than have it withheld. */
  acceptLabel: boolean;
}

export type DelegatedReadResult =
  | {
      delivered: true;
      answer: string | null;
      labelled: false;
      consulted: number;
    }
  | {
      delivered: true;
      answer: string;
      labelled: true;
      consulted: number;
      /** The restricted documents the answer carries, now on the caller's ledger. */
      labels: Array<{ documentId: string; source: string; privacy: DocumentLabel }>;
    }
  | {
      delivered: false;
      reason: 'delegate_answer_carries_restricted' | 'disclosure_identity_unresolved';
      consulted: number;
      /** How many restricted documents the withheld answer would have carried. */
      carriedRestricted: number;
    };

export interface DelegatedReadDeps {
  answer: DelegateAnswerer;
  /** Runs `fn` in one workspace-scoped transaction (labelling + ledger write). */
  inWorkspaceTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
}

// ── lexical primitives ────────────────────────────────────────────────────

export function delegateWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(words: readonly string[], size = DELEGATE_SHINGLE_WORDS): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '));
  return out;
}

/** True when `needle` occurs as a contiguous word run inside `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  const joined = ` ${haystack.join(' ')} `;
  return joined.includes(` ${needle.join(' ')} `);
}

/**
 * The normalized addresses the delegate is shown for a document: its sender
 * and participants, exactly as a `participants` reader set would list them
 * (display names stripped, so the delegate never sees a name the classifier
 * does not check).
 */
function addressesOf(doc: DelegateSourceDocument): string[] {
  return readerSetFor(doc, 'participants').map((a) => a.trim().toLowerCase());
}

/** Everything the delegate is shown for one document, as the classifier reads it. */
function viewSegments(doc: DelegateSourceDocument): string[] {
  return [doc.title ?? '', doc.snippet ?? ''].filter((s) => s.trim().length > 0);
}

// ── what the delegate sees ────────────────────────────────────────────────

/**
 * The document block handed to the delegate. Only these fields reach it, and
 * `classifyDelegateAnswer` checks the answer against these same fields.
 */
export function renderDelegateDocuments(documents: readonly DelegateSourceDocument[]): string {
  return documents
    .map((doc, i) => {
      const sender = documentSender(doc)?.trim().toLowerCase() ?? null;
      const others = addressesOf(doc).filter((a) => a !== sender);
      const lines = [
        `[${i + 1}] ${doc.source}${doc.kind ? `/${doc.kind}` : ''}${doc.occurredAt ? ` · ${doc.occurredAt}` : ''}`,
        sender ? `from: ${sender}` : null,
        others.length ? `participants: ${others.join(', ')}` : null,
        doc.title ? `title: ${doc.title}` : null,
        doc.snippet ? `text: ${doc.snippet}` : null,
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export const DELEGATE_SYSTEM_PROMPT = [
  'You answer one question for another agent from the owner\'s personal documents listed below.',
  'Answer in at most three sentences. Prefer counts, yes/no, dates and times.',
  'Do not quote document text, do not repeat subject lines, and do not name or give the address of any person unless the question already names them.',
  'If the documents do not answer the question, say so.',
].join(' ');

// ── classification ────────────────────────────────────────────────────────

export function classifyDelegateAnswer(input: {
  answer: string;
  question: string;
  restricted: readonly DelegateSourceDocument[];
  unrestricted: readonly DelegateSourceDocument[];
  ownerAddresses: readonly string[];
}): DelegateClassification {
  const answerWords = delegateWords(input.answer);
  if (!answerWords.length || !input.restricted.length) return { carriesRestricted: false, carried: [] };
  const answerShingles = shingles(answerWords);

  // What the caller already holds: its own question and every unrestricted
  // document the delegate was shown.
  const knownTexts = [input.question, ...input.unrestricted.flatMap((doc) => [...viewSegments(doc), ...addressesOf(doc)])];
  const knownWords = knownTexts.map(delegateWords);
  const knownShingles = new Set(knownWords.flatMap((words) => [...shingles(words)]));
  const known = (run: readonly string[]) => knownWords.some((words) => containsRun(words, run));
  const owner = new Set(input.ownerAddresses.map((a) => a.trim().toLowerCase()));

  const carried: DelegateCarry[] = [];
  for (const doc of input.restricted) {
    const evidence = new Set<DelegateEvidence>();
    for (const segment of viewSegments(doc)) {
      const words = delegateWords(segment);
      if (words.length >= DELEGATE_SHINGLE_WORDS) {
        for (const s of shingles(words)) {
          if (answerShingles.has(s) && !knownShingles.has(s)) {
            evidence.add('text');
            break;
          }
        }
      } else if (words.length >= DELEGATE_MIN_SEGMENT_WORDS && containsRun(answerWords, words) && !known(words)) {
        evidence.add('text');
      }
    }
    const sender = documentSender(doc)?.trim().toLowerCase() ?? null;
    for (const address of addressesOf(doc)) {
      if (owner.has(address)) continue;
      const run = delegateWords(address);
      if (containsRun(answerWords, run) && !known(run)) evidence.add(address === sender ? 'sender' : 'participant');
    }
    if (evidence.size) carried.push({ documentId: doc.id, evidence: [...evidence].sort() });
  }
  return { carriesRestricted: carried.length > 0, carried };
}

// ── delivery ──────────────────────────────────────────────────────────────

/**
 * Ask the delegate, then decide what reaches the caller. The model call runs
 * outside any transaction; labelling, classification and the ledger write run
 * together in one, so the labels the delivery is judged by are the labels the
 * ledger records.
 */
export async function delegatedRead(params: DelegatedReadParams, deps: DelegatedReadDeps): Promise<DelegatedReadResult> {
  const consulted = params.documents.length;
  if (!consulted) return { delivered: true, answer: null, labelled: false, consulted };

  const answer = (await deps.answer({ question: params.question, documents: renderDelegateDocuments(params.documents) })).trim();

  return deps.inWorkspaceTx(async (tx) => {
    const rules = await loadPrivacyRules(tx, params.workspaceId, params.userId);
    const labelled = params.documents.map((doc) => ({ doc, privacy: rules.length ? labelDocument(doc, rules) : null }));
    const restricted = labelled.filter((entry) => entry.privacy !== null);
    if (!restricted.length) return { delivered: true, answer, labelled: false, consulted } as const;

    const ownerAddresses = await loadOwnerAddresses(tx, params.workspaceId, params.userId);
    const verdict = classifyDelegateAnswer({
      answer,
      question: params.question,
      restricted: restricted.map((entry) => entry.doc),
      unrestricted: labelled.filter((entry) => entry.privacy === null).map((entry) => entry.doc),
      ownerAddresses,
    });
    if (!verdict.carriesRestricted) return { delivered: true, answer, labelled: false, consulted } as const;

    const carriedIds = new Set(verdict.carried.map((c) => c.documentId));
    const carriedDocs = restricted.filter((entry) => carriedIds.has(entry.doc.id)).map((entry) => entry.doc);
    if (!params.acceptLabel) {
      return { delivered: false, reason: 'delegate_answer_carries_restricted', consulted, carriedRestricted: carriedDocs.length } as const;
    }

    const disclosed = await discloseDocuments(tx, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.callerOwnerId,
      documents: carriedDocs,
      via: DELEGATED_READ_VIA,
    });
    if (disclosed.withheld > 0) {
      return { delivered: false, reason: 'disclosure_identity_unresolved', consulted, carriedRestricted: carriedDocs.length } as const;
    }
    return {
      delivered: true,
      answer,
      labelled: true,
      consulted,
      labels: disclosed.documents
        .filter((doc): doc is typeof doc & { privacy: DocumentLabel } => doc.privacy !== null)
        .map((doc) => ({ documentId: doc.id, source: doc.source, privacy: doc.privacy })),
    } as const;
  });
}
