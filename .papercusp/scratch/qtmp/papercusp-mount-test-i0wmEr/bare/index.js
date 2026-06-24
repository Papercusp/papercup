
const plugin = {
  kind: 'plugin',
  name: "bare",
  version: '0.1.0',
  papercusp: '^0.1.0',
  capabilities: [],
  async init() {},
};
plugin.apiRoutes = globalThis["__papercusp_test_api_bare"];
module.exports = { default: plugin };
module.exports.default = plugin;
