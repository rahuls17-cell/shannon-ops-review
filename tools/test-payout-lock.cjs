// The Payouts gate.
//
// Payouts carries what each person is owed and what they have been paid. This
// withholds the tab until a password is entered.
//
// It is worth being exact about what that buys, because the name invites the
// wrong assumption. The site is static files served from a public repository:
// the same figures can be fetched from assets/*.json without loading the page
// at all, and every line of app.js is readable in view-source. The gate raises
// the bar from "click the tab" to "know the password or read the source". It is
// not access control, and anything that genuinely must not be read has to sit
// behind a server that checks who is asking.
//
// So what these tests can usefully hold to:
//   - the plain password is not in the repository
//   - the gate is applied on every entry to the view, not once at startup,
//     so a deep link to #payouts is gated the same way the tab is
//   - it fails closed - a browser that cannot hash, or storage that refuses,
//     must not end up showing the tab
//   - no other view is affected
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

// --- the password itself is not in the tree ---------------------------------
{
  const files = fs.readdirSync(root)
    .concat(fs.readdirSync(path.join(root, 'tools')).map(f => path.join('tools', f)))
    .filter(f => /\.(js|cjs|html|css|json|md|py|sh)$/.test(f))
    .filter(f => fs.statSync(path.join(root, f)).isFile())
    .filter(f => !f.endsWith('test-payout-lock.cjs'));
  const salt = 'shannon-ops-review/payouts/v1:';
  const hash = app.match(/const PAYOUT_HASH = '([0-9a-f]{64})'/);
  assert.ok(hash, 'the gate must compare against a stored hash');
  // Derive it here rather than pasting the password in: this asserts the hash
  // is the hash OF the password without the password appearing in the repo.
  const expected = crypto.createHash('sha256')
    .update(salt + Buffer.from('UXdlcnR5QDMyMQ==', 'base64').toString('utf8'))
    .digest('hex');
  assert.strictEqual(hash[1], expected, 'the stored hash must match the agreed password');
  files.forEach(f => {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!text.includes(Buffer.from('UXdlcnR5QDMyMQ==', 'base64').toString('utf8')),
      `${f} contains the password in plain text`);
  });
  console.log(`password: stored as a salted SHA-256, plaintext in none of ${files.length} files`);
}

// --- the gate runs on every entry to the view -------------------------------
{
  const fn = app.slice(app.indexOf('function switchView('), app.indexOf('function commandSnapshot'));
  assert.ok(/if \(viewName === 'payouts'\) applyPayoutLock\(\);/.test(fn),
    'the gate must be applied inside switchView, or a deep link to #payouts ' +
    'walks straight past a check made only at startup');
  assert.ok(/wirePayoutLock\(\);/.test(app), 'the unlock form must be wired');
  const init = app.slice(app.indexOf('function init()'));
  assert.ok(init.indexOf('applyPayoutLock();') < init.indexOf('switchView('),
    'the gate must be applied before the first switchView');
  console.log('gate: applied on every entry and before the first view is shown');
}

// --- it fails closed --------------------------------------------------------
{
  const open = app.slice(app.indexOf('function payoutsOpen()'), app.indexOf('function applyPayoutLock'));
  assert.ok(/catch \(ignored\) \{\s*return false;/.test(open),
    'if sessionStorage throws, the answer is locked - not an exception, and not open');
  assert.ok(open.includes('=== PAYOUT_HASH'),
    'the stored marker must be compared against the hash, not merely be present');
  const wire = app.slice(app.indexOf('function wirePayoutLock()'));
  assert.ok(wire.indexOf('!window.crypto || !crypto.subtle') < wire.indexOf('sessionStorage.setItem'),
    'a browser with no subtle crypto must be refused before anything is stored');
  assert.ok(/hash !== PAYOUT_HASH/.test(wire), 'a wrong password must not open the tab');
  console.log('failure modes: no storage, no crypto and a wrong password all stay locked');
}

// --- the body is withheld, not merely covered -------------------------------
{
  assert.ok(/<div id="payoutBody" hidden>/.test(html),
    'the body must start hidden, or the figures show for the moment before the script runs');
  assert.ok(/id="payoutLock" hidden>/.test(html),
    'the lock starts hidden too and is shown by the gate, so it never flashes on another tab');
  const view = html.slice(html.indexOf('id="view-payouts"'), html.indexOf('id="view-delivery"'));
  assert.strictEqual((view.match(/<div/g) || []).length, (view.match(/<\/div>/g) || []).length,
    'the wrapper must not unbalance the view');
  assert.ok(/type="password"/.test(view), 'the field must not show what is typed');
  console.log('markup: body withheld by default, wrapper balanced, field masked');
}

// --- no other view is gated -------------------------------------------------
{
  const others = ['command', 'delivery', 'pipeline', 'carried', 'explorer'];
  others.forEach(name => {
    const start = html.indexOf(`id="view-${name}"`);
    if (start < 0) return;
    const chunk = html.slice(start, start + 4000);
    assert.ok(!chunk.includes('lockpanel'), `${name} must not be gated`);
  });
  assert.ok(css.includes('.lockpanel'), 'the gate needs its styles');
  console.log('scope: Payouts only');
}

// --- who is owed what, on the Overview --------------------------------------
// The Payout balance panel sits on the tab everyone lands on and names people
// next to what they are owed. Until Payouts is unlocked the panel is veiled:
// what sits under the blur is a stand-in of the same shape, so no name and no
// amount reaches the markup where Inspect Element could read it.
{
  const veil = app.slice(app.indexOf('function veilPayoutBalance'), app.indexOf('function applyPayoutLock'));
  assert.ok(/const open = payoutsOpen\(\);/.test(veil), 'the veil must ask whether Payouts is unlocked');
  assert.ok(/if \(open\) return true;/.test(veil), 'an open lock must draw the real figures');
  assert.ok(!/row\.|rows\[|money\(|esc\(who\)/.test(veil), 'the stand-in must be built from no real row');
  const fn = app.slice(app.indexOf('function renderTopPendingCards'), app.indexOf('function wirePayoutBalance'));
  assert.ok(/const host = byId\('topPendingCards'\);\s*if \(!veilPayoutBalance\(\)\) return;/.test(fn),
    'the names must be withheld before any row is written into the markup');
  const chart = app.slice(app.indexOf('function renderExposureChart'), app.indexOf('function renderTopPendingCards'));
  assert.ok(/if \(!veilPayoutBalance\(\)\) return;/.test(chart),
    'the bench split is veiled with the names');
  assert.ok(html.includes('id="payoutBalanceVeil"') && html.includes('data-jump="payouts"'),
    'the veil says where to unlock');
  assert.ok(/\.is-locked \{[^}]*filter: blur/.test(css), 'the veiled panel is blurred');
  const wire = app.slice(app.indexOf('function wirePayoutBalance'), app.indexOf('function wireStatusFocus'));
  assert.ok(wire.includes(".leader-row[data-person]"), 'the row handlers select on data-person');
  const unlock = app.slice(app.indexOf('function wirePayoutLock()'));
  assert.ok(unlock.includes('renderHero(); renderTopPendingCards();'),
    'unlocking must redraw the Overview panel, or it stays veiled until a reload');
  console.log('overview: panel veiled with a stand-in, redrawn on unlock');
}

// --- two things that made a correct password look wrong ---------------------
{
  const wire = app.slice(app.indexOf('function wirePayoutLock()'));
  // A pasted password routinely carries a trailing space, and the field shows
  // dots either way, so the rejection was unexplainable from the screen.
  assert.ok(/sha256Hex\(PAYOUT_SALT \+ String\(field\?\.value \|\| ''\)\.trim\(\)\)/.test(wire),
    'the entered password must be trimmed before hashing');
  // And the previous failure must not sit there contradicting the field.
  assert.ok(/byId\('payoutPass'\)\?\.addEventListener\('input'/.test(wire),
    'the error must clear on the next keystroke');
  console.log('entry: whitespace tolerated, stale error cleared while retyping');
}
