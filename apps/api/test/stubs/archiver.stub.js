// Jest cannot load the ESM-only `archiver` package, so every jest config maps
// it here. The fake honours the surface `StorageService.createBackup` uses
// (pipe, directory, on, pointer, finalize) and writes a small placeholder
// payload instead of a zip, so the backup flow (paths, sizes, log line,
// response shape) is exercised while no real archive is produced.
const { EventEmitter } = require('node:events');

function archiverStub() {
  const emitter = new EventEmitter();
  let output = null;
  let bytes = 0;
  const entries = [];
  return Object.assign(emitter, {
    pipe(stream) {
      output = stream;
      return stream;
    },
    directory(dirPath, name) {
      entries.push(`${name}:${dirPath}`);
      return this;
    },
    pointer() {
      return bytes;
    },
    async finalize() {
      const payload = Buffer.from(`FAKE-ARCHIVE\n${entries.join('\n')}\n`);
      bytes = payload.length;
      await new Promise((resolve, reject) => output.write(payload, (err) => (err ? reject(err) : resolve())));
      output.end();
    },
  });
}
module.exports = archiverStub;
module.exports.default = archiverStub;
