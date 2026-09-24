// Jest cannot parse the ESM-only `archiver` package; storage zipping is not
// exercised by the integration/e2e suites, so a minimal CommonJS stub is enough.
module.exports = function archiverStub() {
  throw new Error('archiver is stubbed in tests');
};
module.exports.default = module.exports;
