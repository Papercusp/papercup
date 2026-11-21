/** Source evidence for phase admission. Inventory is independent of executing a writer.
 * Reuse the maintained TypeScript site collector and PostgreSQL grammar; a parse
 * failure or unresolved edge is retained, never interpreted as an exemption.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, gunzipSync, inflateSync } from 'node:zlib';
import ts from 'typescript';
import { parse } from 'pgsql-ast-parser';
import { censusSites } from '../../../../scripts/lib/source-path-census.mjs';
import { listFilesIncludingUntracked } from '../../../../scripts/lib/tracked-files.mjs';
import { buildSymbolSnapshot, relativeSymbolModule, type SymbolDeclaration } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { readPngDimensionsSafe } from '../design-compare/png-header.js';

export const PHASE_WRITER_ROOTS = ['packages/', 'apps/', 'libs/', 'scripts/'] as const;
const generatedOutputPrefixes = [
  ['apps/operator/public/internal/docs/', 'generated-docs-mirror:apps/operator-docs/scripts/postbuild-copy.sh'],
  ['apps/operator/public/docs/', 'generated-docs-mirror:apps/papercusp-docs/scripts/postbuild-copy.sh'],
  ['libs/generic/papergrid/grid-core/storybook-static/',
    'generated-storybook-output:libs/generic/papergrid/grid-core/package.json#scripts.build-storybook'],
] as const;
const wranglerLocalStateRoot = 'apps/operator-public/.wrangler/state/v3/';
const wranglerLocalStateReason = 'generated-wrangler-local-state:apps/operator-public/package.json#scripts.dev';
const miniflareSqlitePath = /^(?:cache\/miniflare-CacheObject|d1\/miniflare-D1DatabaseObject|kv\/miniflare-KVNamespaceObject|r2\/miniflare-R2BucketObject)\/(?:metadata|[0-9a-f]{64})\.sqlite(?:-(shm|wal))?$/;
const sqliteHeader = Buffer.from('SQLite format 3\0');
const looseGitObjectPath = /(?:^|\/)[^/]+\.git\/objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/;
// A census pass inflates at most 16 MiB per binary artifact. Larger artifacts
// remain source gaps with their exact compressed digest for review.
const binaryArtifactInflateLimit = 16 * 1024 * 1024;
// These file: dependencies contain source under their own archive paths. The
// census uses a complete layout for each exact compressed artifact, and the
// tar-reader regression verifies every member name and content in the layouts.
type NpmArchiveLayout = {
  sha256: string;
  decodedBytes: number;
  members: ReadonlyArray<readonly [name: string, offset: number, size: number]>;
};
const reviewedNpmArchives = new Map<string, NpmArchiveLayout>([
  ['apps/slack-asana-bug-drill/vendor/papercusp-embedded-pg-discovery-0.1.0.tgz', {
    sha256: 'e28bcdae350b213635369ab0ec0e671dcfcc06e115e050ed082dfa65c11a7f19',
    decodedBytes: 39936,
    members: [
      ['package/LICENSE', 512, 10754],
      ['package/package.json', 12288, 579],
      ['package/README.md', 13824, 1006],
      ['package/SECURITY.md', 15360, 848],
      ['package/src/index.test.ts', 16896, 10873],
      ['package/src/index.ts', 28672, 8107],
      ['package/src/package-content.test.ts', 37376, 1353],
    ],
  }],
  ['apps/slack-asana-bug-drill/vendor/papercusp-module-singleton-0.1.0.tgz', {
    sha256: '566c52824dc1bbbbea9cfa58e8de48fe94c8fb9e2c1cfd97cf0bdab749efa88e',
    decodedBytes: 30208,
    members: [
      ['package/package.json', 512, 651],
      ['package/tsconfig.json', 2048, 432],
      ['package/README.md', 3072, 3429],
      ['package/TESTING.md', 7168, 1323],
      ['package/src/index.test.ts', 9216, 7654],
      ['package/src/index.ts', 17408, 7739],
      ['package/src/module-scoped-control.fixture.ts', 26112, 1311],
      ['package/src/pinned-subject.fixture.ts', 28160, 789],
    ],
  }],
]);
const drillGitObjectRoot = 'packages/operator-core/hive-git-root/wi3496-drill/papercusp.git/objects/';
// Both namespace work refs are parentless commits of the empty tree. Their
// full messages are `tower-work\n` and `vm-work\n`. Pin the compressed bytes
// and exact fixture location so another commit or encoding requires review.
const drillGitCommitFingerprints = new Map([
  ['3ab4d0acf690da7388f3ee9dd52a7e07cda15988', '8b4a44cd5187d64334a15be330564418ae674809e5e27c2b900479612752c420'],
  ['fcd0927af7a82559a02d7784c883c387b461960c', 'ebc9d09ffb1cdffd2315880c1bba75a6a1e9f8969ace7154088d257da9adba9e'],
]);
const lostPixelProjects = new Set([
  'apps/operator', 'libs/agent-chat', 'libs/generic/papergrid/grid-core',
  'libs/generic/ui-primitives', 'libs/marketplace-public-ui',
]);
const lostPixelPngPath = /^(.+)\/(lostpixel-(?:baseline|current))\/[a-z0-9][a-z0-9_-]*--[a-z0-9][a-z0-9_-]*\.png$/;
const lostPixelOutputFields = {
  'lostpixel-baseline': 'imagePathBaseline',
  'lostpixel-current': 'imagePathCurrent',
} as const;
const desktopIconRole = {
  path: 'libs/papercusp/apps/desktop/src-tauri/tauri.conf.json',
  sha256: '97fd4b48ee16d5c9ad758044a29b4228003e74ab611e168d2189343b98bedb72',
  kind: 'tauri-bundle-icon',
};
const framesScreenshotRole = {
  path: 'apps/operator/e2e/frames-live-view.spec.ts',
  sha256: 'b90edea81a6e1b1fab06697467c52ec6c4e33b9f8e5b09f014b093e14bdf0e3c',
  kind: 'playwright-screenshot',
};
const swarmBrandRasterRole = {
  path: 'apps/operator/public/brand/the-hive/README.md',
  sha256: '6281c1fd29863720545ad82de96416cd2c725bbbf369b25c4b138b9a1f8b4ee9',
  kind: 'documented-brand-asset',
};
const swarmDesktopRasterRoot = 'libs/papercusp/apps/desktop/src-tauri/icons/the-hive/';
const overlayDesignRoot = 'apps/operator/docs/design/plans-os-overlay-2026-10-26/';
const overlayDesignRole = {
  path: overlayDesignRoot + 'index.html',
  sha256: '3708fd4e1b019e2d0ee704fb546719e4dc159f753a4b28e7282b410ea7b2d8db',
  kind: 'design-review-screenshot',
};
const overlayAlternativesRole = {
  path: overlayDesignRoot + 'alternatives.html',
  sha256: '5ea0e738bdb86eeee2af7afbeb46cdd135b0fbbc0db4daefa69ed41a5f436f7a',
  kind: 'design-review-screenshot',
};
const swarmDesktopArtworkRole = {
  path: 'libs/papercusp/apps/desktop/src-tauri/icons/_source.svg',
  sha256: '9af61c0162a7582da513043143b4a83dcc955eb87ad6a002ce3378629248fb90',
  kind: 'desktop-brand-raster',
};
type ArtifactRoleSource = { path: string; sha256: string };
// The docs build copies public assets into dist and mirrors them into the
// operator's static docs directory. These PNGs remain in that mirror.
const docsDiagramRaster = {
  role: {
    path: 'apps/operator-docs/scripts/postbuild-copy.sh',
    sha256: '1b86d7d79872d9f913f23c5bc8096c7dcf7e62ff21089094ae744534f1a75826',
    kind: 'static-docs-diagram',
  },
  additionalRoleSources: [
    { path: 'apps/operator-docs/astro.config.mjs', sha256: '6993472fdbf21ab9bbcda9345a33613dc545263ac1a495a468dbd41fd3b33f61' },
    { path: 'apps/operator-docs/package.json', sha256: '12b11ef288855eda499eb22d0ecbb173e9dd76a71bf4f757397887f6fdbb739a' },
  ],
};
const operatorPublicRaster = {
  role: {
    path: 'apps/operator/bin/host-spa.ts',
    sha256: '93ee051bd480ac82bcf056367da780bb9f837f60d7d67028eff1240ee0379802',
    kind: 'static-spa-raster',
  },
  additionalRoleSources: [
    { path: 'apps/operator-vite/vite.config.ts', sha256: '37724b9ba8dcdbf18f25f96f756473043c4479fa0b1ad6234836c2c837bec094' },
    { path: 'apps/operator-vite/public-assets.ts', sha256: 'f0fac64555d5fab3b40920ba414e918416a41aa025512ea66ba66adb4d81b533' },
  ],
};
// Keep each reviewed binary and every source needed to establish its role
// pinned to the same snapshot. The PNGs end at IEND, and the ICO and ICNS
// containers hold raster records and their masks.
const reviewedBinaryArtifacts = new Map<string, {
  sha256: string;
  format?: 'binary';
  role: ArtifactRoleSource & { kind: string };
  additionalRoleSources?: readonly ArtifactRoleSource[];
}>([
  ['apps/operator/.papercusp/papercusp/hyperbee/db/MANIFEST-000005', {
    format: 'binary',
    sha256: '39de656bc3e01d0359e7d2f40c1fab828677d54796a47e6a4448578229ddf36b',
    role: {
      path: 'packages/operator-core/lib/sync/hyperbee/corestore.ts',
      sha256: '012e75d968b8a6503ea4a1c77a9c12b2a500c068fb5c543f6e2d4fb51d6a5322',
      kind: 'rocksdb-manifest-metadata',
    },
    additionalRoleSources: [
      { path: 'apps/operator/.papercusp/papercusp/hyperbee/db/CURRENT', sha256: '9c283f6e81028b9eb0760d918ee4bc0aa256ed3b926393c1734c760c4bd724fd' },
      { path: 'apps/operator/.papercusp/papercusp/hyperbee/db/OPTIONS-000007', sha256: '8c491e1c8cd22d2e708404d8e981d9e8933b9abbe498d6d88b7d8b75103d06d9' },
    ],
  }],
  ['packages/operator-core/lib/__fixtures__/kernel-anchor-rows.re-armed-predecessor.json.br', {
    format: 'binary',
    sha256: 'c184f14f95f4fd51c1dd56ae7283b81556dab1515c64d8889d8112ca9dd18e56',
    role: {
      path: 'packages/operator-core/lib/projected-tool-deps.kernel-resolver.test.ts',
      sha256: '3bd97e193734ea9509d6ae03ead816710ceff19bb87e1c696914e0fcdaf3640a',
      kind: 'brotli-json-test-fixture',
    },
  }],
  ['packages/operator-core/lib/dao-hr/fonts/NotoSans-Regular.ttf', {
    format: 'binary',
    sha256: 'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5',
    role: {
      path: 'packages/operator-core/lib/dao-hr/contracts-esign.ts',
      sha256: '6990f30e40b9132ac470cb2a7c4460970e26b6427d44b34da0cb3519c85a702a',
      kind: 'contract-pdf-font',
    },
  }],
  ['apps/operator-docs/public/diagrams/blueprint-operation-durability.png', {
    ...docsDiagramRaster,
    sha256: 'a3b5871f87d1d1caf35f52c7d5d67e7975d219b53c250335b1db7ffa7fd0ca73',
  }],
  ['apps/operator-docs/public/diagrams/blueprint-operation-lifecycle.png', {
    ...docsDiagramRaster,
    sha256: '52123ab9742b8eef0519cf77d1e44392308a43d2d1fc198e2c9c8838573e781b',
  }],
  ['apps/operator/public/favicon.ico', {
    ...operatorPublicRaster,
    sha256: '58cd31c44021676200298e67884af1ae3fcc507a22c45502b63b3b0fd0964051',
    role: { ...operatorPublicRaster.role, kind: 'static-spa-favicon' },
  }],
  ['apps/operator/public/_icon-debug/CURRENT_SOURCE.png', {
    ...operatorPublicRaster,
    sha256: 'ef9da0f7f3eac87db6d563c2d492d79e324d0f7e34b778237deccf33111ccd82',
  }],
  ['apps/operator/public/_icon-debug/SERVED-wordmark.png', {
    ...operatorPublicRaster,
    sha256: 'c7a81fadcc864c1bb9a9e8dab46d36b32b7a59a96e0337be3d394b5fba96c27d',
  }],
  ['apps/operator/public/_icon-debug/ic_launcher.png', {
    ...operatorPublicRaster,
    sha256: '39fea59e89be187e404059cd185a48d9dfd159e2cc0742596cd96bdb1129585e',
  }],
  ['apps/operator/public/_icon-debug/ic_launcher_foreground.png', {
    ...operatorPublicRaster,
    sha256: '125be5431eab30e345d161be10c8bff8cf5e849ac40f39865a862b0a6365fd27',
  }],
  ['apps/operator/public/_icon-debug/source-mascot.png', {
    ...operatorPublicRaster,
    sha256: 'ef9da0f7f3eac87db6d563c2d492d79e324d0f7e34b778237deccf33111ccd82',
  }],
  ['apps/operator/public/_icon-debug/source.png', {
    ...operatorPublicRaster,
    sha256: 'c05bd06bc5ef46fa680f1e252409c60736e57b66740db861a92082bd31ac6d42',
  }],
  ['apps/operator/public/_icon-debug/wordmark-as-icon.png', {
    ...operatorPublicRaster,
    sha256: 'be9a5c1aca2f8cd8b04e458b5b34ec02176959119a19ffe7751f6b56af5b747b',
  }],
  ['apps/operator/public/_mp-current.png', {
    ...operatorPublicRaster,
    sha256: '215969c625832bd7cff29948375726078d26b4abae75d1e95228f5dd56b4ce51',
  }],
  ['apps/operator/public/_mp-dev.png', {
    ...operatorPublicRaster,
    sha256: 'f0360c83492da076fea1a3426e8906896ed9c250318fc5f1bcb64290e252fb6c',
  }],
  ['apps/operator/public/deck-1440.png', {
    ...operatorPublicRaster,
    sha256: '101da07142e73dfb6cedce51b0b9cfc65186d3c7f0a92c0159f9526ba78d2029',
  }],
  ['apps/the-swarm-site/public/brand/swarm-hero.png', {
    // The caBX provenance record includes an SVG containing one path. The
    // pinned display and export sources serve the whole file as a static PNG.
    sha256: '089bf2e41bfe5fd3f285d8db922ca6d4a97c166dbfb2ffa05b37a936246ad8d9',
    role: {
      path: 'apps/the-swarm-site/app/page.tsx',
      sha256: '28b5426e0b50141bd242ddfcbf143420180db7f3e753d07135a56ecc782fc8c8',
      kind: 'static-site-image',
    },
    additionalRoleSources: [
      { path: 'apps/the-swarm-site/app/globals.css', sha256: '9268799a974e8b84b055789187f3acce1c839824b2ba3f96c00b3c5668187654' },
      { path: 'apps/the-swarm-site/app/layout.tsx', sha256: '642842602105ec6f3886b4280f571f7c25cf2dde98ab75410bd26bcdcb78cf5d' },
      { path: 'apps/the-swarm-site/next.config.js', sha256: '95fff0fc8094352c5f46f0c1bb7618ccd5772ea03a37c2b17828aba718093bd0' },
      { path: 'apps/the-swarm-site/package.json', sha256: 'f56508706c0f579c9f1f1956a7b03d9589a55a63487f52754efefdc2f0770ae3' },
    ],
  }],
  ['apps/operator/e2e/__artifacts__/adv-contributors-panel.png', {
    sha256: 'e4af00b5196779d437b244733aded78dc587c04e40c1c4a643bddf5c0dc071fa',
    role: {
      path: 'apps/operator/e2e/adv-contributors-panel.spec.ts',
      sha256: '3e28f0c725ef65c68a53b2e6a1632860bc26767bd4539ffa1f9213cf01b2b615',
      kind: 'playwright-screenshot',
    },
  }],
  ['apps/operator/e2e/__artifacts__/frames-tab-grid.png', {
    sha256: '041b87af9d6375f21ed9a861132f678ad3bc0d3538d43ecff6f94f92ac2c44f7',
    role: framesScreenshotRole,
  }],
  ['apps/operator/e2e/__artifacts__/frames-tab-panel.png', {
    sha256: 'e775c74a90c88652f68e77f2e1e7761571d3bb9f0a7afe45cba0efc7e8974aa1',
    role: framesScreenshotRole,
  }],
  ['apps/operator/e2e/__artifacts__/adv-work-items-filter.png', {
    sha256: '33b4fd15097c51f23764629053bdd2a81e0d57453a83e3bb7ecd9a6fdd0558c9',
    role: {
      path: 'apps/operator/e2e/adv-work-items-filter.spec.ts',
      sha256: 'f49af1ccc76fdd688099bbf360d32bad1de497224aac5c8dba82953209133602',
      kind: 'playwright-screenshot',
    },
  }],
  ...([
    ['alternative-agenda.png', '1812293357cb7317b405746bc09c4fa0c754d5b9f61c25e10307c836a7978d3c', overlayAlternativesRole],
    ['alternative-board.png', 'fd09507f61673bc9299549cca139421e7ab46282ccd688ebf69c86a53e0c8f7c', overlayAlternativesRole],
    ['alternative-launcher.png', '36503a175e0a226f9fb19114154be12e228e9e6bb1dba484866c82871d52b76a', overlayAlternativesRole],
    ['conversation.png', '7a4377e1b1cd9d22a51ed33f641d5330fc1ac4f4cb85b533bb7a012181db143b', overlayDesignRole],
    ['sidebar.png', '9da6e5768a07b8788a26b8df2b3f1d3efffc9a42ce3cb8be1a4c815f03cdd447', overlayDesignRole],
    ['workspace.png', '7ae343593e75ab9f861cdb01a05156bb411012eed7d8530ddb92c032ac44d7f7', overlayDesignRole],
  ] as const).map(([name, sha256, role]) => [overlayDesignRoot + name, { sha256, role }] as const),
  ['libs/papercusp/apps/desktop/src-tauri/icons/_master.png', {
    sha256: '43b33ac407e2c2d7d3430fd57924ab47570877da102435a790333887e621ae68', role: swarmDesktopArtworkRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/icon.png', {
    sha256: 'c9cb057233e5a1664b4d4a7fc30732d08a5d24e2032800dc688e13a9ddeb2beb', role: swarmDesktopArtworkRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/32x32.png', {
    sha256: '86128809f1f572eb24fd23dd248d5a8ab340161390e6cd07686672dcb786891e', role: desktopIconRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/128x128.png', {
    sha256: '187641126dc3c01953c8927765886cbf8f2d435114f455ed1280007286d0a4fc', role: desktopIconRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/128x128@2x.png', {
    sha256: 'd3a7e6c264795a3e7328d70472efd9c0418ba7354941a47be42b5b35f1668019', role: desktopIconRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/icon.icns', {
    sha256: '51033ffef7900f6b508069fcb974b1d99ec5a2f401caf4446378ee1c31b5be55', role: desktopIconRole,
  }],
  ['libs/papercusp/apps/desktop/src-tauri/icons/icon.ico', {
    sha256: '8ddda5b2a4240c6eae939eb9f38524a9e5cb14bd9d8f7eae343ada3d09b11a41', role: desktopIconRole,
  }],
  ['apps/operator/public/brand/the-hive/favicon.png', {
    sha256: '754469b6c6c2b80ff50a388ae4ccef0070e66b11973f2e96a29360e496aa43ac', role: swarmBrandRasterRole,
  }],
  ...([
    ['128x128.png', 'c5ec5b943f117b3fd8adf379864c5e2b3810431bab5dca61a79beefaaae28941'],
    ['128x128@2x.png', '474a13f4136b2f2b2c88aebacab1c398835d6208870a812e7a7c363a94d37dc4'],
    ['16x16.png', 'dff7deaf5f271c1c5201cb74562d5a806c9dd8a2532ec09750215c8f4e7d3118'],
    ['256x256.png', '474a13f4136b2f2b2c88aebacab1c398835d6208870a812e7a7c363a94d37dc4'],
    ['32x32.png', 'd5e88f1b223cee3af192645b67a83282558436a66fc58b7993749eb4b9e4e0b0'],
    ['64x64.png', '9fb4dd3280d35c0206f7ddd43c9e44b9eeb64c015ac2a41e72997621cc76a1fe'],
    ['_master.png', 'c1285c84d5863311ea5527090ca71638bdef9719634e43d8496a753f4041dd52'],
    ['icon.icns', 'f62f6ca341f07489435aeaa42516a0bb445a6d9d4c4ac41056a618aea977d8f2'],
    ['icon.ico', '009de81e61b791511674e0591dba9b997ecefe89a968615118e191031043a840'],
    ['icon.png', 'c1285c84d5863311ea5527090ca71638bdef9719634e43d8496a753f4041dd52'],
  ] as const).map(([name, sha256]) => [swarmDesktopRasterRoot + name, { sha256, role: swarmBrandRasterRole }] as const),
]);
export const PHASE_WRITER_RELATIONS = new Set([
  'plan_item_claims', 'work_items', 'engineer_issues', 'harness_features',
  'harness_features_consolidated', 'harness_plans', 'feature_claims',
]);
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const mutationText = /\b(?:insert\s+into|update|delete\s+from|merge\s+into|create\s+(?:or\s+replace\s+)?(?:function|trigger))\b/i;
const sqlMethod = /(?:^|\.)(?:unsafe|query|execute|exec)$/;
const sqlReadText = /^\s*(?:select|with|call|do|execute)\b/i;
// A builder call need not contain SQL or a known writer's name. These are
// syntax frontiers only: even a same-spelled non-database method stays in the
// population until its source-bound review establishes what it can mutate.
const mutationBuilderMethods = new Set([
  'insert', 'insertInto', 'update', 'updateTable', 'delete', 'deleteFrom',
  'merge', 'mergeInto', 'upsert', 'replaceInto',
]);
const nonCoerciveBinaryOperators = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const implicitDispatchReview = 'implicit-dispatch-requires-review';
const numericLiteralUnary = 'numeric-literal-unary';
const numericLiteralArithmetic = 'numeric-literal-arithmetic';
const primitiveLiteralTemplate = 'primitive-literal-template';
type PhaseWriterSyntaxWitness = typeof numericLiteralUnary | typeof numericLiteralArithmetic | typeof primitiveLiteralTemplate;
const primitiveLiteralKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword,
]);
const numericUnaryOperators = new Set<ts.SyntaxKind>([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken]);
const numericArithmeticOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
]);

export interface PhaseWriterSource { path: string; content: string }
/** Syntax evidence only. Tag arguments are the substitution expressions; the
 * complete template is separate. No argument evaluation/binding is inferred. */
export interface PhaseWriterInvocation {
  form: 'call' | 'construct' | 'tag';
  target: string;
  arguments: string[];
  template?: string;
  line: number;
  column: number;
}
/** Conservative syntax candidates, not value flow, callback closure or a
 * runtime argument binding. An unknown spread can supply any later slot;
 * retain every possible source, defaults and binding patterns intact. */
export interface PhaseWriterArgumentFlow {
  basis: 'syntax-only-not-runtime-binding';
  targetSha256: string;
  thisParameter?: string;
  spreadArguments: number[];
  extraArguments: number[];
  parameters: Array<{
    position: number;
    statement: string;
    rest: boolean;
    pattern: boolean;
    initializer?: string;
    argumentIndexes: number[];
    mayBeMissing: boolean;
  }>;
}
export interface PhaseWriterSite {
  /** Complete path, enclosing operation and statement digest; no display truncation. */
  id: string;
  path: string;
  operation: string;
  kind: 'sql' | 'sql-function' | 'authority-append' | 'helper-edge' | 'unresolved';
  sourceSha256: string;
  statementSha256: string;
  statement: string;
  line: number;
  relations: string[];
  columns: string[];
  dynamicEdges: string[];
  unresolved: string[];
  callees: string[];
  /** A maintained syntax-bound module resolution supplies review evidence,
   * never runtime reachability or a reason to exempt the call. */
  helperTarget?: { path: string; sha256: string; basis: 'syntax-bound-module-target-not-runtime-closure' };
  /** Exact syntax target, never callback binding or an effect exemption. */
  helperDeclaration?: SymbolDeclaration;
  invocation?: PhaseWriterInvocation;
  argumentFlow?: PhaseWriterArgumentFlow;
  syntaxWitness?: PhaseWriterSyntaxWitness;
}
export interface PhaseWriterInventory {
  schemaVersion: 1;
  scope: { kind: 'supplied-sources' } | { kind: 'repository'; root: string };
  sites: PhaseWriterSite[];
  sources: Array<{ path: string; sha256: string }>;
  /** Enumeration/read/parse gaps remain identities in the coverage population. */
  gaps: Array<{ id: string; reason: string; sha256?: string }>;
}
export type PhaseWriterTreeManifest = Pick<PhaseWriterInventory, 'scope' | 'sources' | 'gaps'> & {
  excluded: Array<{ path: string; reason: string }>;
  enumeration: { scanned: string[]; unscanned: string[] };
};
export type PhaseWriterDisposition =
  'advancing' | 'safe-retreat' | 'metadata-only' | 'isolated-fixture' | 'historical/unreachable';
export interface PhaseWriterReview {
  siteId: string;
  sourceSha256: string;
  statementSha256: string;
  /** Pin every inspected source used to justify the classification, including
   * indirect registration/policy/trigger dependencies. Rebuilding an inventory
   * never re-approves an old proof against changed dependency bytes. */
  sourceProofs: Array<{ path: string; sha256: string }>;
  disposition: PhaseWriterDisposition;
  reason: string;
  evidenceRefs: string[];
  /** Every interpolation/call frontier needs its own inspected source proof. */
  resolvedEdges: Array<{ edge: string; reason: string; evidenceRefs: string[] }>;
  revalidationSeam?: string;
  raceTest?: string;
}
export interface PhaseWriterCoverage {
  population: string[];
  checked: string[];
  notChecked: string[];
  notApplicable: string[];
  residue: string[];
}

function canonicalPath(path: string): boolean {
  return !!path && !path.includes('\0') && !path.includes('\\') && !path.startsWith('/')
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}

type ParameterSyntax = Pick<PhaseWriterArgumentFlow['parameters'][number], 'statement' | 'rest' | 'pattern' | 'initializer'>;
interface CallableSyntax { parameters: ParameterSyntax[]; thisParameter?: string }
function argumentFlow(signature: CallableSyntax, invocation: PhaseWriterInvocation,
  targetSha256: string): PhaseWriterArgumentFlow {
  let minimumPosition = 0, precedingSpread = false;
  const arguments_ = invocation.arguments.map((text, index) => {
    const spread = text.startsWith('...');
    const argument = { index, minimumPosition, unbounded: precedingSpread || spread, spread };
    if (spread) precedingSpread = true;
    else minimumPosition++;
    return argument;
  });
  return { basis: 'syntax-only-not-runtime-binding', targetSha256,
    ...(signature.thisParameter === undefined ? {} : { thisParameter: signature.thisParameter }),
    spreadArguments: arguments_.filter(argument => argument.spread).map(argument => argument.index),
    extraArguments: signature.parameters.some(parameter => parameter.rest) ? [] : arguments_
      .filter(argument => argument.unbounded || argument.minimumPosition >= signature.parameters.length)
      .map(argument => argument.index),
    parameters: signature.parameters.map((parameter, position) => ({ position, ...parameter,
      argumentIndexes: arguments_.filter(argument => parameter.rest
        ? argument.unbounded || argument.minimumPosition >= position
        : argument.minimumPosition === position || argument.unbounded && argument.minimumPosition < position)
        .map(argument => argument.index),
      mayBeMissing: !parameter.rest && minimumPosition <= position,
    })),
  };
}

/** Retain the whole fluent statement and every argument, rather than dropping
 * values/where/conflict tails at the initial mutation call. Table expressions,
 * spreads, computed columns and delegated values require explicit review.
 */
function mutationBuilder(node: ts.CallExpression, ast: ts.SourceFile) {
  const member = (expression: ts.Expression): string | undefined =>
    ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)
        ? expression.argumentExpression.text : undefined;
  const method = member(node.expression);
  if (!method || !mutationBuilderMethods.has(method)) return null;
  const edges = new Set<string>(), columns = new Set<string>();
  let chain = node, hasColumns = false, opaqueColumns = false;
  const readColumns = (value: ts.Expression): void => {
    if (ts.isArrayLiteralExpression(value)) {
      if (!value.elements.length) opaqueColumns = true;
      for (const element of value.elements) readColumns(element);
    } else if (ts.isObjectLiteralExpression(value)) {
      hasColumns = true;
      for (const property of value.properties) {
        if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) opaqueColumns = true;
        else if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
          || ts.isNumericLiteral(property.name)) columns.add(property.name.text);
        else opaqueColumns = true;
      }
    } else opaqueColumns = true;
  };
  const inspect = (call: ts.CallExpression) => {
    for (const argument of call.arguments) edges.add(argument.getText(ast));
    if (['set', 'values'].includes(member(call.expression) ?? '')) {
      if (!call.arguments.length) opaqueColumns = true;
      call.arguments.forEach(readColumns);
    }
  };
  inspect(chain);
  for (;;) {
    const access = chain.parent;
    if (!(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))
      || access.expression !== chain || !ts.isCallExpression(access.parent)
      || access.parent.expression !== access) break;
    chain = access.parent;
    inspect(chain);
  }
  if (!node.arguments.length) edges.add('<missing-mutation-target>');
  const unresolved = ['mutation-builder-target-requires-review'];
  if (opaqueColumns || !hasColumns && !['delete', 'deleteFrom'].includes(method)) {
    unresolved.push('mutation-builder-columns-require-review');
  }
  return { statement: chain.getText(ast), columns: [...columns].sort(compare),
    dynamicEdges: [...edges], unresolved, callees: [node.expression.getText(ast)] };
}

/** The grammar walks nested WITH mutations and function bodies too. */
function sqlFacts(sql: string) {
  const relations = new Set<string>(), columns = new Set<string>();
  const unresolved: string[] = [], functions: string[] = [], callees = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (['update', 'insert', 'delete', 'merge'].includes(String(node.type))) {
      const table = (node.table ?? node.into ?? node.from) as { name?: string; schema?: string } | undefined;
      if (!table?.name) unresolved.push('mutation-relation-unresolved');
      else {
        // Keep other relation writers as candidates too: their triggers may
        // reach a phase relation. Exclusion requires a source-bound review.
        relations.add([table.schema, table.name].filter(Boolean).join('.'));
        const fields = node.type === 'insert' ? node.columns : node.sets;
        if (Array.isArray(fields)) for (const field of fields) {
          const name = field?.column?.name ?? field?.name;
          if (typeof name === 'string') columns.add(name);
          else unresolved.push('mutation-column-unresolved');
        }
        else if (node.type !== 'delete') unresolved.push('mutation-columns-unresolved');
        const sets = (node.onConflict as { do?: { sets?: Array<{ column?: { name?: string } }> } } | undefined)?.do?.sets;
        for (const set of sets ?? []) {
          if (set.column?.name) columns.add(set.column.name);
          else unresolved.push('upsert-column-unresolved');
        }
      }
    }
    if (node.type === 'call') {
      const fn = node.function as { schema?: string; name?: string } | undefined;
      if (fn?.name) callees.add([fn.schema, fn.name].filter(Boolean).join('.'));
      unresolved.push('sql-function-call-requires-reachability-review');
    }
    if (node.type === 'create function' && typeof node.code === 'string') {
      // PL/pgSQL is not the SQL grammar. Keep its whole body for review and
      // reachable-trigger analysis instead of treating an opaque body as clean.
      // A body that only calls a helper can write just as surely as one with
      // literal UPDATE text. Even an empty body stays bound to its source.
      functions.push(node.code);
      unresolved.push('sql-function-body-requires-reachability-review');
    }
    for (const [key, child] of Object.entries(node)) {
      // pgsql-ast-parser represents FOR UPDATE as select.for={type:'update'}.
      // This is a row-lock mode, not an UPDATE statement with a missing table.
      // Keep inspecting the SELECT's CTEs/subqueries and its whole source text.
      if (node.type === 'select' && key === 'for') continue;
      visit(child);
    }
  };
  try { visit(parse(sql)); }
  catch { unresolved.push('sql-parse-unresolved'); }
  return { relations: [...relations].sort(compare), columns: [...columns].sort(compare),
    unresolved: [...new Set(unresolved)], functions, callees: [...callees].sort(compare) };
}

/** No file/statement/identity limit: callers supply complete sources or explicit
 * gaps. Review bindings pin both the complete file and complete statement.
 */
export function inventoryPhaseWriters(input: readonly PhaseWriterSource[],
  gaps: PhaseWriterInventory['gaps'] = []): PhaseWriterInventory {
  const sites: PhaseWriterSite[] = [], sources: PhaseWriterInventory['sources'] = [];
  const seenPaths = new Set<string>();
  const byPath = new Map(input.map(source => [source.path, source]));
  const sourceHashes = new Map(input.map(source => [source.path, digest(source.content)]));
  // A symbol can identify a variable, class or type. Only an actual function
  // body supplies the syntax whose outgoing calls this inventory has visited.
  // In particular `const send = connection.send` is not a closed callable.
  const callableDeclarations = new Set<string>();
  const callableSyntax = new Map<string, CallableSyntax>();
  const deferredEffectSiteIds = new Set<string>();
  const occurrences = new Map<string, number>();
  const calls: Array<{ path: string; operation: string; callee: string; spelling: string; statement: string;
    line: number; column: number; importedName?: string; importedCall: boolean; argumentNames: string[];
    argumentTexts: string[]; hasDirectSite: boolean; invocation: PhaseWriterInvocation }> = [];
  const aliases: Array<{ name: string; target: string }> = [];
  const add = (source: PhaseWriterSource, operation: string, statement: string, line: number,
    kind: PhaseWriterSite['kind'], facts: Partial<Pick<PhaseWriterSite,
      'relations' | 'columns' | 'dynamicEdges' | 'unresolved' | 'callees' | 'helperTarget'
      | 'helperDeclaration' | 'invocation' | 'argumentFlow' | 'syntaxWitness'>> = {}) => {
    const statementSha256 = digest(statement), sourceSha256 = sourceHashes.get(source.path)!;
    // Identical statements in the same operation are separate source occurrences.
    const base = JSON.stringify([source.path, operation, kind, statementSha256]);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    sites.push({ id: base + '#' + occurrence, path: source.path, operation, kind,
      statement, line, statementSha256, sourceSha256, relations: [], columns: [],
      dynamicEdges: [], unresolved: [], callees: [], ...facts });
  };
  const retainedGaps = [...gaps];
  for (const source of [...input].sort((a, b) => compare(a.path, b.path))) {
    if (!canonicalPath(source.path) || seenPaths.has(source.path)) {
      throw new Error(`phase_writer_source_identity_invalid:${source.path}`);
    }
    seenPaths.add(source.path);
    sources.push({ path: source.path, sha256: sourceHashes.get(source.path)! });
    if (/\.[cm]?[jt]sx?$/.test(source.path)) {
      let unit: ReturnType<typeof censusSites>;
      try { unit = censusSites(source.path, source.content); }
      catch {
        retainedGaps.push({ id: `source:${source.path}`, reason: 'typescript-parse-unresolved' });
        continue;
      }
      for (const statement of unit.ast.statements) {
        const declarations = ts.isVariableStatement(statement) ? statement.declarationList.declarations : [statement];
        for (const declaration of declarations) {
          const name = 'name' in declaration ? declaration.name : undefined;
          if (!name || !ts.isIdentifier(name)) continue;
          const callable = ts.isFunctionDeclaration(declaration) ? declaration
            : ts.isVariableDeclaration(declaration) && declaration.initializer
              && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
              ? declaration.initializer : undefined;
          if (callable?.body) {
            const { line, column } = unit.span(name);
            const id = JSON.stringify([source.path, line, column, name.text]);
            callableDeclarations.add(id);
            const parameters: ParameterSyntax[] = [];
            let thisParameter: string | undefined;
            for (const parameter of callable.parameters) {
              if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') {
                thisParameter = parameter.getText(unit.ast); continue;
              }
              parameters.push({ statement: parameter.getText(unit.ast), rest: !!parameter.dotDotDotToken,
                pattern: !ts.isIdentifier(parameter.name),
                ...(parameter.initializer ? { initializer: parameter.initializer.getText(unit.ast) } : {}) });
            }
            callableSyntax.set(id, { parameters, ...(thisParameter === undefined ? {} : { thisParameter }) });
          }
        }
      }
      const operation = (node: ts.Node): string => {
        const names: string[] = [];
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (!ts.isFunctionLike(parent)) continue;
          const name = parent.name ?? ((ts.isVariableDeclaration(parent.parent)
            || ts.isPropertyAssignment(parent.parent)) ? parent.parent.name : undefined);
          names.unshift(name?.getText(unit.ast) ?? '<callback>');
        }
        return names.join('::') || '<module>';
      };
      const inspectSql = (node: ts.Node, sql: string, edges: string[]) => {
        const facts = sqlFacts(sql);
        if (!edges.length && !facts.relations.length && !facts.functions.length && !facts.callees.length
          && !facts.unresolved.length && !mutationText.test(sql)) return;
        add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
          facts.functions.length ? 'sql-function' : 'sql', {
            relations: facts.relations, columns: facts.columns,
            dynamicEdges: edges, unresolved: facts.unresolved, callees: facts.callees,
          });
      };
      const literal = (node: ts.Node): { sql: string; edges: string[] } | null => {
        if (ts.isStringLiteralLike(node)) return { sql: node.text, edges: [] };
        if (!ts.isTemplateExpression(node)) return null;
        let sql = node.head.text;
        const edges: string[] = [];
        node.templateSpans.forEach((span, i) => {
          edges.push(span.expression.getText(unit.ast));
          sql += `$${i + 1}` + span.literal.text;
        });
        return { sql, edges };
      };
      const bindings = new Map(unit.sites.filter(site => site.kind === 'call')
        .map(site => [site.node, site.binding]));
      // Keep all import frontiers, including defaults, namespaces and shadowed
      // names. The shared symbol resolver may decline to assign their target.
      const importedLocals = new Set<string>();
      for (const node of unit.ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
        if (node.importClause?.name) importedLocals.add(node.importClause.name.text);
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) importedLocals.add(named.name.text);
        else if (named) for (const part of named.elements) if (!part.isTypeOnly) importedLocals.add(part.name.text);
      }
      const unwrapTarget = (node: ts.Expression): ts.Expression => {
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
          || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)
          || ts.isSatisfiesExpression(node)) return unwrapTarget(node.expression);
        return node;
      };
      const targetName = (node: ts.Expression | undefined): string | undefined => {
        if (!node) return;
        node = unwrapTarget(node);
        if (ts.isIdentifier(node)) return node.text;
        if (ts.isPropertyAccessExpression(node)) return node.name.text;
      };
      const bindingIncludes = (name: ts.BindingName, target: string): boolean =>
        ts.isIdentifier(name) ? name.text === target
          : name.elements.some(element => ts.isBindingElement(element) && bindingIncludes(element.name, target));
      const targetRoot = (node: ts.Expression): { root: ts.Expression; computed: boolean } => {
        node = unwrapTarget(node);
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const receiver = targetRoot(node.expression);
          return { root: receiver.root, computed: receiver.computed || ts.isElementAccessExpression(node) };
        }
        return { root: node, computed: false };
      };
      // A local alias does not close a parameter frontier: e.g. copying
      // client.array into original must retain original.call/apply as unknown.
      // Collect every possible origin before inspecting calls so declaration
      // order, reassignment and cycles cannot silently drop a candidate. This
      // conservative relation supplies no binding or reachability proof.
      const receiverOrigins = new Map<string, Set<string>>();
      const addReceiverOrigin = (name: ts.BindingName, origin: string): void => {
        if (ts.isIdentifier(name)) {
          const origins = receiverOrigins.get(name.text) ?? new Set<string>();
          origins.add(origin); receiverOrigins.set(name.text, origins);
        } else for (const element of name.elements) if (ts.isBindingElement(element)) {
          addReceiverOrigin(element.name, origin);
        }
      };
      const collectReceiverOrigins = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const { root } = targetRoot(node.initializer);
          if (ts.isIdentifier(root)) addReceiverOrigin(node.name, root.text);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)) {
          const { root } = targetRoot(node.right);
          if (ts.isIdentifier(root)) addReceiverOrigin(node.left, root.text);
        }
        ts.forEachChild(node, collectReceiverOrigins);
      };
      collectReceiverOrigins(unit.ast);
      const parameterOrigin = (root: string, parameters: ts.NodeArray<ts.ParameterDeclaration>): boolean => {
        const pending = new Set([root]), seen = new Set<string>();
        for (const name of pending) {
          if (seen.has(name)) continue;
          seen.add(name);
          if (parameters.some(parameter => bindingIncludes(parameter.name, name))) return true;
          for (const origin of receiverOrigins.get(name) ?? []) pending.add(origin);
        }
        return false;
      };
      // These syntax forms can invoke user code without a CallExpression:
      // getters/Proxy traps during binding or spread, iterator methods,
      // ToPrimitive/ToPropertyKey hooks, and thenable assimilation. Retain the
      // complete operation and operands. Recognized AST forms can supply a
      // witness for source-bound disposition.
      // Append after explicit sites so duplicate syntax cannot renumber any
      // existing reviewed occurrence or discard an earlier opaque frontier.
      const implicitEffects: Array<{ node: ts.Node; operands: ts.Node[]; syntaxWitness?: PhaseWriterSyntaxWitness }> = [];
      const isAsync = (node: ts.Node): boolean => ts.canHaveModifiers(node)
        && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      const captureImplicitEffect = (node: ts.Node): void => {
        let expression = node, operands: ts.Node[] | undefined;
        let syntaxWitness: PhaseWriterSyntaxWitness | undefined;
        if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
          expression = node.parent;
          const declaration = node.parent;
          operands = [((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
            && declaration.initializer) || node];
        } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)
          || ts.isAwaitExpression(node) || ts.isComputedPropertyName(node)) {
          operands = [node.expression];
        } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
          operands = [node.expression, node.initializer];
        } else if (ts.isYieldExpression(node) && node.expression) {
          // A delegated yield uses the iterator protocol; async generators
          // additionally assimilate yielded values. Keep both conservatively.
          operands = [node.expression];
        } else if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
          operands = node.templateSpans.map(span => span.expression);
          if (operands.length && operands.every(operand => primitiveLiteralKinds.has(operand.kind))) {
            syntaxWitness = primitiveLiteralTemplate;
          }
        } else if (ts.isBinaryExpression(node)) {
          const operator = node.operatorToken.kind;
          const destructuring = operator === ts.SyntaxKind.EqualsToken
            && (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left));
          if (destructuring || !nonCoerciveBinaryOperators.has(operator)) operands = [node.left, node.right];
          if (numericArithmeticOperators.has(operator) && ts.isNumericLiteral(node.left) && ts.isNumericLiteral(node.right)) {
            syntaxWitness = numericLiteralArithmetic;
          }
        } else if (ts.isPrefixUnaryExpression(node) && node.operator !== ts.SyntaxKind.ExclamationToken
          || ts.isPostfixUnaryExpression(node)) {
          operands = [node.operand];
          if (ts.isPrefixUnaryExpression(node) && numericUnaryOperators.has(node.operator)
            && ts.isNumericLiteral(node.operand)) syntaxWitness = numericLiteralUnary;
        } else if (ts.isReturnStatement(node) && node.expression) {
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (!ts.isFunctionLike(parent)) continue;
            if (isAsync(parent)) operands = [node.expression];
            break;
          }
        } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && isAsync(node)) {
          expression = node.body; operands = [node.body];
        }
        if (operands) implicitEffects.push({ node: expression, operands, syntaxWitness });
      };
      const visit = (node: ts.Node): void => {
        captureImplicitEffect(node);
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const target = targetName(node.initializer);
          if (target) aliases.push({ name: node.name.text, target });
        } else if (ts.isImportSpecifier(node) && !node.isTypeOnly) {
          aliases.push({ name: node.name.text, target: (node.propertyName ?? node.name).text });
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)) {
          const target = targetName(node.right);
          if (target) aliases.push({ name: node.left.text, target });
        }
        // Getters/setters and Proxy traps can run a writer without an explicit
        // CallExpression. Preserve each access, including accesses inside a
        // call's receiver/arguments; a callable declaration does not prove its
        // receiver evaluation safe. Assignment/delete/update retain the whole
        // modifying expression and RHS rather than just its property spelling.
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const edges = [node.expression.getText(unit.ast), ts.isPropertyAccessExpression(node)
            ? node.name.getText(unit.ast) : node.argumentExpression.getText(unit.ast)];
          let expression: ts.Node = node;
          for (;;) {
            const parent = expression.parent;
            if (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
              || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)
              || ts.isSatisfiesExpression(parent))) expression = parent;
            else break;
          }
          const parent = expression.parent;
          if (ts.isBinaryExpression(parent) && parent.left === expression
            && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            expression = parent; edges.push(parent.right.getText(unit.ast));
          } else if (ts.isDeleteExpression(parent)
            || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
              && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
            expression = parent;
          }
          add(source, operation(node), expression.getText(unit.ast), unit.span(expression).line,
            'unresolved', { dynamicEdges: edges, unresolved: ['property-dispatch-requires-review'] });
          deferredEffectSiteIds.add(sites[sites.length - 1]!.id);
        }
        if (ts.isTaggedTemplateExpression(node)) {
          const text = literal(node.template);
          const start = sites.length;
          if (text) inspectSql(node, text.sql, text.edges);
          const target = node.tag.getText(unit.ast);
          // A successful non-mutating SQL parse says nothing about the tag
          // function. It may implement a writer or invoke an opaque callback.
          // Existing SQL sites keep their reviewed statement/frontiers intact;
          // retain a new unresolved site when SQL inspection produced none.
          if (sites.length === start) add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
            'unresolved', { callees: [target], dynamicEdges: [target, ...(text?.edges ?? [])],
              unresolved: ['tagged-invocation-target-requires-review'] });
          const invocation: PhaseWriterInvocation = { form: 'tag', target, arguments: text?.edges ?? [],
            template: node.template.getText(unit.ast), line: unit.span(node.tag).line, column: unit.span(node.tag).column };
          for (let index = start; index < sites.length; index++) sites[index]!.invocation = invocation;
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = node.expression.getText(unit.ast);
          const target = unwrapTarget(node.expression);
          const { root, computed } = targetRoot(target);
          const args = node.arguments ?? [];
          const bindingSite = ts.isPropertyAccessExpression(target)
            && ts.isIdentifier(target.expression) ? target.name : target;
          const rootName = ts.isIdentifier(root) ? root.text : root.getText(unit.ast);
          const directSiteStart = sites.length;
          const invocation: PhaseWriterInvocation = { form: ts.isNewExpression(node) ? 'construct' : 'call',
            target: callee, arguments: args.map(argument => argument.getText(unit.ast)),
            line: unit.span(node.expression).line, column: unit.span(node.expression).column };
          const call = { path: source.path, operation: operation(node), callee, spelling: targetName(target) ?? callee,
            statement: node.getText(unit.ast), line: unit.span(bindingSite).line, column: unit.span(bindingSite).column,
            importedCall: importedLocals.has(rootName),
            argumentNames: args.map(targetName).filter((name): name is string => name !== undefined),
            argumentTexts: invocation.arguments, hasDirectSite: false, invocation,
            ...(bindings.get(node)?.imported ? { importedName: bindings.get(node)!.imported } : {}) };
          calls.push(call);
          let parameterCall = false;
          if (ts.isIdentifier(root)) {
            for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
              if (ts.isFunctionLike(parent) && parameterOrigin(root.text, parent.parameters)) parameterCall = true;
            }
          }
          // Syntax wrappers do not establish a target. Destructured callbacks,
          // methods on a parameter, returned receivers and other computed
          // callees retain the exact expression for source-bound review.
          const indirectTarget = !ts.isIdentifier(root)
            && root.kind !== ts.SyntaxKind.ThisKeyword && root.kind !== ts.SyntaxKind.SuperKeyword;
          if (parameterCall || computed || indirectTarget) {
            add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'unresolved', { dynamicEdges: [callee], unresolved: ['indirect-call-target-requires-review'] });
          }
          if (sqlMethod.test(callee)) {
            const text = args[0] && literal(args[0]);
            if (text) inspectSql(node, text.sql, text.edges);
            else add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'unresolved', { dynamicEdges: [args[0]?.getText(unit.ast) ?? '<missing-query>'],
                unresolved: ['dynamic-sql-target-unresolved'] });
          }
          if (ts.isCallExpression(node)) {
            const mutation = mutationBuilder(node, unit.ast);
            if (mutation) add(source, operation(node), mutation.statement, unit.span(node).line,
              'unresolved', mutation);
          }
          if (/\.(?:withAppendsHeld|appendBatch)$/.test(callee)
            || /\.append$/.test(callee) && /feature.claim|plan.item|work.item/i.test(source.content)) {
            add(source, operation(node), node.getText(unit.ast), unit.span(node).line,
              'authority-append', { dynamicEdges: args.map(arg => arg.getText(unit.ast)) });
          }
          call.hasDirectSite = sites.length !== directSiteStart;
          for (let index = directSiteStart; index < sites.length; index++) sites[index]!.invocation = invocation;
        } else if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
          // A dormant/indirect SQL literal is still in the population. Looking
          // only at .unsafe/query calls would miss a newly introduced wrapper.
          const parent = node.parent;
          const alreadyInspected = ts.isTaggedTemplateExpression(parent)
            || ts.isCallExpression(parent) && sqlMethod.test(parent.expression.getText(unit.ast))
              && parent.arguments[0] === node;
          if (!alreadyInspected) {
            const text = literal(node);
            if (text && (mutationText.test(text.sql) || sqlReadText.test(text.sql))) inspectSql(node, text.sql, text.edges);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(unit.ast);
      for (const effect of implicitEffects) {
        add(source, operation(effect.node), effect.node.getText(unit.ast), unit.span(effect.node).line,
          'unresolved', { dynamicEdges: [...new Set(effect.operands.map(operand => operand.getText(unit.ast)))],
            unresolved: [implicitDispatchReview], ...(effect.syntaxWitness ? { syntaxWitness: effect.syntaxWitness } : {}) });
        deferredEffectSiteIds.add(sites[sites.length - 1]!.id);
      }
    } else if (/\.sql$/.test(source.path)) {
      const facts = sqlFacts(source.content);
      if (facts.relations.length || facts.functions.length || facts.callees.length
        || facts.unresolved.length || mutationText.test(source.content)) {
        add(source, '<sql-module>', source.content, 1, facts.functions.length ? 'sql-function' : 'sql', facts);
      }
    } else {
      // An unsupported language/configuration can delegate a statement supplied
      // at runtime without containing a recognizable SQL word. Lack of a parser
      // is a review frontier, never evidence that the source cannot write.
      add(source, '<unparsed-source>', source.content, 1, 'unresolved', {
        unresolved: ['source-language-requires-review'],
      });
    }
  }
  // Fixed point over the full source population, not a prefix or a hop cap.
  // Name matching supplies candidates only; ambiguous/dynamic dispatch remains
  // an edge requiring review, not an assertion of a resolved callee.
  const originalSites = sites.filter(site => !deferredEffectSiteIds.has(site.id));
  const writers = new Set(originalSites.map(site => site.operation.split('::')[0]!));
  const writerPaths = new Set(originalSites.map(site => site.path));
  const targets = new Map<string, { path: string; declaration: SymbolDeclaration | null }>();
  const fileSet = new Set(input.map(source => source.path));
  const helperSymbols = buildSymbolSnapshot({ files: [...fileSet].sort(compare), censusOnly: true,
    readSource: path => byPath.get(path)?.content ?? null,
    resolveModule: (importer, specifier) => relativeSymbolModule(importer, specifier, fileSet),
    callCensusSink: (call, target, _index, declaration) => {
      if (target) targets.set(JSON.stringify([call.path, call.line, call.column]), { path: target, declaration });
    } });
  // A partially propagated barrel can appear singular before another export
  // reaches it. Keep the full candidates but decline every such target proof.
  if (helperSymbols.stats.callCensusTruncated) targets.clear();
  const added = new Set<string>();
  // Retain the existing source-reviewed frontiers verbatim first. They already
  // require explicit review of their full statements. A second fixed point
  // adds previously unseeded calls with their unresolved declaration/arguments;
  // it cannot re-label an old review or exempt any existing candidate.
  for (const includeOpaque of [false, true]) {
    // A new implicit-effect candidate must not turn a previously opaque call
    // into a bare path/name edge and discard its argument/declaration residue.
    // Preserve the original frontiers first, then expand from property sites.
    if (includeOpaque) for (const site of sites) if (deferredEffectSiteIds.has(site.id)) {
      writers.add(site.operation.split('::')[0]!); writerPaths.add(site.path);
    }
    let changed = true;
    while (changed) {
      changed = false;
      // Aliases supply candidates, never binding proof. Retain every assignment
      // and ambiguous name rather than choosing a convenient lexical scope.
      for (const alias of aliases) if (writers.has(alias.target) && !writers.has(alias.name)) {
        writers.add(alias.name); changed = true;
      }
      for (const call of calls) {
        const name = call.importedName ?? call.spelling;
        const key = JSON.stringify([call.path, call.operation, call.statement, call.line, call.column]);
        const target = targets.get(JSON.stringify([call.path, call.line, call.column]));
        // An opaque local/global call can write without any imported name,
        // known SQL spelling or previously seeded writer. Preserve that call and
        // every positional/spread argument; target identity alone cannot prove
        // which effects a callback or an argument will have. Existing explicit
        // SQL/indirect/append sites already retain their own frontiers.
        const opaqueCall = !call.importedCall && !call.hasDirectSite
          && (!target?.declaration || !callableDeclarations.has(target.declaration.id));
        if ((!writers.has(name) && !call.argumentNames.some(argument => writers.has(argument))
          && !(target && writerPaths.has(target.path)) && !call.importedCall && !(includeOpaque && opaqueCall))
          || added.has(key)) continue;
        added.add(key);
        const source = byPath.get(call.path)!;
        const helperTarget: PhaseWriterSite['helperTarget'] = target ? {
          path: target.path, sha256: sourceHashes.get(target.path)!, basis: 'syntax-bound-module-target-not-runtime-closure',
        } : undefined;
        const signature = target?.declaration && callableSyntax.get(target.declaration.id);
        add(source, call.operation, call.statement, call.line, 'helper-edge', {
          invocation: call.invocation,
          callees: [call.callee], dynamicEdges: [call.callee,
            ...(opaqueCall ? call.argumentTexts : []),
            ...(helperTarget ? [`source:${helperTarget.path}#${helperTarget.sha256}`] : [])],
          ...(helperTarget ? { helperTarget } : {}),
          ...(target?.declaration ? { helperDeclaration: target.declaration } : {}),
          ...(signature && helperTarget ? { argumentFlow: argumentFlow(signature, call.invocation, helperTarget.sha256) } : {}),
          unresolved: [...(!helperTarget && call.importedCall ? ['imported-call-target-requires-review'] : []),
            ...(opaqueCall ? ['call-target-declaration-unresolved'] : []),
            ...(helperSymbols.stats.callCensusTruncated ? ['helper-symbol-export-resolution-incomplete'] : [])],
        });
        if (!writerPaths.has(source.path)) { writerPaths.add(source.path); changed = true; }
        const wrapper = call.operation.split('::')[0]!;
        if (!writers.has(wrapper)) { writers.add(wrapper); changed = true; }
      }
    }
  }
  return { schemaVersion: 1, scope: { kind: 'supplied-sources' }, sources, sites: sites.sort((a, b) => compare(a.id, b.id)),
    gaps: retainedGaps.sort((a, b) => compare(a.id, b.id)) };
}

function isWranglerLocalSqliteState(path: string, bytes: Buffer): boolean {
  if (!path.startsWith(wranglerLocalStateRoot)) return false;
  const match = miniflareSqlitePath.exec(path.slice(wranglerLocalStateRoot.length));
  if (!match) return false;
  const sidecar = match[1];
  if (!sidecar) return bytes.subarray(0, sqliteHeader.length).equals(sqliteHeader);
  if (bytes.length < 4) return false;
  const header = bytes.readUInt32BE(0);
  if (sidecar === 'wal') return header === 0x377f0682 || header === 0x377f0683;
  // The WAL index stores its format version in native byte order.
  return header === 3_007_000 || bytes.readUInt32LE(0) === 3_007_000;
}

function inspectLooseGitObject(path: string, bytes: Buffer):
  { exclusion: PhaseWriterTreeManifest['excluded'][number] }
  | { gap: PhaseWriterInventory['gaps'][number] }
  | undefined {
  const match = looseGitObjectPath.exec(path);
  if (!match) return;

  let reason = 'loose-git-object-unresolved';
  try {
    const { buffer: object, engine } = inflateSync(bytes, {
      info: true, maxOutputLength: binaryArtifactInflateLimit,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (engine.bytesWritten !== bytes.length) return;
    const separator = object.indexOf(0);
    if (separator < 0) return;
    const header = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(object.toString('latin1', 0, separator));
    if (!header || Number(header[2]) !== object.length - separator - 1) return;
    const objectId = match[1]! + match[2]!;
    if (createHash('sha1').update(object).digest('hex') !== objectId) return;
    const [, kind, size] = header;
    if (size === '0' && (kind === 'blob' || kind === 'tree')) {
      // Empty blobs and trees contain no source bytes or entries. Include the
      // compressed digest so freshness still detects changes to the artifact.
      return { exclusion: { path, reason: `verified-empty-loose-git-${kind}:${digest(bytes)}` } };
    }
    if (kind === 'commit' && path === `${drillGitObjectRoot}${match[1]}/${match[2]}`) {
      const fingerprint = drillGitCommitFingerprints.get(objectId);
      if (fingerprint && digest(bytes) === fingerprint) {
        return { exclusion: { path, reason: `verified-loose-git-drill-commit:${fingerprint}` } };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_BUFFER_TOO_LARGE') return;
    reason = 'loose-git-object-inflate-limit';
  }

  return { gap: { id: `source:${path}`, reason, sha256: digest(bytes) } };
}

function hasCompletePngScanlines(parts: Buffer[], scanlineBytes: number, expectedBytes: number): boolean {
  if (!parts.length) return false;
  const compressed = Buffer.concat(parts);
  try {
    const { buffer, engine } = inflateSync(compressed, {
      info: true, maxOutputLength: expectedBytes,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (engine.bytesWritten !== compressed.length || buffer.length !== expectedBytes) return false;
    for (let offset = 0; offset < buffer.length; offset += scanlineBytes) {
      if (buffer[offset]! > 4) return false;
    }
    return true;
  } catch { return false; }
}

function readPinnedNpmArchive(path: string, bytes: Buffer, layout: NpmArchiveLayout): PhaseWriterSource[] | undefined {
  try {
    const decoded = gunzipSync(bytes, { maxOutputLength: layout.decodedBytes });
    if (decoded.length !== layout.decodedBytes) return;
    const sources: PhaseWriterSource[] = [];
    for (const [name, offset, size] of layout.members) {
      const payload = decoded.subarray(offset, offset + size);
      const content = payload.toString('utf8');
      if (payload.length !== size || !Buffer.from(content).equals(payload)) return;
      sources.push({ path: `${path}/${name}`, content });
    }
    return sources;
  } catch {
    return undefined;
  }
}

/** Recognize the producer's noninterlaced RGB/RGBA PNGs with optional sRGB.
 * Unknown records, malformed streams and bytes after IEND remain auditable gaps.
 */
function inspectLostPixelPng(bytes: Buffer): 'complete' | 'invalid' | 'inflate-limit' {
  const header = readPngDimensionsSafe(bytes);
  if (!header.ok || bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes[24] !== 8
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) return 'invalid';
  const colorType = bytes[25];
  if (colorType !== 2 && colorType !== 6) return 'invalid';
  const scanlineBytes = 1 + header.dimensions.width * (colorType === 2 ? 3 : 4);
  const expectedBytes = scanlineBytes * header.dimensions.height;
  if (expectedBytes > binaryArtifactInflateLimit) return 'inflate-limit';

  const parts: Buffer[] = [];
  let sawColorProfile = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const dataStart = offset + 8, dataEnd = dataStart + size, next = dataEnd + 4;
    if (next > bytes.length || crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      return 'invalid';
    }
    const type = bytes.toString('latin1', offset + 4, dataStart);
    // The header fields were checked above. This iteration verifies its CRC.
    if (offset === 8) {
      offset = next;
      continue;
    }
    if (type === 'sRGB' && !sawColorProfile && !parts.length && size === 1 && bytes[dataStart]! <= 3) {
      sawColorProfile = true;
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND' && size === 0 && next === bytes.length) {
      return hasCompletePngScanlines(parts, scanlineBytes, expectedBytes) ? 'complete' : 'invalid';
    } else return 'invalid';
    offset = next;
  }
  return 'invalid';
}

type LostPixelOutput = {
  path: string;
  directory: keyof typeof lostPixelOutputFields;
  configPath: string;
  sha256: string;
};

function lostPixelOutputCandidate(path: string, bytes: Buffer):
  { output: LostPixelOutput } | { gap: PhaseWriterInventory['gaps'][number] } | null {
  if (!path.endsWith('.png')) return null;
  const match = lostPixelPngPath.exec(path);
  if (!match || !lostPixelProjects.has(match[1]!)) return null;
  const png = inspectLostPixelPng(bytes);
  if (png === 'invalid') return null;
  const sha256 = digest(bytes);
  if (png === 'inflate-limit') return { gap: { id: `source:${path}`, reason: 'lost-pixel-raster-inflate-limit', sha256 } };
  const directory = match[2] as keyof typeof lostPixelOutputFields;
  return { output: { path, directory, configPath: `${match[1]}/lostpixel.config.ts`, sha256 } };
}

function lostPixelConfiguredOutputs(source: PhaseWriterSource): Set<string> {
  const file = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest);
  const statements = file.statements.filter(statement =>
    !(ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly));
  const [statement] = statements;
  if (statements.length !== 1 || !statement || !ts.isVariableStatement(statement)
    || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || !(statement.declarationList.flags & ts.NodeFlags.Const)) return new Set();
  const declarations = statement.declarationList.declarations;
  const [config] = declarations;
  if (declarations.length !== 1 || !config || !ts.isIdentifier(config.name) || config.name.text !== 'config'
    || !config.initializer || !ts.isObjectLiteralExpression(config.initializer)) return new Set();
  const properties = new Map<string, ts.Expression>();
  for (const property of config.initializer.properties) {
    if (!ts.isPropertyAssignment(property)
      || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      || properties.has(property.name.text)) return new Set();
    properties.set(property.name.text, property.initializer);
  }
  const storybookShots = properties.get('storybookShots');
  if (!storybookShots || !ts.isObjectLiteralExpression(storybookShots)) return new Set();
  const outputs = new Set<string>();
  for (const [directory, field] of Object.entries(lostPixelOutputFields)) {
    const path = properties.get(field);
    if (path && ts.isStringLiteral(path) && path.text === `./${directory}`) outputs.add(directory);
  }
  return outputs;
}

/** Complete maintained tree enumeration, including checked-out submodules and
 * new source files. Missing submodules, unreadable files and symlinks are gaps.
 * Named exclusions retain every path; no page/file cap selects the truth.
 */
function readPhaseWriterTree(root: string) {
  const enumeration = listFilesIncludingUntracked(root);
  const scannedSubmodules = new Set(enumeration.scanned);
  const input: PhaseWriterSource[] = [];
  const gaps: PhaseWriterInventory['gaps'] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  const lostPixelPngs: LostPixelOutput[] = [];
  const reviewedBinaryPaths: string[] = [];
  const files: string[] = [];
  for (const path of enumeration.files) {
    if (typeof path !== 'string' || !canonicalPath(path)) {
      throw new Error(`phase_writer_enumeration_identity_invalid:${String(path)}`);
    }
    files.push(path);
  }
  const generated = new Set(['node_modules', 'dist', 'out', 'target', 'coverage', '.next', '.turbo']);
  for (const path of [...new Set(files)].sort(compare)) {
    if (!PHASE_WRITER_ROOTS.some(prefix => path.startsWith(prefix))) {
      excluded.push({ path, reason: 'outside-declared-runtime-roots' }); continue;
    }
    if (path.split('/').some(part => generated.has(part))) {
      excluded.push({ path, reason: 'generated-or-vendor-output' }); continue;
    }
    // Keep each output identity and its producer. Authored inputs, producer
    // scripts and similarly named sibling paths remain in the source census.
    const output = generatedOutputPrefixes.find(([prefix]) => path.startsWith(prefix));
    if (output) {
      excluded.push({ path, reason: output[1] }); continue;
    }
    // File extensions do not establish whether a runtime-root file can execute
    // or configure a writer. Keep unfamiliar and extensionless text for review;
    // unreadable/binary inputs remain explicit gaps below.
    try {
      const fullPath = join(root, path), stat = lstatSync(fullPath);
      // --cached emits the gitlink itself as well as the separately scanned
      // child files. Only that exact, proven directory entry is structural;
      // descendants and symlinks still pass through the ordinary source guard.
      if (stat.isDirectory() && scannedSubmodules.has(path)) {
        excluded.push({ path, reason: 'enumerated-submodule-directory:libs/test-config/src/tracked-files.mjs' });
        continue;
      }
      if (!stat.isFile()) { gaps.push({ id: `source:${path}`, reason: 'non-regular-source' }); continue; }
      const bytes = readFileSync(fullPath);
      const archive = reviewedNpmArchives.get(path);
      if (archive) {
        const sha256 = digest(bytes);
        if (sha256 !== archive.sha256) {
          gaps.push({ id: `source:${path}`, reason: 'npm-archive-bytes-changed', sha256 });
          continue;
        }
        const members = readPinnedNpmArchive(path, bytes, archive);
        if (!members) {
          gaps.push({ id: `source:${path}`, reason: 'npm-archive-layout-unreadable', sha256 });
          continue;
        }
        input.push(...members);
        excluded.push({ path, reason: `reviewed-npm-archive-member-layout:asset-sha256:${sha256}` });
        continue;
      }
      if (isWranglerLocalSqliteState(path, bytes)) {
        excluded.push({ path, reason: wranglerLocalStateReason }); continue;
      }
      // A compressed Git object can round-trip as UTF-8. Identify it before
      // decoding text, and carry any payload we cannot classify as a gap.
      const gitObject = inspectLooseGitObject(path, bytes);
      if (gitObject) {
        if ('exclusion' in gitObject) excluded.push(gitObject.exclusion);
        else gaps.push(gitObject.gap);
        continue;
      }
      const reviewed = reviewedBinaryArtifacts.get(path);
      const reviewedDigest = reviewed ? digest(bytes) : undefined;
      if (reviewed && reviewedDigest === reviewed.sha256) {
        reviewedBinaryPaths.push(path);
        continue;
      }
      const content = bytes.toString('utf8');
      if (!Buffer.from(content).equals(bytes)) {
        const candidate = lostPixelOutputCandidate(path, bytes);
        if (candidate && 'output' in candidate) lostPixelPngs.push(candidate.output);
        else if (candidate) gaps.push(candidate.gap);
        else gaps.push({ id: `source:${path}`, reason: 'source-not-utf8', sha256: reviewedDigest ?? digest(bytes) });
        continue;
      }
      if (reviewedDigest) {
        const prefix = `reviewed-${reviewed?.format ?? 'raster'}`;
        gaps.push({ id: `${prefix}:${path}`, reason: `${prefix}-bytes-changed`, sha256: reviewedDigest });
      }
      input.push({ path, content });
    } catch { gaps.push({ id: `source:${path}`, reason: 'source-read-failed' }); }
  }
  if (reviewedBinaryPaths.length > 0) {
    const rolePaths = new Set(reviewedBinaryPaths.flatMap(path => {
      const { role, additionalRoleSources = [] } = reviewedBinaryArtifacts.get(path)!;
      return [role.path, ...additionalRoleSources.map(source => source.path)];
    }));
    const roleHashes = new Map(input.filter(source => rolePaths.has(source.path))
      .map(source => [source.path, digest(source.content)]));
    for (const path of reviewedBinaryPaths) {
      const { sha256, role, additionalRoleSources = [], format = 'raster' } = reviewedBinaryArtifacts.get(path)!;
      const prefix = `reviewed-${format}`;
      const sources = [role, ...additionalRoleSources];
      if (sources.every(source => roleHashes.get(source.path) === source.sha256)) {
        const proof = sources.map(source => `${source.path}#${source.sha256}`).join(':');
        excluded.push({ path, reason: `${prefix}:${role.kind}:${proof}:asset-sha256:${sha256}` });
      } else {
        gaps.push({ id: `source:${path}`, reason: `${prefix}-role-unverified`, sha256 });
      }
    }
  }
  // Use the producer source in this same snapshot. A directory name alone
  // cannot establish that its contents came from Lost Pixel.
  if (lostPixelPngs.length > 0) {
    const configPaths = new Set(lostPixelPngs.map(output => output.configPath));
    const configured = new Map(input.filter(source => configPaths.has(source.path))
      .map(source => [source.path, lostPixelConfiguredOutputs(source)]));
    for (const { path, directory, configPath, sha256 } of lostPixelPngs) {
      if (configured.get(configPath)?.has(directory)) {
        excluded.push({ path, reason: `generated-lost-pixel-output:${configPath}#${lostPixelOutputFields[directory]}:asset-sha256:${sha256}` });
      } else {
        gaps.push({ id: `source:${path}`, reason: 'source-not-utf8', sha256 });
      }
    }
  }
  for (const path of enumeration.unscanned) {
    if (PHASE_WRITER_ROOTS.some(prefix => path.startsWith(prefix))) {
      gaps.push({ id: `submodule:${path}`, reason: 'declared-submodule-not-enumerated' });
    }
  }
  return { input, gaps, scope: { kind: 'repository' as const, root: resolve(root) },
    excluded: excluded.sort((a, b) => compare(a.path, b.path)),
    enumeration: { scanned: enumeration.scanned, unscanned: enumeration.unscanned } };
}

export function inventoryPhaseWriterTree(root: string) {
  const { input, gaps, ...manifest } = readPhaseWriterTree(root);
  return { ...inventoryPhaseWriters(input, gaps), ...manifest };
}

/** Re-enumerate and hash the complete tree, without repeating the SQL/call
 * graph analysis. Recheck prior parser gaps before reporting them as removed.
 * A verified export is an old source snapshot until this comparison
 * succeeds. Added/deleted sources and changed exclusions are just as material
 * as changed reviewed statements. Gaps never become evidence of no change.
 * This measures filesystem bytes at observedAt, not executed-module identity.
 */
export function verifyPhaseWriterTreeSnapshot(expected: PhaseWriterTreeManifest) {
  if (expected.scope.kind !== 'repository') throw new Error('phase_writer_repository-snapshot-required');
  const { input, gaps, ...manifest } = readPhaseWriterTree(expected.scope.root);
  // The filesystem reader observes read/enumeration failures, not syntax.
  // Absence from its gaps cannot establish that an earlier analysis succeeded.
  // Reuse the inventory's maintained parser for each previously failed source;
  // a missing/unreadable source is already represented by the tree comparison.
  const currentSources = new Map(input.map(source => [`source:${source.path}`, source]));
  for (const gap of expected.gaps) {
    if (gap.reason !== 'typescript-parse-unresolved') continue;
    const source = currentSources.get(gap.id);
    if (!source) continue;
    try { censusSites(source.path, source.content); }
    catch { gaps.push({ ...gap }); }
  }
  const actual: PhaseWriterTreeManifest = { ...manifest, gaps,
    sources: input.map(source => ({ path: source.path, sha256: digest(source.content) })) };
  const index = (value: PhaseWriterTreeManifest) => {
    const rows = new Map<string, string>();
    const add = (id: string, content: string) => {
      if (rows.has(id)) throw new Error(`phase_writer_duplicate-snapshot-identity:${id}`);
      rows.set(id, content);
    };
    for (const source of value.sources) {
      if (!canonicalPath(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256)) {
        throw new Error(`phase_writer_invalid-snapshot-source:${source.path}`);
      }
      add(`source:${source.path}`, source.sha256);
    }
    for (const gap of value.gaps) {
      add(`gap:${gap.id}`, gap.sha256 ? JSON.stringify([gap.reason, gap.sha256]) : gap.reason);
    }
    for (const exclusion of value.excluded) add(`excluded:${exclusion.path}`, exclusion.reason);
    for (const path of value.enumeration.scanned) add(`scanned:${path}`, path);
    for (const path of value.enumeration.unscanned) add(`unscanned:${path}`, path);
    return rows;
  };
  const before = index(expected), after = index(actual);
  const coverage: PhaseWriterCoverage = { population: [...new Set([...before.keys(), ...after.keys()])].sort(compare),
    checked: [], notChecked: [], notApplicable: [], residue: [] };
  const differences: Array<{ id: string; reason: 'added' | 'removed' | 'changed';
    expected: string | null; actual: string | null }> = [];
  for (const id of coverage.population) {
    const old = before.get(id), current = after.get(id);
    const changed = old !== current;
    if (changed) differences.push({ id, reason: old === undefined ? 'added' : current === undefined ? 'removed' : 'changed',
      expected: old ?? null, actual: current ?? null });
    if (changed || id.startsWith('gap:') || id.startsWith('unscanned:')) {
      coverage.notChecked.push(id); coverage.residue.push(id);
    } else if (id.startsWith('excluded:')) coverage.notApplicable.push(id);
    else coverage.checked.push(id);
  }
  return { schemaVersion: 1 as const, scope: actual.scope, observedAt: new Date().toISOString(),
    ready: coverage.residue.length === 0, coverage, differences };
}

const dispositions = new Set<PhaseWriterDisposition>([
  'advancing', 'safe-retreat', 'metadata-only', 'isolated-fixture', 'historical/unreachable',
]);

function scanPrimitiveTemplateOperands(scanner: ts.Scanner): Set<string> | undefined {
  let templateToken = scanner.scan();
  if (templateToken !== ts.SyntaxKind.TemplateHead) return;
  const operands = new Set<string>();
  do {
    if (!primitiveLiteralKinds.has(scanner.scan()) || scanner.isUnterminated()) return;
    operands.add(scanner.getTokenText());
    if (scanner.scan() !== ts.SyntaxKind.CloseBraceToken) return;
    templateToken = scanner.reScanTemplateToken(false);
    if (scanner.isUnterminated()) return;
  } while (templateToken === ts.SyntaxKind.TemplateMiddle);
  if (templateToken === ts.SyntaxKind.TemplateTail) return operands;
}

function scanNumericLiteralOperands(scanner: ts.Scanner, unary: boolean): Set<string> | undefined {
  const operands = new Set<string>();
  if (!unary) {
    if (scanner.scan() !== ts.SyntaxKind.NumericLiteral) return;
    operands.add(scanner.getTokenText());
  }
  const operators = unary ? numericUnaryOperators : numericArithmeticOperators;
  if (!operators.has(scanner.scan()) || scanner.scan() !== ts.SyntaxKind.NumericLiteral) return;
  operands.add(scanner.getTokenText());
  return operands;
}

const syntaxProofs = {
  [numericLiteralUnary]: {
    reason: 'This unary expression directly consumes a numeric literal. Evaluating it and coercing its primitive Number cannot dispatch user code.',
    semantics: 'sec-unary-operators',
  },
  [numericLiteralArithmetic]: {
    reason: 'Both operands are Number literals. This arithmetic operation evaluates and combines primitive numbers without dispatching user code.',
    semantics: 'sec-applystringornumericbinaryoperator',
  },
  [primitiveLiteralTemplate]: {
    reason: 'Every substitution in this untagged template is a direct primitive literal. Evaluating and converting these values to strings cannot dispatch user code.',
    semantics: 'sec-template-literals-runtime-semantics-evaluation',
  },
} satisfies Record<PhaseWriterSyntaxWitness, { reason: string; semantics: string }>;

function reviewSyntaxWitness(site: PhaseWriterSite): PhaseWriterReview | undefined {
  const witness = site.syntaxWitness;
  if (!witness || !Object.hasOwn(syntaxProofs, witness) || site.kind !== 'unresolved' || site.invocation
    || site.callees.length || site.relations.length || site.columns.length
    || site.unresolved.length !== 1 || site.unresolved[0] !== implicitDispatchReview
    || digest(site.statement) !== site.statementSha256) return;
  // Recheck the complete token sequence and the collector's exact operand edges.
  let lexicalError = false;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, site.statement,
    () => { lexicalError = true; });
  const operands = witness === primitiveLiteralTemplate ? scanPrimitiveTemplateOperands(scanner)
    : scanNumericLiteralOperands(scanner, witness === numericLiteralUnary);
  if (!operands || scanner.scan() !== ts.SyntaxKind.EndOfFileToken || lexicalError
    || operands.size !== site.dynamicEdges.length
    || [...operands].some((operand, index) => site.dynamicEdges[index] !== operand)) return;

  const { reason, semantics } = syntaxProofs[witness];
  const evidenceRefs = [`source:${site.path}#${site.sourceSha256}`, `https://tc39.es/ecma262/#${semantics}`];
  return { siteId: site.id, sourceSha256: site.sourceSha256, statementSha256: site.statementSha256,
    sourceProofs: [{ path: site.path, sha256: site.sourceSha256 }], disposition: 'metadata-only', reason, evidenceRefs,
    resolvedEdges: [...site.dynamicEdges, implicitDispatchReview].map(edge => ({ edge, reason, evidenceRefs })) };
}

/** Reviews are exact source proofs. Neither an exemption nor an advancing seam
 * is accepted after its source/statement changes, even if it never executes.
 */
export function reconcilePhaseWriterCensus(inventory: PhaseWriterInventory,
  reviews: readonly PhaseWriterReview[]) {
  const coverage: PhaseWriterCoverage = { population: [], checked: [], notChecked: [], notApplicable: [], residue: [] };
  const problems: Array<{ id: string; reasons: string[] }> = [];
  const syntaxReviews: PhaseWriterReview[] = [];
  const sourceHashes = new Map(inventory.sources.map(source => [source.path, source.sha256]));
  const byId = new Map<string, PhaseWriterReview[]>();
  for (const review of reviews) byId.set(review.siteId, [...(byId.get(review.siteId) ?? []), review]);
  for (const site of inventory.sites) {
    coverage.population.push(site.id);
    const candidates = byId.get(site.id) ?? [];
    const syntaxReview = candidates.length === 0 ? reviewSyntaxWitness(site) : undefined;
    const review = candidates.length === 1 ? candidates[0] : syntaxReview;
    const reasons: string[] = [];
    if (!review) reasons.push(candidates.length ? 'duplicate-review' : 'unclassified-writer');
    else {
      if (review.sourceSha256 !== site.sourceSha256 || review.statementSha256 !== site.statementSha256) reasons.push('stale-review');
      if (!Array.isArray(review.sourceProofs) || !review.sourceProofs.length) {
        reasons.push('review-source-proofs-missing');
      } else {
        const seen = new Set<string>();
        for (const proof of review.sourceProofs) {
          if (!canonicalPath(proof.path) || !/^[a-f0-9]{64}$/.test(proof.sha256)) {
            reasons.push(`invalid-source-proof:${proof.path}`); continue;
          }
          if (seen.has(proof.path)) reasons.push(`duplicate-source-proof:${proof.path}`);
          seen.add(proof.path);
          const current = sourceHashes.get(proof.path);
          if (current === undefined) reasons.push(`missing-source-proof:${proof.path}`);
          else if (current !== proof.sha256) reasons.push(`stale-source-proof:${proof.path}`);
        }
        if (!seen.has(site.path)) reasons.push(`writer-source-proof-missing:${site.path}`);
      }
      if (!dispositions.has(review.disposition) || !review.reason.trim()
        || !review.evidenceRefs.length || review.evidenceRefs.some(ref => !ref.trim())) reasons.push('review-proof-missing');
      if (review.disposition === 'advancing' && (!review.revalidationSeam?.trim() || !review.raceTest?.trim())) reasons.push('advancing-seam-or-race-test-missing');
      const edges = [...site.dynamicEdges, ...site.unresolved, ...site.callees];
      for (const edge of new Set(edges)) {
        const resolved = review.resolvedEdges.filter(row => row.edge === edge);
        if (resolved.length !== 1 || !resolved[0]!.reason.trim() || !resolved[0]!.evidenceRefs.length
          || resolved[0]!.evidenceRefs.some(ref => !ref.trim())) reasons.push(`unresolved-edge:${edge}`);
      }
      for (const resolved of review.resolvedEdges) if (!edges.includes(resolved.edge)) reasons.push(`stale-edge-review:${resolved.edge}`);
    }
    if (reasons.length) {
      coverage.notChecked.push(site.id); coverage.residue.push(site.id); problems.push({ id: site.id, reasons });
    } else if (review!.disposition === 'isolated-fixture' || review!.disposition === 'historical/unreachable') {
      coverage.notApplicable.push(site.id);
    } else {
      coverage.checked.push(site.id);
      if (syntaxReview) syntaxReviews.push(syntaxReview);
    }
    byId.delete(site.id);
  }
  for (const gap of inventory.gaps) {
    const id = `gap:${gap.id}`;
    coverage.population.push(id); coverage.notChecked.push(id); coverage.residue.push(id);
    problems.push({ id, reasons: [gap.reason] });
  }
  // An exemption for a deleted writer is stale too. Preserve the full identity.
  for (const [siteId] of byId) {
    const id = `orphan-review:${siteId}`;
    coverage.population.push(id); coverage.notChecked.push(id); coverage.residue.push(id);
    problems.push({ id, reasons: ['reviewed-writer-missing'] });
  }
  return { schemaVersion: 1 as const, scope: inventory.scope, ready: problems.length === 0, coverage, problems, syntaxReviews };
}

export function assertPhaseWriterCensus(inventory: PhaseWriterInventory, reviews: readonly PhaseWriterReview[]) {
  const report = reconcilePhaseWriterCensus(inventory, reviews);
  // Keep the complete report recoverable without serializing the population
  // into one enormous error string. The first reason is a labelled preview.
  if (!report.ready) throw Object.assign(new Error(`phase_writer_census_incomplete:${report.problems[0]?.reasons[0]}; first-reason-preview; complete report on error.report`), { report });
  return report;
}

/** Native entry point: discover from the actual complete tree, then re-observe
 * its bytes/enumeration before accepting classifications. A caller's old export
 * or supplied-source subset is never substituted for this population. Both
 * source freshness and site coverage retain their full refusal/recovery data.
 * This measures source at observedAt; it grants no lifecycle authority.
 */
export function assertPhaseWriterTreeCensus(root: string, reviews: readonly PhaseWriterReview[]) {
  const inventory = inventoryPhaseWriterTree(root);
  const census = reconcilePhaseWriterCensus(inventory, reviews);
  const freshness = verifyPhaseWriterTreeSnapshot(inventory);
  const report = { schemaVersion: 1 as const, observedAt: freshness.observedAt,
    ready: census.ready && freshness.ready, inventory, census, freshness };
  if (!report.ready) {
    const preview = census.problems[0]?.reasons[0] ?? 'source-snapshot-not-current';
    throw Object.assign(new Error(`phase_writer_tree_census_incomplete:${preview}; first-reason-preview; complete report on error.report`), { report });
  }
  return report;
}

const streamKinds = ['header', 'source', 'site', 'gap', 'excluded', 'scanned', 'unscanned', 'review', 'coverage'] as const;
type StreamKind = typeof streamKinds[number];
type StreamCounts = Record<StreamKind, number>;
type StreamInventory = PhaseWriterInventory & {
  excluded?: Array<{ path: string; reason: string }>;
  enumeration?: { scanned: string[]; unscanned: string[] };
};
interface CensusRecord { seq: number; kind: StreamKind; value: unknown }
interface CensusFooter {
  seq: number; kind: 'complete'; sha256: string; counts: StreamCounts; ready: boolean;
}
const streamCounts = (): StreamCounts => Object.fromEntries(streamKinds.map(kind => [kind, 0])) as StreamCounts;

/** Await each complete record, including sink backpressure. No aggregate JSON
 * string or record limit: large censuses retain the complete population and
 * coverage. A failed sink leaves an incomplete artifact; regenerate from source.
 */
export async function writePhaseWriterCensus(inventory: StreamInventory,
  reviews: readonly PhaseWriterReview[], write: (line: string) => void | Promise<void>) {
  const report = reconcilePhaseWriterCensus(inventory, reviews);
  const hash = createHash('sha256'), counts = streamCounts();
  let seq = 0;
  const emit = async (kind: StreamKind, value: unknown) => {
    const line = JSON.stringify({ seq, kind, value }) + '\n';
    await write(line);
    hash.update(line); counts[kind]++; seq++;
  };
  await emit('header', { schemaVersion: 'phase-writer-census-stream-v1', scope: inventory.scope,
    basis: 'source-inventory-not-acceptance-proof' });
  for (const value of inventory.sources) await emit('source', value);
  for (const value of inventory.sites) await emit('site', value);
  for (const value of inventory.gaps) await emit('gap', value);
  for (const value of inventory.excluded ?? []) await emit('excluded', value);
  for (const value of inventory.enumeration?.scanned ?? []) await emit('scanned', value);
  for (const value of inventory.enumeration?.unscanned ?? []) await emit('unscanned', value);
  for (const value of reviews) await emit('review', value);
  for (const value of report.syntaxReviews) await emit('review', value);
  const checked = new Set(report.coverage.checked), notChecked = new Set(report.coverage.notChecked);
  const residue = new Set(report.coverage.residue), problems = new Map(report.problems.map(row => [row.id, row.reasons]));
  for (const id of report.coverage.population) await emit('coverage', { id,
    partition: checked.has(id) ? 'checked' : notChecked.has(id) ? 'notChecked' : 'notApplicable',
    residue: residue.has(id), reasons: problems.get(id) ?? [] });
  const footer: CensusFooter = { seq, kind: 'complete', sha256: hash.digest('hex'), counts, ready: report.ready };
  await write(JSON.stringify(footer) + '\n');
  return footer;
}

/** Consume every line through the completion footer before trusting any record.
 * onRecord receives provisional rows so consumers can spool instead of buffering
 * the artifact. Missing/corrupt/reordered records require regenerating the export;
 * no prefix is a successful census and no record is silently skipped.
 */
export async function readPhaseWriterCensus(lines: Iterable<string> | AsyncIterable<string>,
  onRecord: (record: CensusRecord) => void | Promise<void> = () => {}) {
  const hash = createHash('sha256'), counts = streamCounts();
  let seq = 0, footer: CensusFooter | undefined;
  let hasResidue = false;
  for await (const raw of lines) {
    if (footer) throw new Error('phase_writer_stream_after_footer');
    let row: CensusRecord | CensusFooter;
    try { row = JSON.parse(raw); } catch { throw new Error('phase_writer_stream_invalid_record'); }
    if (!row || row.seq !== seq) throw new Error('phase_writer_stream_sequence');
    if (row.kind === 'complete') {
      if (counts.header !== 1 || row.sha256 !== hash.digest('hex')
        || typeof row.ready !== 'boolean' || !row.counts
        || Object.keys(row.counts).length !== streamKinds.length
        || streamKinds.some(kind => row.counts[kind] !== counts[kind])) {
        throw new Error('phase_writer_stream_integrity');
      }
      // The digest covers the coverage records. Derive readiness from those
      // records because the footer itself is outside the digest.
      if (row.ready !== !hasResidue) throw new Error('phase_writer_stream_readiness_mismatch');
      footer = row;
      continue;
    }
    if (!streamKinds.includes(row.kind) || (seq === 0) !== (row.kind === 'header')) {
      throw new Error('phase_writer_stream_kind');
    }
    if (row.kind === 'header'
      && (row.value as { schemaVersion?: string } | null)?.schemaVersion !== 'phase-writer-census-stream-v1') {
      throw new Error('phase_writer_stream_version');
    }
    if (row.kind === 'coverage') {
      const coverage = row.value as { partition?: unknown; residue?: unknown } | null;
      const partition = coverage?.partition;
      const isUnexamined = partition === 'notChecked';
      if ((!isUnexamined && partition !== 'checked' && partition !== 'notApplicable')
        || coverage?.residue !== isUnexamined) {
        throw new Error('phase_writer_stream_invalid_coverage');
      }
      hasResidue ||= isUnexamined;
    }
    hash.update(raw.endsWith('\n') ? raw : raw + '\n');
    counts[row.kind]++; seq++;
    await onRecord(row);
  }
  if (!footer) throw new Error('phase_writer_stream_incomplete:regenerate-from-source');
  return footer;
}
