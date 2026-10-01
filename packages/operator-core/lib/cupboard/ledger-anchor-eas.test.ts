/**
 * EAS anchor backend (P-041, R-29). Runs the real viem clients against a local
 * JSON-RPC chain stand-in, so the encoding, schema registration, Attested-event
 * parsing and the public read-back are exercised end to end with no network.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToHex,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  http,
  keccak256,
  numberToHex,
  recoverTransactionAddress,
  stringToHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { appendLinks, entryDigest } from '@papercusp/hash-chain';
import {
  ANCHOR_SCHEMA,
  ANCHOR_SCHEMA_UID,
  DEFAULT_ANCHOR_RPC_URL,
  EAS_ABI,
  EAS_PREDEPLOY,
  SCHEMA_REGISTRY_ABI,
  SCHEMA_REGISTRY_PREDEPLOY,
  decodeAnchorData,
  easAnchorBackend,
  easAnchorReader,
  encodeAnchorData,
  resolveAnchorBackend,
} from './ledger-anchor-eas';
import {
  HOUR_SECONDS,
  buildInclusionBundle,
  memoryLedgerAnchorStore,
  runAnchorTick,
  verifyInclusionBundle,
  type AnchorInclusionBundle,
  type AnchorPublication,
} from './ledger-anchor';

interface StoredAttestation {
  uid: Hex;
  schema: Hex;
  time: bigint;
  revocationTime: bigint;
  attester: Address;
  data: Hex;
}

/** A minimal EAS chain: answers exactly the JSON-RPC a viem local-account write + read needs. */
function mockChain() {
  const schemas = new Set<string>();
  const attestations = new Map<string, StoredAttestation>();
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: { method: string; to?: string; fn?: string }[] = [];
  let block = 100n;

  const handle = async (method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(baseSepolia.id);
      case 'eth_blockNumber':
        return numberToHex(block);
      case 'eth_getBlockByNumber':
        return {
          number: numberToHex(block),
          hash: keccak256(numberToHex(block)),
          parentHash: zeroHash,
          timestamp: numberToHex(1_790_000_000n),
          baseFeePerGas: '0x1',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: [],
        };
      case 'eth_maxPriorityFeePerGas':
      case 'eth_gasPrice':
        return '0x1';
      case 'eth_getTransactionCount':
        return numberToHex(receipts.size);
      case 'eth_estimateGas':
        return '0x40000';
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        if (to.toLowerCase() === SCHEMA_REGISTRY_PREDEPLOY.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: SCHEMA_REGISTRY_ABI, data });
          calls.push({ method, to, fn: 'getSchema' });
          const uid = args[0] as Hex;
          const known = schemas.has(uid.toLowerCase());
          return encodeFunctionResult({
            abi: SCHEMA_REGISTRY_ABI,
            functionName: 'getSchema',
            result: { uid: known ? uid : zeroHash, resolver: zeroAddress, revocable: false, schema: known ? ANCHOR_SCHEMA : '' },
          });
        }
        const { args } = decodeFunctionData({ abi: EAS_ABI, data });
        calls.push({ method, to, fn: 'getAttestation' });
        const a = attestations.get((args[0] as Hex).toLowerCase());
        return encodeFunctionResult({
          abi: EAS_ABI,
          functionName: 'getAttestation',
          result: {
            uid: a?.uid ?? zeroHash,
            schema: a?.schema ?? zeroHash,
            time: a?.time ?? 0n,
            expirationTime: 0n,
            revocationTime: a?.revocationTime ?? 0n,
            refUID: zeroHash,
            recipient: zeroAddress,
            attester: a?.attester ?? zeroAddress,
            revocable: false,
            data: a?.data ?? '0x',
          },
        });
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        const hash = keccak256(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        const { parseTransaction } = await import('viem');
        const tx = parseTransaction(raw as never);
        const logs: Record<string, unknown>[] = [];
        block += 1n;
        if (tx.to?.toLowerCase() === SCHEMA_REGISTRY_PREDEPLOY.toLowerCase()) {
          calls.push({ method, to: tx.to, fn: 'register' });
          schemas.add(ANCHOR_SCHEMA_UID.toLowerCase());
        } else {
          const { args } = decodeFunctionData({ abi: EAS_ABI, data: tx.data! });
          calls.push({ method, to: tx.to!, fn: 'attest' });
          const req = args[0] as { schema: Hex; data: { data: Hex } };
          if (!schemas.has(req.schema.toLowerCase())) throw new Error('InvalidSchema');
          const uid = keccak256(concatHex([hash, req.schema]));
          attestations.set(uid, { uid, schema: req.schema, time: 1_790_000_100n, revocationTime: 0n, attester: from, data: req.data.data });
          logs.push({
            address: EAS_PREDEPLOY,
            topics: encodeEventTopics({ abi: EAS_ABI, eventName: 'Attested', args: { recipient: zeroAddress, attester: from, schemaUID: req.schema } }),
            data: encodeAbiParameters([{ type: 'bytes32' }], [uid]),
            blockNumber: numberToHex(block),
            blockHash: keccak256(numberToHex(block)),
            transactionHash: hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          });
        }
        receipts.set(hash, {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: keccak256(numberToHex(block)),
          blockNumber: numberToHex(block),
          from,
          to: tx.to,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logs,
          logsBloom: `0x${'0'.repeat(512)}`,
          status: '0x1',
          type: '0x2',
        });
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0] as string) ?? null;
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  };

  let server: Server | null = null;
  return {
    schemas,
    attestations,
    calls,
    async listen(): Promise<string> {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
          handle(msg.method, msg.params ?? []).then(
            (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })),
            (err: Error) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } })),
          );
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/rpc`;
    },
    async close(): Promise<void> {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    },
  };
}

const PUB: AnchorPublication = {
  logId: 'papercusp:ws-eas',
  logRoot: 'ab'.repeat(32),
  treeSize: 7,
  windowStart: 1_789_996_400,
  windowEnd: 1_790_000_000,
};

describe('ledger anchor EAS encoding', () => {
  it('derives the schema UID exactly as SchemaRegistry does (abi.encodePacked(schema, resolver, revocable))', () => {
    const packed = concatHex([stringToHex(ANCHOR_SCHEMA), zeroAddress, '0x00']);
    expect(ANCHOR_SCHEMA_UID).toBe(keccak256(packed));
  });

  it('round-trips a publication through the attestation data', () => {
    expect(decodeAnchorData(encodeAnchorData(PUB))).toEqual(PUB);
    expect(() => encodeAnchorData({ ...PUB, logRoot: 'AB'.repeat(32) })).toThrow(/lowercase hex/);
  });
});

describe('ledger anchor EAS backend against a chain', () => {
  let chain: ReturnType<typeof mockChain>;
  let url: string;
  beforeEach(async () => {
    chain = mockChain();
    url = await chain.listen();
  });
  afterEach(async () => {
    await chain.close();
  });

  it('registers the schema once, attests, and the public reader recovers the anchored root', async () => {
    const cfg = { chain: baseSepolia, transport: http(url), pollingIntervalMs: 10 };
    const backend = easAnchorBackend({ ...cfg, privateKey: generatePrivateKey() });
    const r1 = await backend.publish(PUB);
    const r2 = await backend.publish({ ...PUB, treeSize: 9, windowStart: PUB.windowEnd, windowEnd: PUB.windowEnd + HOUR_SECONDS });
    expect(chain.calls.filter((c) => c.fn === 'register')).toHaveLength(1);
    expect(chain.calls.filter((c) => c.fn === 'attest')).toHaveLength(2);
    expect(r1).toMatchObject({ backend: 'eas', chainId: baseSepolia.id, attester: backend.attester.toLowerCase() });
    expect(r1.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r1.ref).not.toBe(r2.ref);

    const reader = easAnchorReader(cfg);
    await expect(reader.read(r1.ref)).resolves.toEqual({ ...PUB, attester: backend.attester.toLowerCase(), revoked: false });
    await expect(reader.read(bytesToHex(new Uint8Array(32).fill(7)))).resolves.toBeNull();
    await expect(reader.read('not-a-uid')).resolves.toBeNull();
  });

  it('reads an attestation under another schema as absent, and flags a revoked one', async () => {
    const cfg = { chain: baseSepolia, transport: http(url), pollingIntervalMs: 10 };
    const backend = easAnchorBackend({ ...cfg, privateKey: generatePrivateKey() });
    const { ref } = await backend.publish(PUB);
    const stored = chain.attestations.get(ref as Hex)!;
    stored.revocationTime = 1n;
    await expect(easAnchorReader(cfg).read(ref)).resolves.toMatchObject({ revoked: true });
    stored.schema = keccak256(stringToHex('some other schema'));
    await expect(easAnchorReader(cfg).read(ref)).resolves.toBeNull();
  });

  it('self-hosted: a configured RPC and key are the only endpoint and identity used, end to end', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'anchor-key-'));
    try {
      const keyFile = path.join(dir, 'key');
      writeFileSync(keyFile, `${generatePrivateKey()}\n`);
      chmodSync(keyFile, 0o600);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const resolved = resolveAnchorBackend(
        { PAPERCUSP_LEDGER_ANCHOR_RPC_URL: url, PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: keyFile },
        { pollingIntervalMs: 10 },
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const store = memoryLedgerAnchorStore();
      const links = appendLinks('money-journal', null, [entryDigest({ amountCents: 500 }), entryDigest({ amountCents: -20 })]);
      const feed = { links: async () => links.map((l) => ({ streamId: l.streamId, seq: l.seq, entryHash: l.entryHash })) };
      const tick = await runAnchorTick({
        workspaceId: 'ws-self',
        logId: 'self:ws-self',
        nowSeconds: 1_790_000_000 + 60,
        store,
        feed,
        backend: resolved.backend,
      });
      expect(tick.status).toBe('anchored');
      const bundle = await buildInclusionBundle({ workspaceId: 'ws-self', link: links[1]!, entry: { amountCents: -20 }, store });
      const portable = JSON.parse(JSON.stringify(bundle)) as AnchorInclusionBundle;
      await expect(
        verifyInclusionBundle(portable, resolved.reader, { expectedAttester: resolved.backend.attester }),
      ).resolves.toMatchObject({ ok: true });

      const urls = fetchSpy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
      expect(urls.length).toBeGreaterThan(0);
      expect(new Set(urls)).toEqual(new Set([url]));
      expect(urls.some((u) => u.startsWith(DEFAULT_ANCHOR_RPC_URL))).toBe(false);
      fetchSpy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAnchorBackend refusals', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'anchor-cfg-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const key = (body: string, mode = 0o600): string => {
    const f = path.join(dir, `k-${Math.random().toString(36).slice(2)}`);
    writeFileSync(f, body);
    chmodSync(f, mode);
    return f;
  };

  it('defaults to Base Sepolia and the public RPC', () => {
    const r = resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: path.join(dir, 'absent') });
    expect(r.config).toMatchObject({ backend: 'eas', rpcUrl: DEFAULT_ANCHOR_RPC_URL, chainId: baseSepolia.id });
    expect(r).toMatchObject({ ok: false, reason: 'key-missing' });
    // Reading needs no key: a verifier can still check bundles.
    expect(r.reader).not.toBeNull();
  });

  it.each([
    ['disabled', { PAPERCUSP_LEDGER_ANCHOR_BACKEND: 'none' }],
    ['unsupported-chain', { PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '1' }],
    ['mainnet-not-enabled', { PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '8453' }],
  ] as const)('%s', (reason, env) => {
    expect(resolveAnchorBackend({ ...env, PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(generatePrivateKey()) })).toMatchObject({ ok: false, reason });
  });

  it('refuses a group/other-readable key and a malformed key', () => {
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(generatePrivateKey(), 0o644) })).toMatchObject({
      ok: false,
      reason: 'key-permissions',
    });
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key('not a key') })).toMatchObject({ ok: false, reason: 'key-invalid' });
  });

  it('accepts a 0x-less key, and mainnet only with the explicit opt-in', () => {
    const bare = generatePrivateKey().slice(2);
    expect(resolveAnchorBackend({ PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(bare) }).ok).toBe(true);
    expect(
      resolveAnchorBackend({
        PAPERCUSP_LEDGER_ANCHOR_KEY_FILE: key(bare),
        PAPERCUSP_LEDGER_ANCHOR_CHAIN_ID: '8453',
        PAPERCUSP_LEDGER_ANCHOR_ALLOW_MAINNET: '1',
      }).ok,
    ).toBe(true);
  });
});
