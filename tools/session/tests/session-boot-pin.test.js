'use strict';
/**
 * session-boot-pin.test.js — DoD B of phase 13: a single-track `boot-read` / `review` is BYTE-IDENTICAL to the
 * output of the tree before the multi-track pickup existed. The golden was captured from the unmodified tree
 * (`TPM_PIN_CAPTURE=1`), so a missing golden is a FAILURE, never a silent bootstrap.
 *
 * Run: node tests/session-boot-pin.test.js        (re-capture only deliberately: TPM_PIN_CAPTURE=1)
 */
const { assert, test, done, fs, path } = require('./helpers/harness');
const pin = require('./helpers/boot-pin-scenario');

const GOLDEN = path.join(__dirname, 'golden', 'boot-read-single-pin.txt');

test('single-track boot-read + review transcript equals the pre-phase-13 golden, byte for byte', () => {
  const { text } = pin.transcript();
  if (process.env.TPM_PIN_CAPTURE === '1') { fs.writeFileSync(GOLDEN, text); console.log(`         captured ${text.length} bytes`); return; }
  assert.ok(fs.existsSync(GOLDEN), `golden missing: ${GOLDEN} (capture it from the unmodified tree with TPM_PIN_CAPTURE=1)`);
  const want = fs.readFileSync(GOLDEN, 'utf8');
  const norm = (s) => s.replace(/\/[^\s"]*tpm-bootpin-[^/\s"]*/g, '<ROOT>');
  assert.strictEqual(norm(text), norm(want), 'single-track output drifted from the pre-phase-13 golden');
});

test('the transcript is deterministic (two runs, same bytes)', () => {
  const norm = (s) => s.replace(/\/[^\s"]*tpm-bootpin-[^/\s"]*/g, '<ROOT>');
  assert.strictEqual(norm(pin.transcript().text), norm(pin.transcript().text));
});

test('the pin covers what it claims (shape of the golden)', () => {
  if (process.env.TPM_PIN_CAPTURE === '1') return;
  const want = fs.readFileSync(GOLDEN, 'utf8');
  for (const needle of ['== PRIOR SESSION 0003', 'OPEN PUNCHLIST (2)', 'looks like the first session', 'could not be read and were skipped', 'newer record(s) were skipped', 'NOT necessarily the first session', '# Session 0001']) {
    assert.ok(want.includes(needle), `golden should contain: ${needle}`);
  }
  assert.ok(!/session-notes\.md/.test(want.replace(/^\$ boot-read \[stray.*$/m, '')), 'stray note must stay silent');
});

done('session-boot-pin.test');
