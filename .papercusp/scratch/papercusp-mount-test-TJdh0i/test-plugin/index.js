
const plugin = {
  kind: 'plugin',
  name: "test-plugin",
  version: '0.1.0',
  papercusp: '^0.1.0',
  capabilities: [],
  async init() {},
};
plugin.apiRoutes = globalThis["__papercusp_test_api_test-plugin"];
module.exports = { default: plugin };
module.exports.default = plugin;
