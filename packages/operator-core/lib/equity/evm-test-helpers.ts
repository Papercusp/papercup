/** Actual signed Cancun EVM transactions; no mocked contract storage or behavior. */
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createLegacyTx } from '@ethereumjs/tx';
import { createAccount, createAddressFromPrivateKey, createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, decodeErrorResult, keccak256, stringToHex, getAddress, type Abi, type Address, type Hex } from 'viem';
import { readFileSync } from 'node:fs';
import type { EquityArtifacts, EquityContractName } from './compile';

export const artifacts = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8')) as EquityArtifacts;
export const digest = (s: string) => keccak256(stringToHex(s));
export const TERMS = digest('Fixture issuer signed ownership-register documents');
export type Contract = { address: Address; abi: Abi };
export type Action = { contract: Contract; name: string; args?: unknown[] };

export async function equityEvm() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  const keys = Array.from({ length: 8 }, (_, i) => hexToBytes(('0x' + (i + 1).toString(16).padStart(64, '0')) as Hex));
  const accounts = keys.map(k => getAddress(createAddressFromPrivateKey(k).toString()));
  for (const address of accounts) await vm.stateManager.putAccount(createAddressFromString(address), createAccount({ balance: 10n ** 26n }));
  let time = 1_800_000_000n;
  let number = 1n;
  const block = () => createBlock({ header: { number, timestamp: time, gasLimit: 60_000_000n, baseFeePerGas: 1n } }, { common });
  const error = (abi: Abi, data: Hex) => {
    try { return decodeErrorResult({ abi, data }).errorName; } catch { return data; }
  };
  async function raw(data: Hex, to?: Address, sender = 0, abi: Abi = []) {
    ++time; ++number;
    const account = await vm.stateManager.getAccount(createAddressFromString(accounts[sender]));
    const tx = createLegacyTx({ nonce: account!.nonce, gasLimit: 50_000_000n, gasPrice: 10n, data, ...(to ? { to } : {}) }, { common }).sign(keys[sender]);
    const result = await runTx(vm, { tx, block: block() });
    const output = bytesToHex(result.execResult.returnValue) as Hex;
    if (result.execResult.exceptionError) throw new Error('EVM reverted: ' + error(abi, output) + ' (' + result.execResult.exceptionError.error + ')');
    return { result, output };
  }
  async function deploy(name: EquityContractName, args: unknown[] = []): Promise<Contract> {
    const artifact = artifacts.contracts[name];
    const { result } = await raw(encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
    if (!result.createdAddress) throw new Error('No deployed address');
    return { address: result.createdAddress.toString() as Address, abi: artifact.abi };
  }
  async function send(c: Contract, name: string, args: unknown[] = [], sender = 0) {
    const { output } = await raw(encodeFunctionData({ abi: c.abi, functionName: name, args }), c.address, sender, c.abi);
    const fn = c.abi.find(f => f.type === 'function' && f.name === name);
    return fn && 'outputs' in fn && fn.outputs.length ? decodeFunctionResult({ abi: c.abi, functionName: name, data: output }) : undefined;
  }
  async function read(c: Contract, name: string, args: unknown[] = []) {
    const result = await vm.evm.runCall({ to: createAddressFromString(c.address), caller: createAddressFromString(accounts[0]),
      data: hexToBytes(encodeFunctionData({ abi: c.abi, functionName: name, args })), gasLimit: 50_000_000n, block: block(), isStatic: true });
    const output = bytesToHex(result.execResult.returnValue) as Hex;
    if (result.execResult.exceptionError) throw new Error('EVM read reverted: ' + error(c.abi, output));
    return decodeFunctionResult({ abi: c.abi, functionName: name, data: output });
  }
  const advance = (seconds: bigint | number) => { time += BigInt(seconds); ++number; };
  const now = () => time;
  const equity = await deploy('PapercuspEquity', [TERMS, 'https://issuer.example/legal/register-v1', 1_000_000n, 100_000n]);
  await send(equity, 'activateGenesis', [digest('founder-identity'), TERMS]);
  const timelock = await deploy('EquityTimelock', [86400n]);
  const governor = await deploy('EquityGovernor', [equity.address, timelock.address]);
  await send(timelock, 'initializeGovernor', [governor.address]);
  await send(equity, 'bindGovernance', [governor.address, timelock.address]);
  advance(2);
  const actionData = (actions: Action[]) => ({ targets: actions.map(a => a.contract.address), values: actions.map(() => 0n),
    calldatas: actions.map(a => encodeFunctionData({ abi: a.contract.abi, functionName: a.name, args: a.args ?? [] })) });
  async function propose(actions: Action[], description: string, sender = 0) {
    const data = actionData(actions);
    const id = await send(governor, 'propose', [data.targets, data.values, data.calldatas, description], sender) as bigint;
    return { ...data, descriptionHash: digest(description), id };
  }
  async function finish(proposal: Awaited<ReturnType<typeof propose>>, voters = [0]) {
    advance(61);
    for (const voter of voters) await send(governor, 'castVote', [proposal.id, 1], voter);
    advance(Number(await read(governor, 'votingPeriod')) + 1);
    await send(governor, 'queue', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
    advance(Number(await read(timelock, 'getMinDelay')) + 1);
    await send(governor, 'execute', [proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash]);
  }
  let sequence = 0;
  async function govern(actions: Action[], voters = [0]) { const p = await propose(actions, 'Fixture governance action ' + ++sequence); await finish(p, voters); return p; }
  async function register(sender: number, voters = [0]) {
    await govern([{ contract: equity, name: 'registerHolder', args: [accounts[sender], digest('holder-' + sender)] }], voters);
    await send(equity, 'acceptTerms', [TERMS], sender);
  }
  return { vm, accounts, read, send, raw, deploy, advance, now, equity, governor, timelock, govern, propose, finish, register, actionData };
}
