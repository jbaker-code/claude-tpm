'use strict';
/**
 * tpm-version.js — the version of the running tpm package (kind-agnostic, never throws).
 *
 * tpmVersion() -> string | null   `version` from the package.json at the package root; null when unreadable.
 * Mirrors tools/task/lib/task-model.js's reader without the session suite importing the task suite.
 * Used for the `meta.lastWriter` stamp (the B2 mixed-version stamp). Zero deps; `node tools/lib/tpm-version.js`.
 */
const path = require('path');

function tpmVersion() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const v = require(path.join(__dirname, '..', '..', 'package.json')).version;
    return typeof v === 'string' && v.trim() ? v : null;
  } catch (_e) {
    return null;
  }
}

module.exports = { tpmVersion };

if (require.main === module) {
  process.stdout.write(`${tpmVersion()}\n`);
}
