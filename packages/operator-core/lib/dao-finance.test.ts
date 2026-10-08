import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData } from 'viem';
import { runDaoFinance, type DaoFinanceDeps } from './dao-finance';
import { equityArtifacts } from './equity/runtime';
const address = (n: string) => '0x' + n.repeat(40);
const equity = { chainId: 1, equity: address('1'), governor: address('2'), timelock: address('3') };
function deps(): DaoFinanceDeps {
  return { wallet: vi.fn().mockResolvedValue({ ok: true, value: { binding: { walletAddress: address('4'), chainId: 1 } } }),
    challenge: vi.fn(), verify: vi.fn(), commerce: vi.fn().mockResolvedValue({ ok: false, code: 'unknown-org', detail: 'Organization is not in the commerce roster.' }),
    equity: vi.fn().mockResolvedValue({ governanceBound: true, supplyInvariant: true, issuedShares: '42' }), treasury: vi.fn().mockResolvedValue({ nativeBalanceWei: '123' }) };
}
describe('Workbench finance maintained boundaries', () => {
  it('never invents organization accounts from a DAO directory id and distinguishes unbound/error reads', async () => {
    const d = deps(); const result = await runDaoFinance({ policy: {}, policyVersion: 0, actorId: 'gh:42', action: { op: 'inspect' } }, d);
    expect(result).toMatchObject({ treasury: { status: 'not-bound' }, commerce: { status: 'not-bound' }, equity: { status: 'not-bound' } });
    expect(d.commerce).not.toHaveBeenCalled();
    const bound = await runDaoFinance({ policy: { finance: { commerce: { buyerOrgId: 'actual-org' } } }, policyVersion: 1, actorId: 'gh:42', action: { op: 'inspect' } }, d);
    expect(d.commerce).toHaveBeenCalledWith({ buyerOrgId: 'actual-org', actingUserId: 'gh:42' });
    expect(bound).toMatchObject({ commerce: { status: 'error', message: 'Organization is not in the commerce roster.' } });
  });
  it('prepares exact contract calldata from the verified wallet and signed deployment only', async () => {
    const d = deps(); const input = { policy: { finance: { equity } }, policyVersion: 7, actorId: 'gh:42', action: { op: 'prepare-equity' as const, expectedPolicyVersion: 7, contract: 'PapercuspEquity' as const, functionName: 'requestRecovery', args: ['1', address('5')] } };
    const result = await runDaoFinance(input, d) as { unsignedTransaction: { data: `0x${string}` } };
    expect(result).toMatchObject({ ok: true, unsignedTransaction: { from: address('4'), to: equity.equity, requiresWalletSignature: true, value: '0' } });
    expect(decodeFunctionData({ abi: equityArtifacts.contracts.PapercuspEquity.abi, data: result.unsignedTransaction.data })).toMatchObject({ functionName: 'requestRecovery', args: [1n, address('5')] });
    await expect(runDaoFinance({ ...input, policyVersion: 8 }, d)).rejects.toThrow('Policy changed');
    d.wallet = vi.fn().mockResolvedValue({ ok: true, value: { binding: { walletAddress: address('4'), chainId: 2 } } });
    await expect(runDaoFinance(input, d)).rejects.toThrow('verified wallet');
  });
  it('refuses an integrity failure before preparing a wallet transaction', async () => {
    const d = deps(); d.equity = vi.fn().mockResolvedValue({ governanceBound: false, supplyInvariant: true });
    await expect(runDaoFinance({ policy: { finance: { equity } }, policyVersion: 7, actorId: 'gh:42', action: { op: 'prepare-equity', expectedPolicyVersion: 7, contract: 'PapercuspEquity', functionName: 'requestRecovery', args: ['1', address('5')] } }, d)).rejects.toThrow('integrity');
  });
});
