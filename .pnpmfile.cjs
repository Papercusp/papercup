// This repository is npm-managed. pnpm's package.json `preinstall` script is
// not a reliable guard: pnpm can link its store before invoking lifecycle
// scripts, leaving a large, foreign dependency tree in the shared checkout.
// Fail during manifest processing instead, before pnpm mutates node_modules.
module.exports = {
  hooks: {
    readPackage() {
      throw new Error('This repository is npm-managed; use `npm install` (not pnpm).');
    },
  },
};
