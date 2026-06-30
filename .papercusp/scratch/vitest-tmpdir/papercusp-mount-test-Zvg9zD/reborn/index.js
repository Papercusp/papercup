
const plugin = {
  kind: 'plugin',
  name: "reborn",
  version: '0.1.0',
  papercusp: '^0.1.0',
  capabilities: [],
  async init() {},
};
plugin.apiRoutes = globalThis["__papercusp_test_api_reborn"];
module.exports = { default: plugin };
module.exports.default = plugin;
