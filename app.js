const data = window.OPS_REVIEW_DATA;
let finalisationSource = null;
let finalisationRows = [];
let finalisationCohorts = [];
const FINALISATION_ROW_CAP = 400;
let gcsPipeline = null;
let payoutLedger = null;
let payoutLedgerTasks = [];
let clientAcceptance = null;
// The GCS-derived pipeline (tools/ingest_verdicts.py -> build_provenance.py).
// Every state and predicate on these rows was decided by that chain, so the
// browser only selects and tallies - it never re-derives a status.
let truth = null;
let truthPage = 0;
let openChain = null;
const TRUTH_PAGE_SIZE = 40;
const TRUTH_FILTERS = ['tState', 'tGate', 'tFinding', 'tDelivery', 'tCarried',
  'tConfidence', 'tDuplicate', 'tDomain', 'tOwner'];
let explorer = null;
let explorerPath = '';
let explorerEntry = null;
// PRD X1: one range for the whole dashboard except Payouts, which reports what
// the workbook paid rather than when the work happened.
const dateRange = {start: '', end: ''};
let harborConsole = null;
let consoleLive = null;
let pipelinePage = 0;
let payoutPage = 0;
let ledgerPage = 0;
const PAYOUT_PAGE_SIZE = 25;
const LEDGER_PAGE_SIZE = 25;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function taskKey(value) {
  return String(value || '').toLowerCase()
    .replace(/-(?:v|version)[0-9][a-z0-9.-]*$/, '')
    .replace(/-(?:final|modified|reviewed(?:-[0-9]+)?|hardened|candidate|clean|submit)$/, '')
    .replace(/-[0-9]{8}t[0-9]{6}z(?:-[0-9]+-?[0-9]*)?$/, '');
}
function acceptedMatchKey(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/^harbor\//, '')
    .replace(/-(?:v|version)[0-9][a-z0-9.-]*$/, '');
}
const pipelineReference = new Map();
['current', 'historical'].forEach(key => (data.pipeline?.[key] || []).forEach(row => {
  if (row.taskType === 'Connector' || row.taskType === 'Non-connector') pipelineReference.set(taskKey(row.task), row.taskType);
}));
function pipelineDomain(task) {
  const existing = String(task.domain || task.taskType || '').trim();
  if (existing && !['Unknown', 'Connector', 'Non-connector'].includes(existing)) return existing;
  const name = String(task.task || task.taskId || '').toLowerCase();
  const prefix = name.match(/^(code|fin|health|law|gen|bus)-/i)?.[1]?.toLowerCase();
  return ({code:'Code', fin:'Finance', health:'Health', law:'Law', gen:'General', bus:'Business'}[prefix] || 'General');
}
function pipelineType(task) {
  const recorded = pipelineReference.get(taskKey(task.task));
  if (recorded) return recorded;
  if (task.taskType === 'Connector' || task.taskType === 'Non-connector') return task.taskType;
  const name = String(task.task || task.taskId || '').toLowerCase();
  if (/(^|[-_])(ach|plaid|card|wire|check|debit|credit|bank|account|transfer|payment|bill|savings|ofac|kyc|merchant|transaction)([-_]|$)/.test(name)) return 'Connector';
  if (/^(code|fin|health|law|gen|bus)-/.test(name)) return 'Non-connector';
  return 'Not recorded';
}
const infoCopy = {
  accepted: 'Distinct tasks found in the finalisation cohorts of the bucket. A task finalised into more than one cohort has a folder in each, so folders are collapsed to task names first - the name is read from task.toml inside the archive, because folder names are sometimes opaque pipeline ids. This is delivered work, not the payout basis.',
  sources: 'Every number on this dashboard comes from one of these, and each entry states what it holds, why we read it and how it reaches the page. Live means the page read it during this visit; snapshot means a committed export, which moves only when the export is re-run; not connected means nothing reads it yet. All access is read-only - the dashboard never writes to a bucket, a sheet or a database.',
  consoleCounts: 'The Harbor Console is the source of truth for finalisation. Its counts are shown here as pulled, not recomputed. Our bucket scan lists what is physically stored under tasks/, and that prefix is reorganised and pruned - of 194 folders that left the accepted cohorts overnight, 172 were still in the console and 171 still accepted. So a folder count under-reports accepted work and the console figure is the one to quote. Legacy is the console\u2019s own bucket for anything before 5 September. The console sits behind IAP, so this is a pull through an authenticated browser session rather than a live read.',
  basis: 'The Harbor Console lists one row per submission, and its cards count those rows. This page lists one row per task, taken at its latest submission, because a task resubmitted five times is still one piece of work and counting it five times would overstate delivery and pay. Neither number is wrong: subtract the re-submissions from the console figure and you get this page. The residual few are the console filter starting at a time of day where ours starts at midnight, and anything submitted since the last pull.',
  explorerScope: 'A metadata-only mirror of the delivery prefixes of the GCS bucket: the seven finalisation cohorts and the trainer evaluation records. It holds names, sizes and timestamps, never object contents, and it never writes to the bucket. The whole bucket is far larger - over 22 million objects and 9 million folders - which cannot be mirrored into a static page, so prefixes outside this scope are deliberately absent rather than silently empty.',
  truthTasks: 'One row is one task, not one submission. Runs of the same task are grouped by the family the pipeline assigned them, and the row shows the canonical run: the one that got furthest, breaking ties on outcome and then on decision time. Every other run stays attached under the row. The State column carries the predicate that decided it, and the source is the verdict object it was read from.',
  finding: 'What the gate objected to. The filter searches every run of a task, so a task that tripped a check, was fixed and then accepted is still findable under that check. The row itself separates the two: the Findings line shows what the run behind the current verdict found, and names anything that came from an earlier run of the same task. An accepted task showing HARBOR-CHECK from an earlier run was not accepted despite failing - it failed, was fixed, and passed.',
  gateEra: 'Which gate judged the deciding run, taken from the bucket\'s own sentinel files rather than inferred. The gate switched from Opus to GLM-5.2 at 2026-09-13T20:05:59Z, KESTREL came on at 2026-09-15T03:40:49Z, and KESTREL was fully operating on both gates from 2026-09-16T05:06:54Z. Acceptances made by GLM-5.2 without KESTREL review were withdrawn on 16 September and are being re-gated.',
  scope: 'The cut is applied to the date a task was DECIDED, not the date it was submitted. A task uploaded in August but judged by the pipeline running today belongs to today, because the bar running today is what judged it. Cutting on submission instead would hide exactly the re-gated work that matters most. Tasks whose last decision falls before 5 September are excluded entirely and are not shown anywhere on this page. About a fifth of verdicts carry no decision timestamp - those are the runs that errored or never finished, so there was never a ruling to time - and they are placed by when the verdict was last updated and marked approx.',
  duplicates: 'A task is flagged when another task in scope carries the same name AND the same trainer. Likely means it also shares the decision day and the outcome. Most flagged rows do have a family id: that key is clean, in that no family spans two trainers, but it is not complete, because a task can be given a fresh family id when it is resubmitted - so the same work can appear two or three times under different families. Nothing is merged, because a task name can legitimately cover unrelated work: one name in this bucket carries 36 genuinely different tasks. Treat this as a review queue, not a correction.',
  confidence: 'How confidently runs were grouped into one task. Keyed by family is the pipeline\'s own lineage id and is reliable - no family in this data spans two trainers. Unmerged means no family id was present, so the task is keyed on its submission id and repeat runs of it may still be counted separately. Task name was never used as a key: one literal name in this bucket carries 36 unrelated tasks.',
  slicer: 'One range for the whole dashboard. It filters Overview, Delivery and Pipeline by the date each record carries - the day a task was last submitted, the day an archive landed, the day of the mining plan. Payouts is deliberately excluded: the Paid Out tab records what was paid, not when the work was done, so a date filter there would silently drop people who were paid for older work. Both ends are inclusive and either can be left empty. Records with no date are excluded as soon as a date is set.',
  clientAccepted: 'Tasks the client accepted, taken from the Harbor 240 dashboard. A task counts as accepted when the audit sheet marks it priority Low; the published acceptance layer is derived from the same sheet and agrees with that rule on every task, so it is used as a cross-check rather than a second source. This covers the 240-task audit set only, not the whole bucket, and it is a review verdict rather than a payment.',
  v2Accepted: 'Task folders in tasks/finalisation_client_qc_accepted_iteration_2/ in the bucket - the second client QC finalisation round. It is one of three accepted cohorts, so it is smaller than the accepted total on the Finalisation tab, and a task finalised into more than one cohort is counted here once per folder. Read it as the size of the v2 round, not as the total accepted work.',
  paid: 'Total Tasks Approved and Total Payment Amount from the Paid Out tab of the Ops Review workbook, cross-checked against the Live Import payment tracker and joined to people by child job number rather than email, because the tracker spells one address differently. These are workbook records, not live bank transactions.',
  pending: 'Per person: accepted tasks minus tasks already paid, never below zero, priced at $300 each. Accepted comes from the workbook task list after duplicate rows are collapsed. Payments already made stay as recorded, including three made against duplicate rows, so deduplication only prevents a task being paid twice from here on.',
  commandSources: 'Each number counts a different population and they overlap, so adding them is wrong. Current evaluations is the latest attempt per task family in the evaluation ledgers. Accepted folders is what physically exists in the finalisation cohorts. Most tasks accepted in the pipeline already have a finalisation folder.',
  commandBench: 'Company is the Company team; Computer covers Computer A and Computer B. A task is assigned through its resolved owner, so anything with a contested or missing owner belongs to neither bench and is excluded from bench money.',
  bench: 'Company bench is the Company team. Computer bench covers Computer A and Computer B. Everything else, including people with no team recorded, appears under Unassigned. This filter combines with the search and payment state controls and changes only what is shown, never how anything is calculated.',
  payoutAccepted: 'Tasks listed for this person on the task wise tab of the Shannon PPT workbook, after rows repeating the same task for the same trainer are folded together. Every unique task counts, including the two rows the workbook marks Valid = 0. The Harbor 240 dashboard and the GCS bucket are deliberately not used for this number.',
  population: 'Three different populations of the same ledgers, never to be added together. Current work keeps only the latest attempt of each task family, so it answers where things stand now. Every attempt keeps the retries as separate records, so it answers how much work was done. Legacy QC runs are archived owner snapshots from before the current pipeline. Switching population rebuilds every filter below from that population.',
  ledgerPayment: 'Paid means the person was paid for at least as many tasks as this ledger lists for them, so every one of their tasks is covered. Not itemised means they were paid for fewer tasks than they have listed and no workbook column records which ones - Michael is the only such case, paid for 10 of 29. No payment recorded means no payment request exists for them at all.',
  ledgerAcceptance: 'The workbook Valid column, shown for audit only. Every unique task counts as accepted regardless of this flag, so a Valid = 0 row still carries pending payment. Two rows currently carry it: one whose child job is NA, and one whose child job cell says someone is looking into it.',
  trainerPick: 'Lists only people who have accepted work or a payment recorded against them, which is why it is short - the rest of the roster has nothing to pay. Picking one narrows both tables on this tab to that person: their payout row, and every task in their ledger. Use the search box instead to look someone up across the whole roster.',
  ledgerDuplicates: 'How many workbook rows folded into this one task. Above 1 means the same task and trainer were listed more than once. The extra rows are excluded from every accepted and pending count, but they are not hidden - filter to Folded rows only to see them.',
  duplicates: 'Accepted work lives in three cohorts and the same task can be finalised into several of them. Folders are what the bucket holds; distinct tasks is what was actually done. The newest archive represents the task and the rest are marked as repeats, which is why adding the cohort totals together overstates the work.',
  ownership: 'Three tiers, strongest first. Harbor Console submitter is the console\u2019s own record of who submitted the task and is treated as proof. Name match only is the GCS trainer records joined by declared task name - finalisation repackages archives, so digests never match and the name is the only join available; that is evidence, not proof. Contested means two records claim the same name and the console does not settle it, so the task stays unassigned rather than being given to whoever was found first. The console export is a point-in-time dump, not live.',
  pipeline: 'The status names are the Harbor Console\u2019s own: its finalisation run state is done, rejected, parked or running, which the spec restates as Accepted, Rejected, Failed and Running. Rejected means harbor checks failed and the trainer reworks it - the largest bucket by far. Failed means an infrastructure error the trainer cannot rerun; it parks for QC or gen engineering. Submitted means the gate passed but no decision is recorded yet, which is what used to be shown as Done - it is not an acceptance. Current counts the latest attempt per family; All attempts counts retries separately.',
  dates: 'Filters records by their recorded date, inclusive at both ends, and either end can be left empty. Records with no date are excluded as soon as a date is set. Status counts and the table use the same filter. Payout figures are untouched.',
  workbook: 'A workbook-wide snapshot with no reliable person-level allocation, so it does not respond to the filters on the other tabs and cannot be split by trainer.',
};

function renderEverything() {
  renderSources();
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams();
  renderBenchCards();
  renderPlan();
  if (truth) { renderTruth(); renderCarried(); }
}

// The bucket is no longer a view of its own - it is the delivery evidence
// hanging off each pipeline row - so this only prepares data.
function loadFinalisation() {
  if (!gcsPipeline?.finalisation) return;
  try {
    finalisationSource = gcsPipeline.finalisation;
    finalisationCohorts = finalisationSource.cohorts;
    finalisationRows = window.prepareFinalisation(finalisationSource, data.trainers,
      {owners: {...(harborConsole?.owners || {}), ...(consoleLive?.owners || {})}});
  } catch (error) {
    finalisationRows = [];
    setTextIfPresent('pipelineSourceStatus', `Bucket evidence rejected: ${error.message}`);
  }
}

async function loadConsoleLive() {
  try {
    const response = await fetch(`assets/harbor-console-live.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!response.ok) throw new Error('No console pull available');
    consoleLive = await response.json();
  } catch {
    consoleLive = null;
  }
  renderSources();
}

function ageOf(stamp) {
  const hours = (Date.now() - new Date(stamp).getTime()) / 3600000;
  if (!isFinite(hours)) return 'unknown age';
  if (hours < 1) return 'pulled in the last hour';
  if (hours < 48) return `pulled ${Math.round(hours)} hours ago`;
  return `pulled ${Math.round(hours / 24)} days ago`;
}

async function loadHarborConsole() {
  // PRD C5. The console itself is behind IAP; this is its exported dump, so it
  // is a point-in-time record and the page says how stale it is.
  try {
    const response = await fetch('assets/harbor-console.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Console export unavailable');
    harborConsole = await response.json();
  } catch {
    harborConsole = null;
  }
  renderSources();
}

async function loadClientAcceptance() {
  // Same origin on Pages, so the live dashboard is readable; locally it is not,
  // and the committed snapshot carries the same counts.
  try {
    const response = await fetch('../harbor-240-dashboard/', {cache: 'no-store', signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('240 dashboard unavailable');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const rows = JSON.parse(doc.getElementById('dashboard-data').textContent).rows;
    if (!Array.isArray(rows) || !rows.length) throw new Error('240 dashboard published no rows');
    clientAcceptance = {live: true, tasks: rows.length,
      accepted: rows.filter(row => row.priority === 'Low').length};
  } catch {
    try {
      const response = await fetch('assets/client-acceptance.json', {cache: 'no-store'});
      if (!response.ok) throw new Error('Snapshot unavailable');
      const snapshot = await response.json();
      clientAcceptance = {...snapshot, live: false};
    } catch {
      clientAcceptance = null;
    }
  }
  renderSources(); renderHero();
}

async function loadPayoutLedger() {
  try {
    const response = await fetch('assets/payout-ledger.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Payout ledger unavailable');
    const payload = await response.json();
    payoutLedgerTasks = window.preparePayoutLedger(payload, data.trainers);
    payoutLedger = payload;
  } catch {
    setText('ledgerStatus', 'Payout ledger unavailable. Accepted tasks fall back to the Finalisation reconciliation.');
    return;
  }
  populateLedgerFilters();
  populateTrainerPicker();
  renderTrainerRows();
  renderSources(); renderHero(); renderTopPendingCards(); renderBenchCards();
}

function populateLedgerFilters() {
  const options = {
    ledgerType: ['All task types', [...new Set(payoutLedgerTasks.map(row => row.filterType))].sort()],
    ledgerPayment: ['All payment states', [...new Set(payoutLedgerTasks.map(row => row.paymentState))].sort()],
  };
  Object.entries(options).forEach(([id, [label, values]]) => {
    const select = byId(id), selected = select.value;
    select.innerHTML = `<option value="">${label}</option>` + values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    select.value = values.includes(selected) ? selected : '';
  });
}

function renderPayoutLedger() {
  if (!payoutLedger) return;
  const picked = byId('trainerFilter').value;
  const result = window.filterPayoutLedger(payoutLedgerTasks, {
    emails: picked ? [picked] : null,
    bench: byId('benchFilter').value,
    search: byId('ledgerSearch').value,
    payment: byId('ledgerPayment').value,
    type: byId('ledgerType').value,
    validity: byId('ledgerValidity').value,
    duplicates: byId('ledgerDuplicates').value,
  });
  const totals = payoutLedger.totals;
  setText('ledgerStatus', `${fmt(totals.sourceRows)} workbook rows collapsed to ${fmt(totals.ledgerTasks)} tasks / ${fmt(totals.acceptedTasks)} counted as accepted / ${fmt(totals.paidTasks)} tasks paid across ${fmt(totals.paymentRequests)} payment requests, of which ${fmt(totals.itemisedPaidTasks)} name a task and ${fmt(totals.unitemisedPaidTasks)} (${money(totals.unitemisedPaidAmount)}) exceed the tasks listed for that person`);
  const people = new Map((payoutLedger.people || []).map(person => [person.email, person]));
  byId('ledgerSummary').innerHTML = [
    ['Ledger tasks shown', fmt(result.rows.length)],
    ['Accepted and payable', fmt(result.accepted)],
    ['Paid tasks shown', fmt(result.paid)],
    ['Duplicate rows removed', fmt(result.duplicateRows)],
    ['Payments not itemised', fmt(result.unitemised)],
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
  const ledgerPages = Math.max(1, Math.ceil(result.rows.length / LEDGER_PAGE_SIZE));
  ledgerPage = Math.min(Math.max(ledgerPage, 0), ledgerPages - 1);
  const ledgerFrom = ledgerPage * LEDGER_PAGE_SIZE;
  const ledgerShown = result.rows.slice(ledgerFrom, ledgerFrom + LEDGER_PAGE_SIZE);
  setText('ledgerPage', result.rows.length
    ? `${fmt(ledgerFrom + 1)}-${fmt(ledgerFrom + ledgerShown.length)} of ${fmt(result.rows.length)} ${result.rows.length === 1 ? 'task' : 'tasks'} / page ${fmt(ledgerPage + 1)} of ${fmt(ledgerPages)}`
    : 'No tasks match these filters');
  byId('ledgerPrevious').disabled = ledgerPage === 0;
  byId('ledgerNext').disabled = ledgerPage >= ledgerPages - 1;
  byId('ledgerRows').innerHTML = ledgerShown.map(row => {
    const person = people.get(row.email);
    const payment = row.paymentState === 'Not itemised'
      ? `${fmt(person?.paidTasks)} of ${fmt(person?.listedTasks)} tasks paid`
      : row.paymentState === 'Paid' ? 'Paid $300' : 'No payment recorded';
    return `
        <tr>
          <td><div class="person"><strong>${esc(row.task)}</strong><span>${row.valid ? 'Valid' : 'Not valid in workbook'}${row.harborLink ? ` / <a href="${esc(row.harborLink)}" target="_blank" rel="noopener">Harbor console</a>` : ''}</span></div></td>
          <td>${esc(row.trainer?.name || 'Unassigned')}<br><small>${esc(row.email)}</small></td>
          <td>${esc(row.filterType)}<br><small>${esc(row.trainer?.team || 'Unassigned')}</small></td>
          <td><span class="pill ${row.valid ? '' : 'is-warn'}">${row.valid ? 'Valid' : 'Valid = 0'}</span><div class="muted">Counted as accepted</div></td>
          <td><span class="pill ${row.paymentState === 'Paid' ? 'is-ok' : row.paymentState === 'Not itemised' ? 'is-warn' : ''}">${esc(row.paymentState)}</span><div class="muted">${esc(payment)}</div></td>
          <td>${esc(row.cj || 'Not recorded')}</td>
          <td class="num">${fmt(row.duplicateRows + 1)}${row.duplicateRows ? `<div class="muted">${fmt(row.duplicateRows)} excluded</div>` : ''}</td>
        </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No ledger tasks match these filters.</td></tr>';
}

async function loadTruth() {
  try {
    const response = await fetch(`assets/pipeline-truth.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!response.ok) throw new Error(`asset returned ${response.status}`);
    truth = window.prepareTruth(await response.json());
    populateTruthFilters();
    renderTruth();
    renderCarried();
  } catch (error) {
    truth = null;
    setText('truthStatus', `The derived pipeline could not be loaded: ${error.message}. ` +
      'Run tools/ingest_verdicts.py through build_provenance.py on the Harbor VM and publish assets/pipeline-truth.json.');
    setText('carriedStatus', 'Waiting for the derived pipeline.');
  }
  renderSources();
}

// Rebuild from the bucket on demand. The page cannot read GCS itself, so this
// asks the local helper to run the chain on the Harbor VM and fetch the result.
// Published builds have no helper, so there the button re-reads the asset.
// After dispatching the workflow, poll for a newer asset rather than making
// anyone reload. Gives up after ten minutes so it cannot poll forever.
let rebuildWatcher = null;
function watchForRebuild() {
  if (rebuildWatcher) clearInterval(rebuildWatcher);
  const started = truth?.generatedAt || '';
  const until = Date.now() + 10 * 60 * 1000;
  rebuildWatcher = setInterval(async () => {
    if (Date.now() > until) { clearInterval(rebuildWatcher); rebuildWatcher = null; return; }
    try {
      const response = await fetch(`assets/pipeline-truth.json?t=${Date.now()}`, {cache: 'no-store'});
      if (!response.ok) return;
      const payload = await response.json();
      if (payload.generatedAt && payload.generatedAt !== started) {
        clearInterval(rebuildWatcher);
        rebuildWatcher = null;
        truth = window.prepareTruth(payload);
        populateTruthFilters();
        renderTruth();
        renderCarried();
        setText('truthStatus', `New data published ${new Date(payload.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}.`);
      }
    } catch { /* keep waiting; a deploy in flight can serve a partial response */ }
  }, 30000);
}

async function rebuildTruth() {
  const button = byId('truthRefresh');
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  if (!local) {
    // A published page has no helper and cannot hold a credential, so the
    // rebuild runs as a GitHub Action that asks the Harbor VM for the result.
    // The page opens that control, then watches for the new asset to land.
    window.open('https://github.com/rahuls17-cell/shannon-ops-review/actions/workflows/refresh-truth.yml',
      '_blank', 'noopener,noreferrer');
    setText('truthStatus', 'Choose Run workflow in the tab that just opened. The rebuild takes about a minute; ' +
      'this page checks for the new data every 30 seconds and loads it automatically.');
    watchForRebuild();
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Rebuilding…';
  setText('truthStatus', 'Running the eight-step chain on the Harbor VM: verdicts, delivery, identity, canonical run, state, tags, provenance, reconcile. This takes about half a minute.');
  try {
    const response = await fetch('/api/refresh-truth', {method: 'POST', cache: 'no-store'});
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) {
      // The chain refused to publish itself. Keep showing the old data and say why.
      setText('truthStatus', `${body.error} Nothing on this page has changed. ${String(body.detail || '').split('BUILD BLOCKED:').pop().trim().slice(0, 300)}`);
      return;
    }
    if (response.status === 501 || response.status === 404) {
      // python -m http.server answers POST with 501. That is not a failure of
      // the rebuild, it means the page is being served without the helper.
      throw new Error('this page is served by a plain static server, which has no rebuild endpoint. ' +
        'Serve it with `python tools/truth_server.py` instead and the button will rebuild from the bucket');
    }
    if (!response.ok || !body.ok) throw new Error(body.error || `helper returned ${response.status}`);
    await loadTruth();
    setText('truthStatus', `Rebuilt from gs://obi-harbor-pipeline in ${body.seconds}s / ` +
      `${new Date(body.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})} / ` +
      Object.entries(body.figures || {}).slice(0, 4).map(([k, v]) => `${k} ${fmt(v)}`).join(' / '));
  } catch (error) {
    setText('truthStatus', `Rebuild failed: ${error.message}. The previously loaded data is still shown and is unchanged.`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function truthFilters() {
  return {
    state: byId('tState').value, gateEra: byId('tGate').value,
    finding: byId('tFinding').value, delivery: byId('tDelivery').value,
    carriedOver: byId('tCarried').value, confidence: byId('tConfidence').value,
    domain: byId('tDomain').value, owner: byId('tOwner').value,
    duplicate: byId('tDuplicate').value,
    search: byId('tSearch').value,
    start: dateRange.start, end: dateRange.end,
  };
}

function fillSelect(id, counts, allLabel) {
  const node = byId(id);
  if (!node) return;
  const keep = node.value;
  const entries = Object.entries(counts || {})
    .filter(([value]) => value && value !== '(none)')
    .sort((a, b) => b[1] - a[1]);
  node.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    entries.map(([value, n]) => `<option value="${esc(value)}">${esc(value)} (${fmt(n)})</option>`).join('');
  if ([...node.options].some(o => o.value === keep)) node.value = keep;
}

function populateTruthFilters() {
  if (!truth) return;
  const v = truth.vocabulary;
  fillSelect('tState', v.finalState, 'Any state');
  fillSelect('tGate', v.gateEra, 'Any gate');
  fillSelect('tFinding', v.findingFamilies, 'Any finding');
  fillSelect('tDomain', v.domain, 'Any domain');
  fillSelect('tOwner', v.owner, 'Any trainer');
  fillSelect('cState', v.finalState, 'Any state');
  fillSelect('cOwner', v.owner, 'Any trainer');
}

// A figure is a value plus the chain that produced it. Clicking one opens the
// chain rather than sending anyone to ask how it was computed.
// Decisions per day, broken out by outcome. A heatmap rather than bars because
// the question is not only "how many that day" but "of what kind" - the column
// still carries the daily volume, and the row now carries the composition.
//
// Sequential ramp: one hue, light to dark, validated against the page surface.
// Deliberately violet, not the blue used by the Delivery heatmap, so two
// different measures are never mistaken for the same scale.
const SCOPE_BANDS = [
  {limit: 0.10, step: 1},
  {limit: 0.25, step: 2},
  {limit: 0.50, step: 3},
  {limit: 0.75, step: 4},
  {limit: Infinity, step: 5},
];
const SCOPE_ROWS = ['accepted', 'legacy accepted', 'rejected', 'no QC decision', 'error', 'running'];

function renderScope(result) {
  if (!truth) return;
  const days = [...new Set(result.rows.map(row => row.decided).filter(Boolean))].sort();
  if (!days.length) {
    byId('scopeChart').innerHTML = '<p class="empty">No decisions in this selection.</p>';
    setText('scopeNote', '');
    return;
  }
  // error and "no QC decision" are the same bucket to a reader; merge the label.
  const label = state => (state === 'error' ? 'no QC decision' : state);
  const states = [...new Set(result.rows.map(row => label(row.state)))]
    .sort((a, b) => SCOPE_ROWS.indexOf(a) - SCOPE_ROWS.indexOf(b));
  const grid = new Map();
  const perDay = new Map();
  for (const row of result.rows) {
    if (!row.decided) continue;
    const key = `${label(row.state)}|${row.decided}`;
    grid.set(key, (grid.get(key) || 0) + 1);
    perDay.set(row.decided, (perDay.get(row.decided) || 0) + 1);
  }
  const busiest = Math.max(...grid.values());

  const legacy = (truth.figures.get('Accepted')?.steps || [])
    .find(step => step.step.startsWith('one canonical run'))?.count;
  const excluded = legacy ? legacy - truth.rows.length : null;
  setText('scopeNote', `Every task on this page was decided between ${days[0]} and ${days.at(-1)}. ` +
    'The cut is on the decision date, not the submission date' +
    (excluded ? `, and ${fmt(excluded)} tasks whose last decision predates ${truth.cut} are excluded entirely.` : '.'));

  const cells = state => days.map(day => {
    const n = grid.get(`${state}|${day}`) || 0;
    if (!n) return `<td class="scope-cell" data-step="none" data-tip="${esc(day)}: no ${esc(state)} decisions"><span>&middot;</span></td>`;
    const band = SCOPE_BANDS.find(entry => n / busiest < entry.limit) || SCOPE_BANDS.at(-1);
    const share = Math.round((n / (perDay.get(day) || n)) * 100);
    return `<td class="scope-cell" data-step="${band.step}" data-tip="${esc(day)} / ${esc(state)}: ${fmt(n)} task${n === 1 ? '' : 's'}, ${share}% of that day">
      <span>${fmt(n)}</span></td>`;
  }).join('');

  byId('scopeChart').innerHTML = `
    <div class="scopeheat-wrap">
      <table class="scopeheat">
        <thead><tr><th scope="col">Outcome</th>${days.map(day => `<th scope="col">${esc(day.slice(5))}</th>`).join('')}</tr></thead>
        <tbody>${states.map(state => `<tr><th scope="row">${esc(state)}</th>${cells(state)}</tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">All</th>${days.map(day => `<td class="scope-total">${fmt(perDay.get(day) || 0)}</td>`).join('')}</tr></tfoot>
      </table>
    </div>
    <div class="scope-key">
      <span class="scope-key-label">Tasks decided, against the busiest cell (${fmt(busiest)})</span>
      <span class="scope-scale">${SCOPE_BANDS.map(b => `<i data-step="${b.step}"></i>`).join('')}</span>
      <span class="scope-key-ends"><b>few</b><b>many</b></span>
      <span class="scope-key-none"><i data-step="none"></i>none that day</span>
    </div>
    <figcaption>${fmt(result.rows.length)} tasks across ${fmt(days.length)} days, by the day the deciding run was ruled on</figcaption>`;

  setText('scopeCaveats',
    `${fmt(result.carriedOver)} were first decided before ${truth.cut} and settled after it, so they are carried over rather than new work. ` +
    `${fmt(result.inferredDates)} carry no decision timestamp and are placed by when their verdict was last updated - shown as approx, and near the boundary a few could sit on the wrong side of it.`);
}

function renderTruthFigures(result, filtered) {
  const cards = [
    ['Accepted', result.accepted, 'package at the current bar'],
    ['Legacy accepted', result.legacyAccepted, 'accepted, package not at the current bar'],
    ['Rejected', result.rejected, 'failed a QC decision'],
    ['No QC decision', result.undecided, 'parked, crashed or never decided'],
    ['Running', result.running, 'in a stage'],
    ['Carried over', result.carriedOver, 'first decided before 5 Sept'],
  ];
  byId('truthFigures').innerHTML = cards.map(([label, value, hint]) => `
    <button class="status-card figure-card" data-chain="${esc(label)}">
      <span class="status-card-label">${esc(label)}</span>
      <span class="status-card-value">${fmt(value)}</span>
      <span class="status-card-note">${esc(hint)}</span>
      <span class="status-card-cue">${filtered ? 'filtered' : 'how was this counted?'}</span>
    </button>`).join('');
}

function renderChain(label, filtered) {
  const chain = window.chainFor(truth, label, filtered);
  const panel = byId('truthChainPanel');
  if (!chain) { panel.hidden = true; return; }
  openChain = label;
  panel.hidden = false;
  setText('truthChainTitle', `${chain.label} = ${fmt(chain.value)}`);
  setText('truthChainNote', (chain.note || '') +
    (chain.stale ? ' This chain describes the unfiltered population; the cards above are showing your current filters.' : ''));
  byId('truthChain').innerHTML = chain.steps.map(step => `
    <li><span class="chain-count">${fmt(step.count)}</span>
      <span class="chain-step">${esc(step.step)}</span>
      <span class="chain-source">${esc(step.source || '')}</span></li>`).join('');
}

function renderTruthRows(rows) {
  const pages = Math.max(Math.ceil(rows.length / TRUTH_PAGE_SIZE), 1);
  truthPage = Math.min(truthPage, pages - 1);
  const slice = rows.slice(truthPage * TRUTH_PAGE_SIZE, (truthPage + 1) * TRUTH_PAGE_SIZE);
  byId('truthRows').innerHTML = slice.length ? slice.map((row, index) => {
    const id = `truth-${truthPage}-${index}`;
    return `<tr class="drill-head">
      <td><button class="drill-toggle" aria-expanded="false" aria-controls="${id}" aria-label="Evidence for ${esc(row.name)}">+</button></td>
      <td><div class="taskcell"><span class="taskname" title="${esc(row.name)}">${esc(row.name)}</span>${row.possibleDuplicate ? `<span class="chip ${row.duplicateTier === 'likely' ? 'chip-alert' : 'chip-warn'}" title="Same task name and trainer as ${fmt(row.duplicateSiblings)} other task${row.duplicateSiblings === 1 ? '' : 's'}${row.duplicateSameDay && row.duplicateSameState ? ', decided the same day with the same outcome' : ''}">${row.duplicateTier === 'likely' ? 'likely' : 'possible'} duplicate</span>` : row.unmerged ? '<span class="chip chip-warn" title="This submission carried no family id, so it is keyed on its own submission id. Repeat runs of the same task may be counted separately. No other task in scope shares its name and trainer.">unmerged</span>' : ''}${row.carriedOver ? `<span class="chip" title="First decided before ${esc(truth.cut)} and settled after it, so this is backlog cleared by the current pipeline rather than new work.">carried over</span>` : ''}</div></td>
      <td><span class="state state-${esc(row.state.replace(/\s+/g, '-'))}">${esc(row.state)}</span></td>
      <td>${esc(row.owner || 'Not recorded')}</td>
      <td>${esc(row.decided || '-')}${row.decidedInferred ? '<span class="chip chip-warn" title="No decision timestamp on the verdict; dated from when it was last updated">approx</span>' : ''}</td>
      <td>${esc(row.gateEra)}</td>
      <td class="num">${fmt(row.runs)}</td>
    </tr>
    <tr class="drill" id="${id}" hidden><td colspan="7">
      <dl class="evidence">
        <dt>Why this state</dt><dd>${esc(row.why)}</dd>
        <dt>Canonical run</dt><dd>${esc(row.canonicalReason)}${row.runs > 1 ? ` of ${fmt(row.runs)} runs` : ''}</dd>
        <dt>Identity</dt><dd>${row.unmerged ? 'Keyed on the submission id: no family id was present, so repeat runs may still be counted separately.' : 'Keyed by the pipeline family id.'}${row.possibleDuplicate ? ` Shares its task name and trainer with ${fmt(row.duplicateSiblings)} other task${row.duplicateSiblings === 1 ? '' : 's'} in scope${row.duplicateSameDay && row.duplicateSameState ? ', decided the same day with the same outcome' : ''} - so this is very likely one task counted more than once. Flagged rather than merged, because a task name can legitimately cover unrelated work.` : ''}</dd>
        <dt>Delivered</dt><dd>${(row.cohorts || []).length ? esc(row.cohorts.join(', ')) : 'No package in any accepted folder'}</dd>
        <dt>Findings</dt><dd>${(row.findings || []).length
          ? esc(row.findings.join(', ')) + ' <span class="muted">on this run</span>'
          : 'None on this run'}${(row.findingsPrior || []).length
          ? ` &middot; ${esc(row.findingsPrior.join(', '))} <span class="muted">on an earlier run of the same task</span>`
          : ''}</dd>
        <dt>Read from</dt><dd><code>${esc(row.source)}</code></dd>
      </dl>
    </td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">No tasks match these filters.</td></tr>';
  setText('truthPage', `Page ${truthPage + 1} of ${pages} / ${fmt(rows.length)} tasks`);
  byId('truthPrev').disabled = truthPage === 0;
  byId('truthNext').disabled = truthPage >= pages - 1;
}

function renderTruth() {
  if (!truth) return;
  const filters = truthFilters();
  const filtered = Object.entries(filters).some(([, v]) => v);
  const result = window.filterTruth(truth.rows, filters);
  renderTruthFigures(result, filtered);
  renderScope(result);
  if (openChain) renderChain(openChain, filtered);
  setText('truthStatus', `Derived from ${truth.bucket} at ${new Date(truth.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})} / ` +
    `${fmt(truth.rows.length)} tasks decided on or after ${truth.cut}. The Harbor Console is not read.`);
  setText('truthCaveats', `${fmt(result.unmerged)} of ${fmt(result.rows.length)} shown are unmerged, so repeat runs of them may still count separately. ` +
    `${fmt(result.inferredDates)} carry no decision timestamp and are dated from when the verdict was last updated.`);
  setText('truthAudit', `${fmt(result.rows.length)} of ${fmt(truth.rows.length)} tasks shown / ` +
    `${fmt(result.atCurrentBar)} have a package at the current bar / ${fmt(result.gateOnly)} await a KESTREL re-gate / ` +
    `${fmt(result.owners)} trainers.`);
  renderTruthRows(result.rows);
}

function renderCarried() {
  if (!truth) return;
  const rows = truth.rows.filter(row => row.carriedOver);
  const filters = {
    state: byId('cState').value, owner: byId('cOwner').value,
    search: byId('cSearch').value, carriedOver: 'yes',
  };
  const result = window.filterTruth(truth.rows, filters);
  const settled = result.rows.filter(row => row.state === 'accepted' || row.state === 'legacy accepted');
  byId('carriedFigures').innerHTML = [
    ['Carried over', rows.length, 'first decided before 5 Sept, settled after'],
    ['Now accepted', rows.filter(r => r.state === 'accepted').length, 'package at the current bar'],
    ['Legacy accepted', rows.filter(r => r.state === 'legacy accepted').length, 'accepted, not at the current bar'],
    ['Still unresolved', rows.filter(r => !['accepted', 'legacy accepted', 'rejected'].includes(r.state)).length, 'no decision yet'],
  ].map(([label, value, hint]) => `
    <div class="status-card">
      <span class="status-card-label">${esc(label)}</span>
      <span class="status-card-value">${fmt(value)}</span>
      <span class="status-card-note">${esc(hint)}</span>
    </div>`).join('');
  setText('carriedStatus', `${fmt(rows.length)} tasks of the ${fmt(truth.rows.length)} in scope were first decided before ${truth.cut}. ` +
    'They are included in the Pipeline figures, not added to them.');
  setText('carriedAudit', `${fmt(result.rows.length)} shown / ${fmt(settled.length)} reached an acceptance.`);
  byId('carriedRows').innerHTML = result.rows.length ? result.rows.map(row => `
    <tr>
      <td><span class="taskname">${esc(row.name)}</span></td>
      <td><span class="state state-${esc(row.state.replace(/\s+/g, '-'))}">${esc(row.state)}</span></td>
      <td>${esc(row.owner || 'Not recorded')}</td>
      <td>${esc(row.decided || '-')}</td>
      <td>${esc(row.gateEra)}</td>
      <td class="num">${fmt(row.runs)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No carried-over tasks match these filters.</td></tr>';
}

async function loadGcsPipeline(manual = false) {
  try {
    const response = await fetch(`assets/gcs-pipeline.json?refresh=${manual ? Date.now() : 'startup'}`, {cache:'no-store'});
    if (!response.ok) throw new Error('GCS export unavailable');
    const payload = await response.json();
    if (payload.schemaVersion !== 3 || !['current','historical','legacy'].every(key=>Array.isArray(payload[key])) || !Array.isArray(payload.finalisation?.tasks)) throw new Error('Invalid GCS export');
    ['current', 'historical', 'legacy'].forEach(key => payload[key].forEach(task => { task.domain = pipelineDomain(task); }));
    gcsPipeline = payload;
      loadFinalisation(); buildPipeline(); populateFilters(); renderPipeline(); renderDonut(); renderTrainerRows();
    renderSources(); renderHero(); renderTopPendingCards(); renderBenchCards();
    if (manual) setTextIfPresent('pipelineSourceStatus', `Latest published GCS export loaded: ${gcsPipeline.generatedAt}`);
  } catch {
    setTextIfPresent('pipelineSourceStatus', 'GCS export unavailable. Pipeline counts are not loaded.');
  }
}

setInterval(async () => {
  if (document.hidden || !gcsPipeline) return;
  try {
    const response = await fetch(`assets/pipeline-version.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!response.ok) return;
    const version = await response.json();
    if (version.generatedAt !== gcsPipeline.generatedAt) await loadGcsPipeline(true);
  } catch { /* The current snapshot remains available during a network failure. */ }
}, 60000);
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const byId = (id) => document.getElementById(id);
const fmt = (value) => number.format(Math.round(Number(value) || 0));
const money = (value) => currency.format(Math.round(Number(value) || 0));
const safePct = (value, max) => `${Math.max(0, Math.min(100, Math.round(((Number(value) || 0) / (max || 1)) * 100)))}%`;

function setTextIfPresent(id, value) {
  // The console-era Pipeline nodes are gone; loaders that still report status
  // must not throw when their target no longer exists.
  const node = byId(id);
  if (node) node.textContent = value;
}

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function groupBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item) || "Unassigned";
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

// Must match the nav and the .view sections in index.html. switchView returns
// early on anything not listed here, so a tab missing from this list renders
// its data but can never be opened.
const VIEWS = ['command', 'payouts', 'delivery', 'pipeline', 'carried', 'explorer'];
// The same status is the same colour in the donut, the cards and the table.
// PRD F3: the Harbor Console vocabulary. `Done` is gone.
const STATUS_TOKENS = {
  Accepted: '--aqua', Submitted: '--blue', Rejected: '--yellow',
  Failed: '--orange', 'Conflicting verdict': '--magenta',
  Running: '--violet', Queued: '--magenta', Cancelled: '--slate',
};
function statusColor(status) {
  const token = STATUS_TOKENS[status] || '--slate';
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || '#7c8798';
}

function switchView(viewName, push = true) {
  if (!VIEWS.includes(viewName)) return;
  document.querySelectorAll('.viewnav-tab').forEach(button => {
    const active = button.dataset.view === viewName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('is-active', view.id === `view-${viewName}`));
  if (viewName === 'explorer') loadExplorer();
  if (byId('globalSearch')) syncSearch(viewName);
  if (push && location.hash.slice(1) !== viewName) history.pushState({viewName}, '', `#${viewName}`);
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function commandSnapshot() {
  const folders = finalisationRows.filter(row => inRange(row.date));
  // One task can be finalised into several cohorts; the accepted count is task names, not folders.
  const tasks = new Set(folders.map(row => row.name));
  return {
    ready: Boolean(finalisationRows.length && gcsPipeline),
    folders,
    tasks,
    current: (gcsPipeline?.current || []).filter(row => inRange(row.date)),
    duplicates: folders.length - tasks.size,
    unassigned: folders.filter(row => !row.trainer).length,
  };
}

function renderHero() {
  const snapshot = commandSnapshot();
  const rows = payoutRows();
  const summary = {paidAmount:sum(rows,'paidAmount'),pendingAmount:sum(rows,'pendingAmount'),pendingTasks:sum(rows,'pendingTasks'),acceptedTasks:sum(rows,'acceptedTasks'),activeTrainers:rows.filter(r=>r.status.toLowerCase()==='active').length,totalTrainers:rows.length};
  const generated = new Date(data.meta.generatedAt);
  const paid = summary.paidAmount;
  const pending = summary.pendingAmount;
  const totalExposure = paid + pending;
  const paidPct = Math.round((paid / (totalExposure || 1)) * 100);

  setText("generatedAt", generated.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  setText('scanAt', gcsPipeline ? new Date(gcsPipeline.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : 'not loaded');
  setText("heroPending", money(pending));
  setText("heroExposureText", `${paidPct}% paid / ${fmt(summary.pendingTasks)} tasks pending`);
  renderExposureChart(rows);

  const dated = Boolean(dateRange.start || dateRange.end);
  setText("metricAccepted", snapshot.ready ? fmt(snapshot.tasks.size) : '-');
  // The iteration-2 count is rebuilt from the folder rows so it follows the date
  // range, rather than reading the cohort's static all-time total.
  const v2Folders = snapshot.folders.filter(row => row.cohort === 'finalisation_client_qc_accepted_iteration_2');
  const v2 = snapshot.ready ? {tasks: v2Folders.length} : null;
  setText('metricClientAccepted', clientAcceptance ? fmt(clientAcceptance.accepted) : '-');
  setText('metricClientAcceptedNote', clientAcceptance
    ? `Priority Low of ${fmt(clientAcceptance.tasks)} audited tasks${clientAcceptance.live ? '' : ' / saved snapshot'}${dated ? ' / all dates: the 240 dashboard snapshot carries counts only' : ''}`
    : 'Harbor 240 dashboard unavailable');
  setText('metricV2Accepted', v2 ? fmt(v2.tasks) : '-');
  setText('metricV2AcceptedNote', v2
    ? `Folders in the client QC accepted iteration 2 cohort${dated ? ` / ${rangeLabel()}` : ''}`
    : 'Bucket scan not loaded');
  setText("metricPaid", money(paid));
  setText("metricPendingTasks", fmt(summary.pendingTasks));
  setText("metricPending", `${money(pending)} pending`);
  setText("metricActive", fmt(summary.activeTrainers));
  setText("metricRoster", `${fmt(summary.totalTrainers)} total trainer records`);
  setText('commandSourceStatus', `One read-only GCS scan: ${gcsPipeline?.generatedAt || 'unavailable / loading'} | ${gcsPipeline ? `${fmt(gcsPipeline.current.length)} current evaluations, ${fmt(finalisationRows.length)} accepted finalisation folders` : 'waiting for the export'}`);
  byId('commandSummary').innerHTML = [
    ['Current evaluated tasks', gcsPipeline ? snapshot.current.length : null],
    ['Pipeline accepted', gcsPipeline ? snapshot.current.filter(row => row.status === 'Accepted').length : null],
    ['Accepted finalisation folders', finalisationRows.length ? snapshot.folders.length : null],
    ['Cross-cohort repeats excluded', snapshot.ready ? snapshot.duplicates : null]
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value == null ? '-' : fmt(value)}</strong></div>`).join('');
  setText('commandOwnership', snapshot.ready ? `${fmt(snapshot.unassigned)} accepted folders without a roster-linked owner; excluded from financial estimates. Payout totals come from the workbook ledger, not from this count.` : 'Accepted reconciliation requires the GCS export.');
  if (!snapshot.ready) {
    ['heroPending', 'metricPendingTasks', 'metricPending'].forEach(id => setText(id, '-'));
    setText('heroExposureText', 'Waiting for both accepted sources');
  }
}

function segment(tone, value, scale, tip) {
  if (!value) return '';
  // Label inside the bar only where it fits; the tooltip and the line beneath
  // carry the number for the slivers.
  const label = value / scale >= 0.13 ? `<i>${money(value)}</i>` : '';
  return `<span class="seg ${tone}" style="flex:${value}" data-tip="${esc(tip)}">${label}</span>`;
}

function sourceState(source) {
  // What the page can actually say about this source right now, not what we
  // hope it is doing.
  if (source.id === 'gcs-evaluations' || source.id === 'gcs-finalisation') {
    return gcsPipeline
      ? {tone: 'ok', label: 'Loaded', detail: `Bucket scan ${new Date(gcsPipeline.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}`}
      : {tone: 'warn', label: 'Not loaded', detail: 'The GCS export did not load in this visit.'};
  }
  if (source.id === 'ops-workbook') {
    return {tone: 'snapshot', label: 'Snapshot', detail: `Workbook exported ${new Date(data.meta.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}`};
  }
  if (source.id === 'ppt-workbook') {
    return payoutLedger
      ? {tone: 'snapshot', label: 'Snapshot', detail: `Ledger built ${new Date(payoutLedger.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}`}
      : {tone: 'warn', label: 'Not loaded', detail: 'The payout ledger did not load in this visit.'};
  }
  if (source.id === 'harbor-240') {
    if (!clientAcceptance) return {tone: 'warn', label: 'Not loaded', detail: 'The 240 dashboard could not be read and no snapshot was available.'};
    return clientAcceptance.live
      ? {tone: 'ok', label: 'Live', detail: `Read during this visit / ${fmt(clientAcceptance.accepted)} accepted of ${fmt(clientAcceptance.tasks)}`}
      : {tone: 'snapshot', label: 'Snapshot', detail: 'The live dashboard was unreachable; the committed counts are shown.'};
  }
  if (source.id === 'postgres') return {tone: 'pending', label: 'Not connected', detail: 'PRD C3 - no host or credentials issued.'};
  if (source.id === 'harbor-console') return {tone: 'pending', label: 'Reference only', detail: 'PRD F2 - finalisation numbers are held until this reconciliation is done.'};
  return {tone: 'ok', label: 'Reference', detail: 'Linked for comparison; not read for any figure here.'};
}

// A workbook is a stack of tabs, and only some of them feed this page. Deep-link
// each one at the gid it actually lives at, and say which feed it serves - so
// "where does this number come from" lands on the tab, not just the document.
function sourceTabs(source) {
  const tabs = source.tabs || [];
  if (!tabs.length || !source.href) return '';
  const used = tabs.filter(tab => tab.feeds !== 'Not read by this page');
  const unused = tabs.length - used.length;
  const link = tab => `<a class="tab-chip" target="_blank" rel="noopener"
      href="${esc(source.href)}?gid=${esc(tab.gid)}#gid=${esc(tab.gid)}"
      data-tip="${esc(tab.feeds)}">${esc(tab.name)}</a>`;
  return `<div class="source-tabs">
    <span class="source-tabs-label">Tabs this page reads</span>
    ${used.map(link).join('')}
    ${unused ? `<span class="tab-chip is-flat" data-tip="Present in the workbook but not read by this dashboard">+${unused} not read</span>` : ''}
    ${source.export ? `<span class="tab-chip is-flat" data-tip="The export the build actually parses">via ${esc(source.export)}</span>` : ''}
  </div>`;
}

function renderSources() {
  const list = byId('sourceList');
  if (list) {
    list.innerHTML = window.DASHBOARD_SOURCES.map(source => {
      const state = sourceState(source);
      const title = source.href
        ? `<a href="${esc(source.href)}" target="_blank" rel="noopener">${esc(source.name)}</a>`
        : esc(source.name);
      return `<article class="source-card" data-tone="${state.tone}">
        <header>
          <div><span class="source-kind">${esc(source.kind)}</span><h3>${title}</h3></div>
          <span class="pill" data-tone="${state.tone}">${esc(state.label)}</span>
        </header>
        <p class="source-loc">${esc(source.location)}${source.liveTitle ? ` <span class="source-alias">opens as &ldquo;${esc(source.liveTitle)}&rdquo;</span>` : ''}</p>
        <dl class="source-detail">
          <dt>What</dt><dd>${esc(source.what)}</dd>
          <dt>Why</dt><dd>${esc(source.why)}</dd>
          <dt>How</dt><dd>${esc(source.how)}</dd>
        </dl>
        ${sourceTabs(source)}
        <p class="source-state">${esc(state.detail)}${source.hrefNote ? ` / ${esc(source.hrefNote)}` : ''}</p>
      </article>`;
    }).join('');
  }
  document.querySelectorAll('.sourcestrip').forEach(strip => {
    strip.innerHTML = '<span class="sourcestrip-label">Reading from</span>' +
      window.sourcesFor(strip.dataset.sources).map(source => {
        const state = sourceState(source);
        const body = `<span class="source-kind">${esc(source.kind)}</span>${esc(source.name)}<span class="chip-state" data-tone="${state.tone}">${esc(state.label)}</span>`;
        return source.href
          ? `<a class="source-chip" href="${esc(source.href)}" target="_blank" rel="noopener" data-tip="${esc(source.what)} / ${esc(state.detail)}">${body}</a>`
          : `<span class="source-chip is-flat" data-tip="${esc(source.hrefNote || source.what)}">${body}</span>`;
      }).join('') +
      `<button class="ghost source-more" data-jump="command">All sources</button>`;
  });
}

function renderExposureChart(rows) {
  // Composition, not trend: where the money already spent and the money still
  // owed sit across the two benches. One scale for both bars so the lengths
  // compare; each bench bar is drawn against the largest bench total.
  const benches = [['Company', 'company'], ['Computer', 'computer'], ['Unassigned', 'unassigned']]
    .map(([label, key]) => {
      const members = rows.filter(row => benchOf(row.team) === key);
      return {label, paid: sum(members, 'paidAmount'), pending: sum(members, 'pendingAmount'),
              paidTasks: sum(members, 'paidTasks'), pendingTasks: sum(members, 'pendingTasks')};
    })
    .filter(bench => bench.paid || bench.pending);
  const scale = Math.max(...benches.map(bench => bench.paid + bench.pending), 1);
  const total = benches.reduce((value, bench) => value + bench.paid + bench.pending, 0);
  byId('exposureChart').innerHTML = benches.length ? `
    <figcaption>${money(total)} committed, by bench</figcaption>
    ${benches.map(bench => {
      const benchTotal = bench.paid + bench.pending;
      return `<div class="bench-bar">
        <div class="bench-bar-head"><span>${esc(bench.label)}</span><b>${money(benchTotal)}</b></div>
        <div class="stack" style="width:${Math.max((benchTotal / scale) * 100, 2)}%">
          ${segment('is-paid', bench.paid, scale, `${bench.label} bench: ${money(bench.paid)} paid across ${fmt(bench.paidTasks)} tasks`)}
          ${segment('is-pending', bench.pending, scale, `${bench.label} bench: ${money(bench.pending)} outstanding across ${fmt(bench.pendingTasks)} tasks`)}
        </div>
        <div class="bench-bar-foot">${fmt(bench.paidTasks)} paid / ${fmt(bench.pendingTasks)} outstanding tasks</div>
      </div>`;
    }).join('')}
    <div class="chart-key">
      <span class="key-item is-paid">Paid</span>
      <span class="key-item is-pending">Outstanding</span>
    </div>` : '<p class="empty">No payout exposure in this selection.</p>';
}

function renderTopPendingCards() {
  if (!finalisationRows.length || !gcsPipeline) {
    byId('topPendingCards').innerHTML = '<p class="empty">Pending estimates require Pipeline and Finalisation data.</p>';
    return;
  }
  const rows = payoutRows()
    .filter((row) => row.pendingTasks > 0)
    .sort((a, b) => b.pendingAmount - a.pendingAmount || b.acceptedTasks - a.acceptedTasks)
    .slice(0, 8);
  const max = Math.max(...rows.map((row) => row.pendingAmount), 1);

  byId("topPendingCards").innerHTML = rows
    .map(
      (row, index) => `
        <div class="leader-row">
          <div class="rank">${index + 1}</div>
          <div class="person">
            <strong>${row.name || "Unknown"}</strong>
            <span>${row.email}</span>
          </div>
          <div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${safePct(row.pendingAmount, max)}"></div>
            </div>
            <span class="muted">${fmt(row.pendingTasks)} pending of ${fmt(row.acceptedTasks)} accepted</span>
          </div>
          <div class="amount">${money(row.pendingAmount)}</div>
        </div>
      `,
    )
    .join("") || '<p class="empty">No pending payouts in this selection.</p>';
}

function renderDonut() {
  if (!gcsPipeline) {
    byId('pipelineDonut').innerHTML = '<p class="empty">Current pipeline data unavailable / loading.</p>';
    return;
  }
  const entries = Object.entries(groupBy(commandSnapshot().current, row => row.status)).map(([key,rows])=>[key,rows.length]).sort((a,b)=>b[1]-a[1]);
  const total = entries.reduce((sumValue, [, value]) => sumValue + value, 0);
  const colors = entries.map(([status]) => statusColor(status));
  let start = 0;
  const stops = entries.map(([, value], index) => {
    const degrees = (value / total) * 360;
    const segment = `${colors[index % colors.length]} ${start}deg ${start + degrees}deg`;
    start += degrees;
    return segment;
  });

  byId("pipelineDonut").innerHTML = `
    <div class="donut" style="background: ${total ? `conic-gradient(${stops.join(', ')})` : '#e5e5ea'}">
      <div class="donut-label">
        <strong>${fmt(total)}</strong>
        <span class="muted">records tracked</span>
      </div>
    </div><div class="chart-legend">${entries.map(([label,count],i)=>`<div><span class="legend-dot" style="background:${colors[i%colors.length]}"></span><span>${esc(label)}</span><b>${fmt(count)}</b></div>`).join('')}</div>
  `;
}

function renderBenchCards() {
  const snapshot = commandSnapshot();
  const roster = new Map(data.trainers.map(row => [row.email.toLowerCase(), row]));
  const bench = email => {
    const team = roster.get(String(email || '').toLowerCase())?.team;
    return team === 'Company' ? 'Company' : ['Computer A', 'Computer B'].includes(team) ? 'Computer' : 'Unassigned';
  };
  byId('benchCards').innerHTML = ['Computer', 'Company', 'Unassigned'].map(name => {
    const tasks = snapshot.current.filter(row => bench(row.trainer) === name);
    const groups = [...new Set(snapshot.folders.filter(row => bench(row.trainer?.email) === name).map(row => row.name))];
    return `<div class="bench-card"><h3>${name} bench</h3>${[
      ['Current tasks', gcsPipeline ? tasks.length : null],
      ['Pipeline accepted', gcsPipeline ? tasks.filter(row => row.status === 'Accepted').length : null],
      ['Unique accepted tasks', snapshot.ready ? groups.length : null]
    ].map(([label, value]) => `<div class="bench-metric"><span>${label}</span><b>${value == null ? '-' : fmt(value)}</b></div>`).join('')}</div>`;
  }).join('');
}

function uniqueTeams() {
  return [...new Set(data.trainers.map((trainer) => trainer.team || "Unassigned"))].sort();
}

function populateTrainerPicker() {
  // Only people the payout data actually knows about; the roster has 597 rows.
  const active = payoutRows().filter(row => row.acceptedTasks || row.paidTasks)
    .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  const select = byId('trainerFilter'), selected = select.value;
  select.innerHTML = '<option value="">All trainers</option>' + active.map(row =>
    `<option value="${esc(row.email.toLowerCase())}">${esc(row.name || row.email)} — ${fmt(row.acceptedTasks)} accepted, ${fmt(row.paidTasks)} paid</option>`).join('');
  select.value = active.some(row => row.email.toLowerCase() === selected) ? selected : '';
}

function filteredTrainers() {
  const search = byId("personSearch").value.trim().toLowerCase();
  const payment = byId('paymentFilter').value;
  const bench = byId('benchFilter').value;
  const picked = byId('trainerFilter').value;
  return payoutRows()
    .filter(row => !picked || row.email.toLowerCase() === picked)
    .filter(row => !bench || benchOf(row.team) === bench)
    .filter(row => !payment || (payment === 'pending' ? row.pendingTasks > 0 : payment === 'paid' ? row.paidTasks > 0 : payment === 'no-paid' ? row.paidTasks === 0 : row.acceptedTasks === 0))
    .filter((trainer) => {
      if (!search) return true;
      return [trainer.name, trainer.email, trainer.team, trainer.managerName, trainer.em]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((a, b) => b.pendingAmount - a.pendingAmount || b.acceptedTasks - a.acceptedTasks);
}

function ledgerAcceptedByEmail() {
  // The 240 dashboard acceptance layer is the payout source of truth; one row per collapsed ledger task.
  const accepted = new Map();
  payoutLedgerTasks.filter(task => task.payable).forEach(task => accepted.set(task.email, (accepted.get(task.email) || 0) + 1));
  return accepted;
}

function inRange(value) {
  if (!dateRange.start && !dateRange.end) return true;
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return (!dateRange.start || date >= dateRange.start) && (!dateRange.end || date <= dateRange.end);
}

function rangeLabel() {
  if (!dateRange.start && !dateRange.end) return 'All dates';
  if (dateRange.start && dateRange.end) return `${dateRange.start} to ${dateRange.end}`;
  return dateRange.start ? `From ${dateRange.start}` : `Up to ${dateRange.end}`;
}

function applyRange() {
  const invalid = Boolean(dateRange.start && dateRange.end && dateRange.start > dateRange.end);
  byId('dateError').hidden = !invalid;
  ['dateStart', 'dateEnd'].forEach(id => byId(id).setAttribute('aria-invalid', String(invalid)));
  setText('dateScope', invalid ? 'No records match: the start date is after the end date.'
    : `${rangeLabel()} / Overview, Delivery and Pipeline follow this range. Payouts does not.`);
  document.querySelectorAll('.rangeecho').forEach(node => {
    node.innerHTML = `<span class="rangeecho-label">Date range</span>${esc(rangeLabel())}` +
      ((dateRange.start || dateRange.end) ? ' <button class="linky" data-jump="command">change</button>' : '');
  });
  renderEverything();
}

function benchOf(team) {
  return team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(team) ? 'computer' : 'unassigned';
}

function payoutRows() {
  const acceptedByEmail = payoutLedger ? ledgerAcceptedByEmail() : new Map();
  const paidByEmail = new Map((data.paidOut || []).map(row => [String(row.email || '').toLowerCase(), row]));
  return data.trainers.map(row => {
    const paid = paidByEmail.get(row.email.toLowerCase());
    const acceptedTasks = payoutLedger ? (acceptedByEmail.get(row.email.toLowerCase()) || 0) : row.acceptedTasks;
    const paidTasks = Number(paid?.approvedTasks) || 0;
    const paidAmount = paid?.paidAmount == null ? paidTasks * 300 : Number(paid.paidAmount);
    const pendingTasks = Math.max(acceptedTasks - paidTasks, 0);
    return {...row, acceptedTasks, paidTasks, paidAmount, pendingTasks, pendingAmount: pendingTasks * 300};
  });
}

function renderPayoutSummary(rows) {
  const paid = sum(rows, "paidAmount");
  const pending = sum(rows, "pendingAmount");
  byId("payoutSummary").innerHTML = [
    ["People shown", fmt(rows.length)],
    ["Accepted tasks", fmt(sum(rows, "acceptedTasks"))],
    ["Paid tasks", fmt(sum(rows, "paidTasks"))],
    ["Paid amount", money(paid)],
    ["Pending amount", money(pending)],
  ]
    .map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
  if (payoutLedger) {
    const totals = payoutLedger.totals;
    setText('payoutSourceStatus', `Accepted: ${fmt(totals.acceptedTasks)} tasks from the task wise tab across ${fmt(totals.ledgerTasks)} unique tasks / ${fmt(totals.duplicateRows)} duplicate rows excluded, ${fmt(totals.invalidTasks)} rows flagged Valid = 0 still counted / Paid: ${fmt(totals.paidTasks)} tasks (${money(totals.paidAmount)}) across ${fmt(totals.paymentRequests)} payment requests, ${fmt(totals.unitemisedPaidTasks)} of them (${money(totals.unitemisedPaidAmount)}) paid beyond the tasks listed for that person / Pending: ${fmt(totals.pendingTasks)} tasks (${money(totals.pendingAmount)})`);
    return;
  }
  setText('payoutSourceStatus', 'Payout ledger unavailable. Accepted tasks fall back to the workbook snapshot.');
}

function renderTrainerRows() {
  const rows = filteredTrainers();
  renderPayoutSummary(rows);
  renderPayoutLedger();
  const pages = Math.max(1, Math.ceil(rows.length / PAYOUT_PAGE_SIZE));
  payoutPage = Math.min(Math.max(payoutPage, 0), pages - 1);
  const from = payoutPage * PAYOUT_PAGE_SIZE;
  const page = rows.slice(from, from + PAYOUT_PAGE_SIZE);
  setText('payoutPage', rows.length
    ? `${fmt(from + 1)}-${fmt(from + page.length)} of ${fmt(rows.length)} ${rows.length === 1 ? 'person' : 'people'} / page ${fmt(payoutPage + 1)} of ${fmt(pages)}`
    : 'No people match these filters');
  byId('payoutPrevious').disabled = payoutPage === 0;
  byId('payoutNext').disabled = payoutPage >= pages - 1;
  byId("trainerRows").innerHTML = page
    .map(
      (row) => `
        <tr>
          <td>
            <div class="person">
              <strong>${row.name || "Unknown"}</strong>
              <span>${row.email}</span>
            </div>
          </td>
          <td>${row.team || "Unassigned"}</td>
          <td>${row.managerName || row.em || "-"}</td>
          <td class="num">${fmt(row.acceptedTasks)}</td>
          <td class="num">${fmt(row.paidTasks)}</td>
          <td class="num">${money(row.paidAmount)}</td>
          <td class="num">${fmt(row.pendingTasks)}</td>
          <td class="num ${row.pendingAmount ? "negative" : ""}">${money(row.pendingAmount)}</td>
          <td class="num">${fmt(row.last24Accepted)}</td>
        </tr>
      `,
    )
    .join("") || '<tr><td colspan="9" class="empty">No trainers match these filters.</td></tr>';
}

function renderTeams() {
  const teams = Object.entries(groupBy(data.trainers, (trainer) => trainer.team)).sort(
    (a, b) => sum(b[1], "acceptedTasks") - sum(a[1], "acceptedTasks"),
  );
  byId("teamGrid").innerHTML = teams
    .map(([team, rows]) => {
      const managerCount = new Set(rows.map((row) => row.managerName).filter(Boolean)).size;
      return `
        <article class="team-card">
          <h3>${team}</h3>
          <strong class="hero-number">${fmt(sum(rows, "acceptedTasks"))}</strong>
          <div class="team-line"><span>Trainers</span><b>${fmt(rows.length)}</b></div>
          <div class="team-line"><span>Managers</span><b>${fmt(managerCount)}</b></div>
          <div class="team-line"><span>Paid</span><b>${money(sum(rows, "paidAmount"))}</b></div>
          <div class="team-line"><span>Pending</span><b>${money(sum(rows, "pendingAmount"))}</b></div>
        </article>
      `;
    })
    .join("");
}


// The Harbor Console's own counters count individual submissions; this page
// counts tasks, at their latest submission. Both are correct and they differ by
// the re-submissions, so show the arithmetic rather than leave people to find it.
function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function renderExplorerCrumbs() {
  const parts = explorer ? explorer.crumbs(explorerPath) : [];
  byId('explorerCrumbs').innerHTML =
    `<button class="crumb" data-path="">gs://obi-harbor-pipeline</button>` +
    parts.map(part => `<span class="crumb-sep">/</span><button class="crumb" data-path="${esc(part.path)}">${esc(part.name)}</button>`).join('');
}

function renderExplorerBody() {
  const dirs = byId('explorerDirs');
  const files = byId('explorerFiles');
  if (!explorerEntry) {
    dirs.innerHTML = '';
    files.innerHTML = '<tr><td colspan="3" class="empty">Nothing loaded.</td></tr>';
    return;
  }
  if (explorerEntry.missing) {
    dirs.innerHTML = '';
    files.innerHTML = `<tr><td colspan="3" class="empty">${explorerEntry.inScope
      ? 'This folder is in scope but not in the current index - it may have been pruned since the last walk.'
      : 'Outside the indexed scope. Only the finalisation cohorts and trainer records are mirrored.'}</td></tr>`;
    return;
  }
  dirs.innerHTML = explorerEntry.dirs.length
    ? explorerEntry.dirs.map(dir => `<li><button class="explorer-dir" data-path="${esc(dir.path)}">${esc(dir.name)}</button></li>`).join('')
    : '<li class="empty">No subfolders</li>';

  const needle = byId('explorerFilter').value.trim().toLowerCase();
  const sort = byId('explorerSort').value;
  let rows = explorerEntry.files.filter(file => !needle || file.name.toLowerCase().includes(needle));
  rows = rows.slice().sort((a, b) => sort === 'size' ? b.size - a.size
    : sort === 'updated' ? String(b.updated).localeCompare(String(a.updated))
    : a.name.localeCompare(b.name));

  files.innerHTML = rows.length
    ? rows.map(file => `<tr><td class="mono">${esc(file.name)}</td><td class="num">${bytes(file.size)}</td><td>${esc(String(file.updated).replace('T', ' ').replace(/\..*$/, ''))}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty">${explorerEntry.files.length ? 'No file matches that filter.' : 'No files directly in this folder.'}</td></tr>`;

  setText('explorerFoot', `${fmt(explorerEntry.dirs.length)} folder${explorerEntry.dirs.length === 1 ? '' : 's'} / ` +
    `${fmt(rows.length)} of ${fmt(explorerEntry.files.length)} file${explorerEntry.files.length === 1 ? '' : 's'} shown / ` +
    `${bytes(explorerEntry.bytes)} in this folder. Sizes and dates come from the object metadata; contents are never read.`);
}

async function openExplorer(path) {
  if (!explorer) return;
  try {
    explorerPath = String(path || '');
    explorerEntry = await explorer.open(explorerPath);
    renderExplorerCrumbs();
    renderExplorerBody();
  } catch (error) {
    setText('explorerStatus', `Could not open that folder: ${error.message}`);
  }
}

async function loadExplorer(force = false) {
  if (explorer && !force) return;
  explorer = window.createExplorer({base: 'gcs-index'});
  try {
    const meta = await explorer.load();
    const walked = meta.walkSeconds ? `${Math.round(meta.walkSeconds / 60)} min walk` : '';
    setText('explorerStatus', `Indexed ${fmt(meta.objects)} objects in ${fmt(meta.folders)} folders / ` +
      `${bytes(meta.bytes)} stored / index built ${new Date(meta.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}${walked ? ` / ${walked}` : ''}`);
    setText('explorerScopeNote', `Scope: ${meta.scope.length} prefixes - the finalisation cohorts and trainer records. ` +
      'The rest of the bucket is not mirrored; it is far too large for a static index.');
    await openExplorer('');
    renderSources();
  } catch (error) {
    setText('explorerStatus', `The bucket index is not published yet (${error.message}). ` +
      'Run tools/index_bucket.py on the Harbor VM and publish gcs-index/.');
    setText('explorerScopeNote', 'No index available.');
  }
}

// Attainment against the daily commitment. A sequential ramp, because the value
// is a magnitude; a day with no commitment is not 0% and gets its own neutral.
const ATTAINMENT_BANDS = [
  {limit: 0.25, step: 1, label: 'under 25%'},
  {limit: 0.5, step: 2, label: '25 to 50%'},
  {limit: 0.75, step: 3, label: '50 to 75%'},
  {limit: 1, step: 4, label: '75 to 100%'},
  {limit: Infinity, step: 5, label: 'at or above plan'},
];

function renderPlan() {
  const benches = data.plan || [];
  const dates = benches[0]?.dates || [];
  if (!benches.length || !dates.length || !dates.some((day) => inRange(day))) {
    byId('planCharts').innerHTML = `<p class="empty">No daily plan ${dates.length ? 'falls inside this date range' : 'recorded in the workbook'}.</p>`;
    return;
  }
  const within = (benches[0]?.dates || []).map(day => inRange(day));
  const cells = bench => bench.dates.map((day, index) => {
    if (!within[index]) return '';
    const plan = Number(bench.plan[index]) || 0;
    const actual = Number(bench.actual[index]) || 0;
    if (!plan) {
      return `<td class="heat-cell" data-step="none" data-tip="${esc(bench.bench)} ${esc(day)}: no commitment set"><span>-</span></td>`;
    }
    const share = actual / plan;
    const band = ATTAINMENT_BANDS.find(entry => share < entry.limit) || ATTAINMENT_BANDS.at(-1);
    return `<td class="heat-cell" data-step="${band.step}" data-tip="${esc(bench.bench)} ${esc(day)}: ${fmt(actual)} of ${fmt(plan)} tasks, ${Math.round(share * 100)}% of plan">
      <span>${Math.round(share * 100)}%</span><small>${fmt(actual)}/${fmt(plan)}</small></td>`;
  }).join('');
  byId('planCharts').innerHTML = `
    <div class="heatmap-wrap">
      <table class="heatmap">
        <thead><tr><th scope="col">Bench</th>${dates.filter((day, index) => within[index]).map(day => `<th scope="col">${esc(day.slice(5))}</th>`).join('')}</tr></thead>
        <tbody>${benches.map(bench => `<tr><th scope="row">${esc(bench.bench)}</th>${cells(bench)}</tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="heat-key">
      <span class="heat-key-label">Share of the day's commitment delivered</span>
      <span class="heat-scale">
        ${ATTAINMENT_BANDS.map(band => `<i data-step="${band.step}" title="${band.label}"></i>`).join('')}
      </span>
      <span class="heat-key-ends"><b>0%</b><b>100%+</b></span>
      <span class="heat-key-none"><i data-step="none"></i>No commitment set</span>
    </div>
    <p class="muted footnote">${benches.map(bench => {
      const planned = bench.plan.reduce((total, value, index) => total + (within[index] ? Number(value) || 0 : 0), 0);
      const done = bench.actual.reduce((total, value, index) => total + (within[index] ? Number(value) || 0 : 0), 0);
      return `${esc(bench.bench)}: ${fmt(done)} of ${fmt(planned)} planned tasks delivered (${Math.round((done / (planned || 1)) * 100)}%)`;
    }).join(' / ')}</p>`;
}

function wireEvents() {
  byId('truthRefresh')?.addEventListener('click', rebuildTruth);
  TRUTH_FILTERS.forEach(id => byId(id)?.addEventListener('change', () => { truthPage = 0; renderTruth(); }));
  byId('tSearch')?.addEventListener('input', () => { truthPage = 0; renderTruth(); });
  byId('tReset')?.addEventListener('click', () => {
    [...TRUTH_FILTERS, 'tSearch'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    truthPage = 0; renderTruth();
  });
  byId('truthPrev')?.addEventListener('click', () => { truthPage -= 1; renderTruth(); });
  byId('truthNext')?.addEventListener('click', () => { truthPage += 1; renderTruth(); });
  byId('truthChainClose')?.addEventListener('click', () => {
    openChain = null; byId('truthChainPanel').hidden = true;
  });
  byId('truthFigures')?.addEventListener('click', event => {
    const card = event.target.closest('[data-chain]');
    if (!card) return;
    const label = card.dataset.chain;
    if (openChain === label) { openChain = null; byId('truthChainPanel').hidden = true; return; }
    renderChain(label, Object.values(truthFilters()).some(Boolean));
    byId('truthChainPanel').scrollIntoView({behavior: 'smooth', block: 'nearest'});
  });
  byId('truthRows')?.addEventListener('click', event => {
    const button = event.target.closest('.drill-toggle');
    if (!button) return;
    const panel = byId(button.getAttribute('aria-controls'));
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    button.textContent = open ? '+' : '\u2212';
    if (panel) panel.hidden = open;
  });
  ['cState', 'cOwner'].forEach(id => byId(id)?.addEventListener('change', renderCarried));
  byId('cSearch')?.addEventListener('input', renderCarried);
  byId('cReset')?.addEventListener('click', () => {
    ['cState', 'cOwner', 'cSearch'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    renderCarried();
  });
  const ledgerFilters = ['ledgerPayment','ledgerType','ledgerValidity','ledgerDuplicates'];
  const resetLedgerPage = () => { ledgerPage = 0; renderPayoutLedger(); };
  ledgerFilters.forEach(id => byId(id).addEventListener('change', resetLedgerPage));
  byId('ledgerSearch').addEventListener('input', resetLedgerPage);
  byId('resetLedgerFilters').addEventListener('click', () => {
    [...ledgerFilters, 'ledgerSearch'].forEach(id => byId(id).value = '');
    ledgerPage = 0;
    renderPayoutLedger();
  });
  const navButtons = [...document.querySelectorAll('.viewnav-tab')];
  navButtons.forEach((button, index) => {
    button.tabIndex = button.classList.contains('is-active') ? 0 : -1;
    button.addEventListener('click', () => switchView(button.dataset.view));
    button.addEventListener('keydown', event => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = navButtons[(index + step + navButtons.length) % navButtons.length];
      next.focus();
      switchView(next.dataset.view);
    });
  });
  document.querySelectorAll('[data-jump]').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.jump));
  });
  window.addEventListener('popstate', () => switchView(location.hash.slice(1) || 'command', false));
  byId('globalSearch').addEventListener('input', event => {
    const active = document.querySelector('.viewnav-tab.is-active')?.dataset.view;
    const target = VIEW_SEARCH[active];
    if (!target || !byId(target)) return;
    byId(target).value = event.target.value;
    byId(target).dispatchEvent(new Event('input'));
  });
  const resetPayoutPages = () => { payoutPage = 0; ledgerPage = 0; renderTrainerRows(); };
  byId('personSearch').addEventListener('input', resetPayoutPages);
  byId('trainerFilter').addEventListener('change', resetPayoutPages);
  byId('payoutPrevious').addEventListener('click', () => { payoutPage -= 1; renderTrainerRows(); });
  byId('payoutNext').addEventListener('click', () => { payoutPage += 1; renderTrainerRows(); });
  byId('ledgerPrevious').addEventListener('click', () => { ledgerPage -= 1; renderPayoutLedger(); });
  byId('ledgerNext').addEventListener('click', () => { ledgerPage += 1; renderPayoutLedger(); });
  byId('paymentFilter').addEventListener('change', resetPayoutPages);
  byId('benchFilter').addEventListener('change', resetPayoutPages);
  const presets = {'7': 7, '14': 14, '30': 30};
  byId('datePreset').addEventListener('change', event => {
    const value = event.target.value;
    if (!value) { dateRange.start = dateRange.end = ''; }
    else if (value === 'live') { dateRange.start = window.PIPELINE_LEGACY_BEFORE; dateRange.end = ''; }
    else {
      const end = new Date();
      const start = new Date(end.getTime() - (presets[value] - 1) * 86400000);
      dateRange.start = start.toISOString().slice(0, 10);
      dateRange.end = end.toISOString().slice(0, 10);
    }
    byId('dateStart').value = dateRange.start;
    byId('dateEnd').value = dateRange.end;
    applyRange();
  });
  ['dateStart', 'dateEnd'].forEach(id => byId(id).addEventListener('change', () => {
    dateRange.start = byId('dateStart').value;
    dateRange.end = byId('dateEnd').value;
    byId('datePreset').value = '';
    applyRange();
  }));
  byId('explorerRefresh').addEventListener('click', () => loadExplorer(true));
  byId('explorerFilter').addEventListener('input', renderExplorerBody);
  byId('explorerSort').addEventListener('change', renderExplorerBody);
  byId('explorerCrumbs').addEventListener('click', event => {
    const crumb = event.target.closest('.crumb');
    if (crumb) openExplorer(crumb.dataset.path);
  });
  byId('explorerDirs').addEventListener('click', event => {
    const dir = event.target.closest('.explorer-dir');
    if (dir) openExplorer(dir.dataset.path);
  });
  byId('explorerSearch').addEventListener('input', async event => {
    if (!explorer) return;
    const {rows, reason} = await explorer.findFolders(event.target.value, 60);
    if (reason && !rows.length) { setText('explorerFoot', reason); return; }
    byId('explorerDirs').innerHTML = rows.map(path =>
      `<li><button class="explorer-dir" data-path="${esc(path)}">${esc(path)}</button></li>`).join('');
    setText('explorerFoot', `${fmt(rows.length)} folder${rows.length === 1 ? '' : 's'} match. Open one to see its files.`);
  });
  byId('clearDates').addEventListener('click', () => {
    dateRange.start = dateRange.end = '';
    byId('dateStart').value = byId('dateEnd').value = byId('datePreset').value = '';
    applyRange();
  });
  const popover = byId('infoPopover');
  let openButton = null;
  function hideInfo() {
    popover.hidden = true;
    if (openButton) openButton.setAttribute('aria-expanded', 'false');
    openButton = null;
  }
  function showInfo(button) {
    const copy = infoCopy[button.dataset.info];
    if (!copy) return;
    if (openButton) openButton.setAttribute('aria-expanded', 'false');
    popover.textContent = copy;
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openButton = button;
    place(button);
  }
  function place(element) {
    const anchor = element.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const left = Math.min(Math.max(12, anchor.left + anchor.width / 2 - box.width / 2), window.innerWidth - box.width - 12);
    const below = anchor.bottom + 9;
    popover.style.left = `${left}px`;
    popover.style.top = `${below + box.height > window.innerHeight - 12 ? Math.max(12, anchor.top - box.height - 9) : below}px`;
  }
  document.querySelectorAll('.why').forEach(button => {
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('mouseenter', () => showInfo(button));
    button.addEventListener('mouseleave', hideInfo);
    button.addEventListener('focus', () => showInfo(button));
    button.addEventListener('blur', hideInfo);
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (openButton === button) hideInfo(); else showInfo(button);
    });
  });
  // Chart segments get the same popover, on hover, with their own copy.
  document.addEventListener('mouseover', event => {
    const target = event.target.closest('[data-tip]');
    if (target) { popover.textContent = target.dataset.tip; popover.hidden = false; place(target); }
  });
  document.addEventListener('mouseout', event => {
    if (event.target.closest('[data-tip]') && !openButton) popover.hidden = true;
  });
  document.addEventListener('click', hideInfo);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideInfo(); });
  window.addEventListener('scroll', hideInfo, true);
}

// The topbar search drives whichever view owns a search box.
const VIEW_SEARCH = {payouts: 'personSearch', pipeline: 'tSearch', carried: 'cSearch'};

function syncSearch(viewName) {
  const target = VIEW_SEARCH[viewName];
  const box = byId('globalSearch');
  box.closest('.search').classList.toggle('is-off', !target);
  box.disabled = !target;
  box.placeholder = target ? (viewName === 'payouts' ? 'Search a person, team or manager' : 'Search a task, trainer or reason') : 'Search is available on Payouts and Pipeline';
  // A view's search box may not exist yet while its data is still loading.
  box.value = target && byId(target) ? byId(target).value : '';
}

function init() {
  renderHero();
  renderTopPendingCards();
  renderDonut();
  renderBenchCards();
  renderTrainerRows();
  renderTeams();
  renderPlan();
  wireEvents();
  applyRange();
  switchView(location.hash.slice(1) || 'command', false);
  loadPayoutLedger();
  loadClientAcceptance();
  loadHarborConsole();
  loadConsoleLive();
  loadGcsPipeline();
  loadTruth();
}

init();
