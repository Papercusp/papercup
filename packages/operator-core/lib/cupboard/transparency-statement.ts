/**
 * Signing and verifying a P-044 monthly statement (D-028 §4). Kept apart from the
 * report builder so the Cupboard Worker can verify a pushed statement with only
 * `@papercusp/hash-chain` and `viem`, without the money-journal module graph.
 *
 * Scheme `eip191-sha256-canonical-json`: digest = sha256(canonicalJson(statement)),
 * signature = EIP-191 personal_sign over the 32 digest bytes. Anyone recovers the
 * signer with `verifyMessage`; the signer is the anchor key's address (D-021).
 */
import { canonicalJson, sha256Hex } from '@papercusp/hash-chain';
import { verifyMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { MonthlyStatement } from './transparency-report';

export const STATEMENT_SIGNATURE_SCHEME = 'eip191-sha256-canonical-json' as const;

export interface SignedStatement {
  readonly scheme: typeof STATEMENT_SIGNATURE_SCHEME;
  readonly statement: MonthlyStatement;
  /** sha256(canonicalJson(statement)), hex without 0x. */
  readonly digest: string;
  readonly signature: Hex;
  readonly signer: Address;
}

export function statementDigest(statement: MonthlyStatement): string {
  return sha256Hex(canonicalJson(statement));
}

export async function signStatement(statement: MonthlyStatement, privateKey: Hex): Promise<SignedStatement> {
  const account = privateKeyToAccount(privateKey);
  const digest = statementDigest(statement);
  const signature = await account.signMessage({ message: { raw: `0x${digest}` } });
  return { scheme: STATEMENT_SIGNATURE_SCHEME, statement, digest, signature, signer: account.address };
}

/** Anyone's check: the digest matches the statement AND the signature recovers to `signer`. */
export async function verifySignedStatement(signed: SignedStatement): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signed.scheme !== STATEMENT_SIGNATURE_SCHEME) return { ok: false, reason: `unknown scheme '${String(signed.scheme)}'` };
  let digest: string;
  try {
    digest = statementDigest(signed.statement);
  } catch {
    return { ok: false, reason: 'statement is not canonical JSON' };
  }
  if (digest !== signed.digest) return { ok: false, reason: 'digest does not match the statement' };
  const valid = await verifyMessage({ address: signed.signer, message: { raw: `0x${signed.digest}` }, signature: signed.signature }).catch(() => false);
  return valid ? { ok: true } : { ok: false, reason: 'signature does not recover to the signer' };
}

/** Shape check for a pushed statement (the Worker then calls verifySignedStatement). */
export function parseSignedStatement(raw: unknown): SignedStatement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const st = r.statement as Record<string, unknown> | undefined;
  const report = st?.report as Record<string, unknown> | undefined;
  const ok =
    r.scheme === STATEMENT_SIGNATURE_SCHEME &&
    typeof r.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(r.digest) &&
    typeof r.signature === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(r.signature) &&
    typeof r.signer === 'string' &&
    /^0x[0-9a-fA-F]{40}$/.test(r.signer) &&
    !!report &&
    report.kind === 'monthly-statement' &&
    report.provisional === false &&
    typeof report.workspaceId === 'string' &&
    typeof report.month === 'string' &&
    /^\d{4}-\d{2}$/.test(report.month);
  return ok ? (raw as SignedStatement) : null;
}
