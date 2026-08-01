const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '../core');
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// `@whisper/core` is consumed as TypeScript source rather than a build artefact.
// One less build step, and a stack trace from the phone points at the real line
// in the protocol rather than at a line in a bundle.
config.watchFolders = [coreRoot, path.resolve(workspaceRoot, 'node_modules')];

// The repository root is the load-bearing entry. `packages/core` is an npm
// workspace, so npm hoists its `@noble/*` dependencies to the root
// `node_modules` and `packages/core/node_modules` is never created. Listing only
// the first two paths makes Metro fail to resolve `@noble/curves/ed25519.js`
// from core's own source — a bundling error that no amount of typechecking sees,
// because tsc resolves through Node and Metro does not.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(coreRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
