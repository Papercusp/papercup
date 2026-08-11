/**
 * pot-git/authority-epoch.ts — the epoch-GRANT derivation policy (P-505,
 * p2p-git-live-activation-2026-07-09; closes the integrator leg's "EPOCH NOTE"
 * gap: "a live multi-machine authority handoff needs the G-0 grant wired in
 * before Phase 3's drill").
 *
 * The FENCING mechanism (staging-advance.ts: sign + strict (epoch, seq) order)
 * has been wired since P-203; what was missing is the GRANTING side — how an
 * integrator that just became the lock-authority picks the epoch it publishes
 * under, so receivers can order its advances AFTER the previous authority's.
 * Everything here composes the already-landed G-0 library (handoff-token.ts):
 *
 *  - GRACEFUL handoff (G-0): the previous authority left a signed handoff
 *    token in its namespace (the integrator leg refreshes one after every
 *    advance — a continuously-maintained "will", so a crash is indistinguishable
 *    from a graceful exit as long as the namespace replicated). The successor
 *    ADOPTS the best verified token: seed staging at the token's sha
 *    (`adoptHandoffToken`, FF-only — never rewinds own work) and publish at
 *    `token.epoch + 1`.
 *  - CRASH takeover (P-038): no token, but this machine's worktree-bridge
 *    watermark (the last ACCEPTED advance) is AHEAD of its own integrator
 *    publish watermark — i.e. someone else was the authority and is now gone.
 *    Publish at `watermark.epoch + 1`, seeding base from
 *    `resolveMaxObservedStaging` so the first publish descends from the dead
 *    authority's last accepted staging (receivers' FF invariant holds).
 *  - STANDING authority: neither foreign evidence beats own watermark — keep
 *    the current epoch, bump seq (the pre-P-505 behavior, unchanged).
 *
 * The RECEIVER side ({@link deriveMaxGrantedEpoch}) is the dual: the
 * insider-poisoning cap (staging-advance.ts `maxGrantedEpoch`, WI-1560) must
 * recognize a LEGITIMATE grant — "the last verified G-0 handoff token's
 * nextEpoch" per that module's own doc — or an ex-authority would reject its
 * successor's advances as `ungranted-epoch` forever (the pre-P-505 bug: the
 * cap was the receiver's OWN stale publish epoch).
 *
 * Pure over the G-0 library + storage.ts's RunGit seam; integration-tested
 * against a real temp bare repo (the handoff-token test idiom).
 */

import {
  readHandoffToken,
  verifyHandoffToken,
  adoptHandoffToken,
  resolveMaxObservedStaging,
  type AdoptHandoffResult,
  type SignedHandoffToken,
} from './handoff-token';
import { integrateMemberHeads, STAGING_REF } from './integrator';
import { compareEpochSeq, type EpochSeq } from './staging-advance';
import {
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  writeNamespaceRef,
  type RunGit,
} from './storage';

const ZERO_SHA = '0'.repeat(40);

/** What the integrator leg may publish under this tick, and why. A failed base
 *  reconciliation deliberately carries NO epoch: callers must decline the
 *  tick rather than accidentally publishing a fenced-but-non-descendant line. */
export type IntegratorGrant =
  | {
      ready: true;
      /** The epoch to stamp on this tick's announcement. */
      epoch: number;
      /** The per-epoch counter PRIOR to this tick (the tick signs priorSeq + 1). */
      priorSeq: number;
      basis: 'standing' | 'token-adoption' | 'crash-takeover';
      /** Set on token-adoption: how the base seeding went (adopted / kept own). */
      adoption?: AdoptHandoffResult;
      /** The device (base64) whose token / accepted advance granted the takeover. */
      grantedFrom?: string;
      /** LOUD one-line summary for the tick log (takeovers must be visible). */
      detail: string;
    }
  | {
      ready: false;
      basis: 'blocked-token-adoption' | 'blocked-crash-reconciliation';
      adoption?: AdoptHandoffResult;
      grantedFrom?: string;
      detail: string;
    };

/** Read + verify every member's handoff token (skips self, unverifiable, and
 *  tokens whose embedded device does not match the namespace they sit in). */
async function readVerifiedTokens(
  repoPath: string,
  selfDevicePubkeyBase64: string,
  memberDevicePubkeysBase64: readonly string[],
  runGit: RunGit,
): Promise<Array<{ device: string; token: SignedHandoffToken }>> {
  const out: Array<{ device: string; token: SignedHandoffToken }> = [];
  for (const dev of memberDevicePubkeysBase64) {
    if (dev === selfDevicePubkeyBase64) continue;
    const token = await readHandoffToken(repoPath, dev, runGit);
    if (token && verifyHandoffToken(token, dev)) out.push({ device: dev, token });
  }
  return out;
}

/** Seed own namespace staging at `sha` FF-only (the crash-path half of
 *  `adoptHandoffToken`'s seeding rules): no own staging or ours an ancestor →
 *  CAS-write to `sha`; equal / already ahead → keep own; diverged → keep own
 *  (loud in the caller's detail — content still converges via member-head
 *  integration, and the FF fence protects receivers either way). */
async function seedOwnStagingFF(
  repoPath: string,
  selfDevicePubkeyBase64: string,
  sha: string,
  runGit: RunGit,
): Promise<'seeded' | 'kept-own' | 'diverged'> {
  const own = await readNamespaceRef(repoPath, selfDevicePubkeyBase64, STAGING_REF, runGit);
  if (own === sha) return 'kept-own';
  if (own !== null) {
    const shaInOwn = await runGit(['merge-base', '--is-ancestor', sha, own], repoPath);
    if (shaInOwn.code === 0) return 'kept-own'; // already at/ahead
    const ownInSha = await runGit(['merge-base', '--is-ancestor', own, sha], repoPath);
    if (ownInSha.code !== 0) return 'diverged';
  }
  await writeNamespaceRef(repoPath, selfDevicePubkeyBase64, STAGING_REF, sha, runGit, own ?? ZERO_SHA);
  return 'seeded';
}

export interface DeriveIntegratorGrantInput {
  repoPath: string;
  selfDevicePubkeyBase64: string;
  /** The hive's attested member devices (the leg's existing membership list). */
  memberDevicePubkeysBase64: readonly string[];
  /** This machine's persisted integrator PUBLISH watermark (routine metadata
   *  `integrator`), null when it never published. */
  priorIntegrator: EpochSeq | null;
  /** This machine's last ACCEPTED foreign advance (routine metadata
   *  `worktree_bridge.epochSeq`), null when none accepted yet. */
  bridgeWatermark: EpochSeq | null;
  runGit?: RunGit;
}

/**
 * Derive the epoch this integrator publishes under THIS tick. Call only on
 * the machine that currently holds the lock-authority lease (the leg's
 * existing `isIntegrator` gate) — the derivation is what makes its FIRST
 * publish after a takeover beat the previous authority's last one.
 */
export async function deriveIntegratorGrant(input: DeriveIntegratorGrantInput): Promise<IntegratorGrant> {
  const runGit = input.runGit ?? defaultRunGit;
  const mine: EpochSeq = input.priorIntegrator ?? { epoch: 1, seq: 0 };

  const tokens = await readVerifiedTokens(
    input.repoPath,
    input.selfDevicePubkeyBase64,
    input.memberDevicePubkeysBase64,
    runGit,
  );
  let best: { device: string; token: SignedHandoffToken } | null = null;
  for (const t of tokens) if (!best || compareEpochSeq(t.token, best.token) > 0) best = t;

  const tokenGrant = best ? best.token.epoch + 1 : 0;
  // Crash evidence: an ACCEPTED advance ahead of everything we ever published
  // means another authority ran after us (we only persist `integrator` on our
  // own publishes) — its epoch grants us epoch + 1.
  const crashEvidence =
    input.bridgeWatermark !== null && compareEpochSeq(input.bridgeWatermark, mine) > 0
      ? input.bridgeWatermark
      : null;
  const crashGrant = crashEvidence ? crashEvidence.epoch + 1 : 0;

  const target = Math.max(mine.epoch, tokenGrant, crashGrant);
  if (target === mine.epoch) {
    return {
      ready: true,
      epoch: mine.epoch,
      priorSeq: mine.seq,
      basis: 'standing',
      detail: `standing authority — continuing epoch ${mine.epoch} at seq ${mine.seq}`,
    };
  }

  // Takeover — prefer the token basis when the token is what granted the max
  // (adoption also seeds the base); otherwise crash-path seeding.
  if (best && tokenGrant === target) {
    let adoption = await adoptHandoffToken(input.repoPath, input.selfDevicePubkeyBase64, best.token, {
      runGit,
    });
    // FF-only adoption reports divergence when the successor already has
    // legitimate local staging. Reconcile both clean histories first, then
    // re-run the adoption proof; a conflict remains a hard stop.
    if (!adoption.ok && adoption.reason === 'diverged') {
      const reconciliation = await integrateMemberHeads(
        input.repoPath,
        input.selfDevicePubkeyBase64,
        [{ deviceHex: deviceNamespaceKey(best.device), sha: best.token.staging_sha }],
        { runGit },
      );
      if (reconciliation.skippedConflicts.length === 0) {
        adoption = await adoptHandoffToken(input.repoPath, input.selfDevicePubkeyBase64, best.token, {
          runGit,
        });
      }
    }
    if (!adoption.ok) {
      return {
        ready: false,
        basis: 'blocked-token-adoption',
        adoption,
        grantedFrom: best.device,
        detail:
          `AUTHORITY TAKEOVER BLOCKED: verified handoff token from ${best.device.slice(0, 12)}… ` +
          `(epoch ${best.token.epoch}) could not establish a descendant staging base (${adoption.reason})`,
      };
    }
    const seeded = adoption.ok
      ? adoption.adopted
        ? `staging seeded at ${adoption.staging.slice(0, 12)}`
        : `own staging kept (at/ahead of token)`
      : `base NOT seeded (${adoption.reason}) — keeping own base, epoch still fenced`;
    return {
      ready: true,
      epoch: target,
      priorSeq: 0,
      basis: 'token-adoption',
      adoption,
      grantedFrom: best.device,
      detail:
        `AUTHORITY TAKEOVER (graceful): adopted handoff token from ${best.device.slice(0, 12)}… ` +
        `(epoch ${best.token.epoch} → publishing at ${target}); ${seeded}`,
    };
  }

  // Crash takeover: seed from the ancestry-maximal observed staging so our
  // first publish fast-forwards receivers from the dead authority's last one.
  let seedDetail = 'no observed staging to seed from';
  const max = await resolveMaxObservedStaging(input.repoPath, input.memberDevicePubkeysBase64, runGit);
  if (max) {
    const seeded = await seedOwnStagingFF(input.repoPath, input.selfDevicePubkeyBase64, max.sha, runGit);
    if (seeded === 'diverged' || max.diverged) {
      const reconciliation = await integrateMemberHeads(
        input.repoPath,
        input.selfDevicePubkeyBase64,
        max.maximal,
        { runGit },
      );
      if (reconciliation.skippedConflicts.length > 0) {
        return {
          ready: false,
          basis: 'blocked-crash-reconciliation',
          grantedFrom: crashEvidence ? `epoch:${crashEvidence.epoch}` : undefined,
          detail:
            `AUTHORITY TAKEOVER BLOCKED: ${reconciliation.skippedConflicts.length} ancestry-maximal ` +
            `staging head(s) conflict with the successor base`,
        };
      }
    }
    seedDetail =
      `base ${seeded} (max observed staging ${max.sha.slice(0, 12)}` +
      `${max.diverged ? ', reconciled divergent namespace maxima' : ''})`;
  }
  return {
    ready: true,
    epoch: target,
    priorSeq: 0,
    basis: 'crash-takeover',
    detail:
      `AUTHORITY TAKEOVER (crash path): last accepted advance ` +
      `(epoch ${crashEvidence?.epoch ?? '?'}, seq ${crashEvidence?.seq ?? '?'}) is ahead of own ` +
      `publish watermark (epoch ${mine.epoch}, seq ${mine.seq}) with no adoptable token — ` +
      `publishing at epoch ${target}; ${seedDetail}`,
  };
}

export interface DeriveMaxGrantedEpochInput {
  repoPath: string;
  /** Every attested member device — tokens from ANY member (including the
   *  receiver's own namespace) count as grant evidence. */
  memberDevicePubkeysBase64: readonly string[];
  /** The receiver's own integrator publish epoch (routine metadata), if any. */
  ownIntegratorEpoch: number | undefined;
  runGit?: RunGit;
}

/**
 * The RECEIVER-side cap for `acceptStagingAdvance`'s `maxGrantedEpoch`
 * (WI-1560 insider-poisoning guard): the highest epoch this receiver can
 * PROVE was legitimately granted = max(own publish epoch, every verified
 * handoff token's `epoch + 1`). Undefined when there is no evidence at all
 * (pre-P-505 behavior: uncapped — the allowed-devices gate still applies).
 *
 * A successor's first advance can reach a receiver BEFORE the granting token
 * federates; the caller must treat `ungranted-epoch` as RETRYABLE (hold the
 * cursor), never a terminal drop — the token arrives with the next namespace
 * fetch and the same advance then verifies.
 */
export async function deriveMaxGrantedEpoch(input: DeriveMaxGrantedEpochInput): Promise<number | undefined> {
  const runGit = input.runGit ?? defaultRunGit;
  let cap = input.ownIntegratorEpoch;
  for (const dev of input.memberDevicePubkeysBase64) {
    const token = await readHandoffToken(input.repoPath, dev, runGit);
    if (token && verifyHandoffToken(token, dev)) {
      const granted = token.epoch + 1;
      if (cap === undefined || granted > cap) cap = granted;
    }
  }
  return cap;
}
