/** Pilot EVM/stablecoin settlement adapter (P-022), with RPC submission injected. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { PaymentChannelState } from './payment-channel';

export interface EvmSettlementConfig {
  readonly chainId: number;
  readonly settlementContract: string;
  readonly stablecoin: string;
  readonly maxBatchSize: number;
}

export type EvmConfigResult = { ok: true; config: EvmSettlementConfig } | { ok: false; code: 'invalid-chain' | 'invalid-address' | 'invalid-batch-size'; detail: string };

export function validateEvmSettlementConfig(config: EvmSettlementConfig): EvmConfigResult {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) return { ok: false, code: 'invalid-chain', detail: 'chainId must be a positive safe integer' };
  const address = /^0x[0-9a-fA-F]{40}$/;
  if (!address.test(config.settlementContract) || !address.test(config.stablecoin)) return { ok: false, code: 'invalid-address', detail: 'settlementContract and stablecoin must be 20-byte EVM addresses' };
  if (!Number.isSafeInteger(config.maxBatchSize) || config.maxBatchSize < 1 || config.maxBatchSize > 500) return { ok: false, code: 'invalid-batch-size', detail: 'maxBatchSize must be between 1 and 500' };
  return { ok: true, config };
}

export interface EvmBatchSettlementRequest {
  readonly chainId: number;
  readonly to: string;
  readonly stablecoin: string;
  readonly channelId: string;
  readonly amountMicros: bigint;
  readonly voucherDigests: readonly string[];
  readonly calldata: string;
  readonly requestHash: string;
}

export type EvmRequestResult = { ok: true; request: EvmBatchSettlementRequest } | { ok: false; code: 'invalid-config' | 'wrong-rail' | 'empty-batch' | 'batch-too-large' | 'amount-invalid'; detail: string };

/** Build deterministic calldata-like bytes for an injected EVM RPC client. */
export function buildEvmBatchSettlementRequest(input: { config: EvmSettlementConfig; channel: PaymentChannelState; amountMicros: bigint; voucherDigests: readonly string[] }): EvmRequestResult {
  const config = validateEvmSettlementConfig(input.config);
  if (!config.ok) return { ok: false, code: 'invalid-config', detail: config.detail };
  if (input.channel.rail !== 'evm-x402') return { ok: false, code: 'wrong-rail', detail: `channel rail '${input.channel.rail}' is not evm-x402` };
  if (input.voucherDigests.length === 0) return { ok: false, code: 'empty-batch', detail: 'at least one voucher digest is required' };
  if (input.voucherDigests.length > config.config.maxBatchSize) return { ok: false, code: 'batch-too-large', detail: 'voucher batch exceeds configured maxBatchSize' };
  if (input.amountMicros <= 0n || input.amountMicros > input.channel.escrowMicros - input.channel.settledMicros) return { ok: false, code: 'amount-invalid', detail: 'amount must be positive and within channel escrow' };
  const body = { amountMicros: input.amountMicros.toString(), channelId: input.channel.channelId, chainId: config.config.chainId, stablecoin: config.config.stablecoin.toLowerCase(), to: config.config.settlementContract.toLowerCase(), voucherDigests: [...input.voucherDigests] };
  const calldata = Buffer.from(canonicalJson(body), 'utf8').toString('hex');
  return { ok: true, request: { ...body, calldata: `0x${calldata}`, requestHash: createHash('sha256').update(calldata).digest('hex') } };
}
