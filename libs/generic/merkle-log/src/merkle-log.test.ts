import { describe, expect, it } from 'vitest';
import {
  EMPTY_ROOT,
  consistencyProof,
  inclusionProof,
  leafHash,
  nodeHash,
  rootHash,
  verifyConsistency,
  verifyInclusion,
} from './merkle-log';

// RFC 6962 / RFC 9162 reference tree: leaf inputs and root hashes per size,
// from transparency-dev/merkle testonly/constants.go (fetched 2026-10-01).
const LEAF_INPUTS = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'];
const ROOTS = [
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];
const LEAVES = LEAF_INPUTS.map((hex) => leafHash(Buffer.from(hex, 'hex')));

// Proof vectors of the Certificate Transparency reference test suite for the
// same tree (merkle_tree_test / transparency-dev testdata).
const INCLUSION: Array<{ index: number; size: number; proof: string[] }> = [
  { index: 0, size: 1, proof: [] },
  {
    index: 0,
    size: 8,
    proof: [
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ],
  },
  {
    index: 5,
    size: 8,
    proof: [
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ],
  },
  { index: 2, size: 3, proof: ['fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125'] },
  {
    index: 1,
    size: 5,
    proof: [
      '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
    ],
  },
];
const CONSISTENCY: Array<{ oldSize: number; newSize: number; proof: string[] }> = [
  { oldSize: 1, newSize: 1, proof: [] },
  {
    oldSize: 1,
    newSize: 8,
    proof: [
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ],
  },
  {
    oldSize: 6,
    newSize: 8,
    proof: [
      '0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ],
  },
  {
    oldSize: 2,
    newSize: 5,
    proof: [
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
    ],
  },
];

const syntheticLeaves = (n: number): string[] => Array.from({ length: n }, (_, i) => leafHash(`leaf-${i}`));
const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

describe('merkle-log reference vectors', () => {
  it('reproduces the reference root for every tree size', () => {
    expect(EMPTY_ROOT).toBe(ROOTS[0]);
    for (let n = 0; n <= LEAVES.length; n += 1) expect(rootHash(LEAVES, n)).toBe(ROOTS[n]);
  });

  it('reproduces the reference inclusion proofs, and each verifies against the reference root', () => {
    for (const v of INCLUSION) {
      expect(inclusionProof(LEAVES, v.index, v.size)).toEqual(v.proof);
      expect(
        verifyInclusion({ leafHash: LEAVES[v.index]!, index: v.index, treeSize: v.size, proof: v.proof, root: ROOTS[v.size]! }),
      ).toBe(true);
    }
  });

  it('reproduces the reference consistency proofs, and each verifies between the reference roots', () => {
    for (const v of CONSISTENCY) {
      expect(consistencyProof(LEAVES, v.oldSize, v.newSize)).toEqual(v.proof);
      expect(
        verifyConsistency({
          oldSize: v.oldSize,
          newSize: v.newSize,
          oldRoot: ROOTS[v.oldSize]!,
          newRoot: ROOTS[v.newSize]!,
          proof: v.proof,
        }),
      ).toBe(true);
    }
  });

  it('domain-separates leaves from interior nodes', () => {
    const a = leafHash('a');
    const b = leafHash('b');
    expect(rootHash([a, b])).toBe(nodeHash(a, b));
    // A forged "leaf" whose data is the concatenation of two child hashes must not collide with their parent.
    expect(leafHash(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]))).not.toBe(nodeHash(a, b));
  });
});

describe('merkle-log exhaustive inclusion (sizes 1..40)', () => {
  it('every leaf of every tree verifies, and any altered input is refused', () => {
    const leaves = syntheticLeaves(40);
    for (let size = 1; size <= 40; size += 1) {
      const root = rootHash(leaves, size);
      for (let index = 0; index < size; index += 1) {
        const proof = inclusionProof(leaves, index, size);
        const ok = { leafHash: leaves[index]!, index, treeSize: size, proof, root };
        expect(verifyInclusion(ok)).toBe(true);
        // A leaf that is not in the tree (a non-member) is refused.
        expect(verifyInclusion({ ...ok, leafHash: leafHash(`not-a-member-${index}`) })).toBe(false);
        expect(verifyInclusion({ ...ok, root: flip(root) })).toBe(false);
        expect(verifyInclusion({ ...ok, index: index + size })).toBe(false);
        if (proof.length > 0) {
          expect(verifyInclusion({ ...ok, proof: proof.slice(0, -1) })).toBe(false);
          expect(verifyInclusion({ ...ok, proof: [...proof.slice(0, -1), flip(proof.at(-1)!)] })).toBe(false);
        }
        if (size > 1) {
          const other = (index + 1) % size;
          if (leaves[other] !== leaves[index]) expect(verifyInclusion({ ...ok, index: other })).toBe(false);
        }
      }
    }
  });

  it('refuses malformed input instead of throwing', () => {
    expect(verifyInclusion({ leafHash: 'xyz', index: 0, treeSize: 1, proof: [], root: EMPTY_ROOT })).toBe(false);
    expect(verifyInclusion({ leafHash: EMPTY_ROOT, index: -1, treeSize: 1, proof: [], root: EMPTY_ROOT })).toBe(false);
    expect(verifyInclusion({ leafHash: EMPTY_ROOT, index: 0, treeSize: 0, proof: [], root: EMPTY_ROOT })).toBe(false);
  });
});

describe('merkle-log exhaustive consistency (sizes 0..40)', () => {
  it('every prefix is provably consistent with every extension, and an altered root is refused', () => {
    const leaves = syntheticLeaves(40);
    for (let newSize = 1; newSize <= 40; newSize += 1) {
      const newRoot = rootHash(leaves, newSize);
      for (let oldSize = 0; oldSize <= newSize; oldSize += 1) {
        const oldRoot = rootHash(leaves, oldSize);
        const proof = consistencyProof(leaves, oldSize, newSize);
        const ok = { oldSize, newSize, oldRoot, newRoot, proof };
        expect(verifyConsistency(ok)).toBe(true);
        if (oldSize > 0) {
          expect(verifyConsistency({ ...ok, oldRoot: flip(oldRoot) })).toBe(false);
          expect(verifyConsistency({ ...ok, newRoot: flip(newRoot) })).toBe(false);
        }
        if (proof.length > 0) expect(verifyConsistency({ ...ok, proof: proof.slice(1) })).toBe(false);
      }
    }
  });

  it('refuses a history rewrite: a log whose old leaves changed is not consistent with the old root', () => {
    const leaves = syntheticLeaves(12);
    const oldRoot = rootHash(leaves, 7);
    const rewritten = [...leaves];
    rewritten[3] = leafHash('rewritten');
    const proof = consistencyProof(rewritten, 7, 12);
    expect(verifyConsistency({ oldSize: 7, newSize: 12, oldRoot, newRoot: rootHash(rewritten, 12), proof })).toBe(false);
  });
});
