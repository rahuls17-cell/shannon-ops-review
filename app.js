const data = window.OPS_REVIEW_DATA;
let finalisationSource = null;
let finalisationRows = [];
let finalisationCohorts = [];
const FINALISATION_ROW_CAP = 400;
let gcsPipeline = null;
let payoutLedger = null;
let payoutLedgerTasks = [];
let clientAcceptance = null;
let explorer = null;
let explorerPath = '';
let explorerEntry = null;
// PRD X1: one range for the whole dashboard except Payouts, which reports what
// the workbook paid rather than when the work happened.
const dateRange = {start: '', end: ''};
let harborConsole = null;
let consoleLive = null;
// Content fingerprints for delivered packages, built by tools/build_fingerprints.py.
// Optional: without it the pipeline groups by name, exactly as it did before.
let taskFingerprints = null;
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
  basis: 'Three counts of the same work, none of them wrong, because they count different things. Submissions is every attempt, which is what the Harbor Console\u2019s cards show. Tasks by name is one row per task name at its latest submission, because a task resubmitted five times is still one piece of work. Tasks by content goes further: a task delivered under two different folder names hashes to the same content fingerprint and is counted once, which no amount of name matching can see. Subtract the re-submissions from the console figure and you get the second; fold the duplicate names and you get the third. The residual few are the console filter starting at a time of day where ours starts at midnight, and anything submitted since the last pull.',
  explorerScope: 'A metadata-only mirror of the delivery prefixes of the GCS bucket: the seven finalisation cohorts and the trainer evaluation records. It holds names, sizes and timestamps, never object contents, and it never writes to the bucket. The whole bucket is far larger - over 22 million objects and 9 million folders - which cannot be mirrored into a static page, so prefixes outside this scope are deliberately absent rather than silently empty.',
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
  dailyDelta: 'How many tasks reached each status on each day - the movement, not the standing total, so a quiet day and a busy day look different rather than both looking like a large total. Status is the Harbor Console\u2019s, always. The day comes from the GCS evaluation ledger\u2019s record of that task reaching that status, because the console carries only the submission date and older pulls carry no time at all; the ledger supplies the when, never the whether. Where the ledger holds no record of a task at the status it now has, the submission date stands in and the count of those is stated beneath the chart. Each task counts once however many names it was delivered under. Throughput splits the same work by bench instead, which is a different question.',
  taskBasis: 'Three counts of the same work, none of them wrong, because they count different things. Submissions is every attempt, which is what the Harbor Console\u2019s own cards show. Re-submitted is the attempts beyond the first: a task submitted five times is still one piece of work, and counting it five times would overstate both delivery and pay. Tasks is what is left once those are removed and once work delivered under two different folder names is recognised as one task by its content fingerprint, which no amount of name matching can see. The figures add up exactly, which is why they are shown together rather than one being picked as the headline.',
  throughputMining: 'Tasks submitted per day, against the workbook\u2019s daily commitment. The commitment comes from the New Task Mining Daily Plan tab, which counts tasks mined - submissions - not tasks accepted, so the actual series counts console submissions to match it. A task submitted three times counts three times here, because the plan commits to submissions. The workbook also carries its own actual column; it is not used, because it stops being filled after 12 September.',
  throughputAcceptance: 'Tasks accepted per day, one point per task at its FIRST acceptance however many attempts it took. Timing comes from the GCS evaluation ledger, whose updatedAt carries a full timestamp where the console\u2019s submittedAt is date-only. The ledger supplies only the date here; it never overrides the console on whether a task was accepted. This is a different event from mining, so it gets its own chart rather than a second line on the one above.',
  throughputType: 'Connector and non-connector come from the Harbor Console, which records them cleanly; the GCS taskType is a domain (Code, Health, Law) and is not used for this. 97 task names carry both labels in the console, because a normalised task name is not a task identity - it collides across families. Those are shown as Contested rather than resolved to whichever record was read first. The workbook commitment is not split by type, so choosing a type withdraws the plan line instead of comparing against a plan that does not apply.',
  throughputSplit: 'Company is the Company team; Computer covers Computer A and Computer B. Unassigned is everything else - 178 roster rows carry no team and some task owners are not on the roster at all (PRD C5). It is shown rather than dropped, so these totals reconcile against the Pipeline tab and the gap stays visible.',
  workbook: 'A workbook-wide snapshot with no reliable person-level allocation, so it does not respond to the filters on the other tabs and cannot be split by trainer.',
};

function renderEverything() {
  renderSources();
  buildPipeline();
  populateFilters();
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams();
  renderPipeline();
  renderBenchCards();
  renderPlan();
  renderThroughput();
  renderTaskBasis();
  populateDeltaFilter();
  renderDailyDelta();
  renderExplorerBody();
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
    setText('pipelineSourceStatus', `Bucket evidence rejected: ${error.message}`);
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
  try {
    const response = await fetch(`assets/task-fingerprints.json?t=${Date.now()}`, {cache: 'no-store'});
    taskFingerprints = response.ok ? await response.json() : null;
  } catch {
    taskFingerprints = null;
  }
  buildPipeline();
  buildThroughput();
  buildDelta();
  populateFilters();
  renderPipeline();
  renderThroughput();
  renderTaskBasis();
  populateDeltaFilter();
  renderDailyDelta();
  renderBenchCards();
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
  buildPipeline();
  buildThroughput();
  buildDelta();
  populateFilters();
  renderPipeline();
  renderThroughput();
  renderTaskBasis();
  populateDeltaFilter();
  renderDailyDelta();
  renderBenchCards();
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

async function loadGcsPipeline(manual = false) {
  try {
    const response = await fetch(`assets/gcs-pipeline.json?refresh=${manual ? Date.now() : 'startup'}`, {cache:'no-store'});
    if (!response.ok) throw new Error('GCS export unavailable');
    const payload = await response.json();
    if (payload.schemaVersion !== 3 || !['current','historical','legacy'].every(key=>Array.isArray(payload[key])) || !Array.isArray(payload.finalisation?.tasks)) throw new Error('Invalid GCS export');
    ['current', 'historical', 'legacy'].forEach(key => payload[key].forEach(task => { task.domain = pipelineDomain(task); }));
    gcsPipeline = payload;
      loadFinalisation(); buildPipeline(); buildThroughput(); buildDelta(); populateFilters(); renderPipeline(); renderThroughput(); renderDonut(); renderTrainerRows();
    renderSources(); renderHero(); renderTopPendingCards(); renderBenchCards();
    if (manual) setText('pipelineSourceStatus', `Latest published GCS export loaded: ${gcsPipeline.generatedAt}`);
  } catch {
    setText('pipelineSourceStatus', 'GCS export unavailable. Pipeline counts are not loaded.');
  }
}

async function refreshGcsPipeline() {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) {
    window.open('https://github.com/rahuls17-cell/shannon-ops-review/actions/workflows/refresh-gcs.yml', '_blank', 'noopener,noreferrer');
    setText('pipelineSourceStatus', 'Start Run workflow in GitHub to fetch GCS. This page checks for the published result every minute.');
    return;
  }
  const button = byId('refreshGcsPipeline');
  button.disabled = true;
  button.textContent = 'Refreshing...';
  try {
    const response = await fetch('/api/refresh-gcs', {method: 'POST', cache: 'no-store'});
    if (!response.ok) throw new Error('Manual refresh service unavailable');
    await loadGcsPipeline(true);
  } catch {
    setText('pipelineSourceStatus', 'Bucket refresh failed. Previous snapshot remains displayed.');
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh from GCS';
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

const VIEWS = ['command', 'payouts', 'delivery', 'pipeline', 'throughput', 'explorer'];
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
  // PRD X3: the pending count and amount are the KPI tile's story. This
  // headline carries the split only, so the same number is not read twice.
  setText("heroExposureText", `${paidPct}% of committed payout already made`);
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
  setText("metricPending", money(pending));
  setText("metricActive", fmt(summary.activeTrainers));
  setText("metricRoster", `${fmt(summary.totalTrainers)} total trainer records`);
  setText('commandSourceStatus', gcsPipeline
    ? `${fmt(gcsPipeline.current.length)} current evaluations \u00b7 ${fmt(finalisationRows.length)} accepted folders`
    : 'Waiting for the bucket scan.');
  byId('commandSummary').innerHTML = [
    ['Current evaluated tasks', gcsPipeline ? snapshot.current.length : null],
    ['Pipeline accepted', gcsPipeline ? snapshot.current.filter(row => row.status === 'Accepted').length : null],
    ['Accepted finalisation folders', finalisationRows.length ? snapshot.folders.length : null],
    ['Cross-cohort repeats excluded', snapshot.ready ? snapshot.duplicates : null]
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value == null ? '-' : fmt(value)}</strong></div>`).join('');
  setText('commandOwnership', snapshot.ready
    ? `${fmt(snapshot.unassigned)} accepted folders have no roster-linked owner \u2014 excluded from financial estimates.`
    : 'Needs the GCS export.');
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

// PRD X2: a figure that cannot be traced is not a finished figure. Each KPI
// tile names its source and links to it, matching the per-view sourcestrip.
function renderFigureSources() {
  document.querySelectorAll('.figure-src[data-source]').forEach(slot => {
    // A figure can rest on more than one source - status from the console,
    // timing from the ledger - and naming only the first would misattribute it.
    const links = slot.dataset.source.split(',').map(id => id.trim()).map(id => {
      const source = window.DASHBOARD_SOURCES.find(entry => entry.id === id);
      if (!source) return '';
      const state = sourceState(source);
      return source.href
        ? `<a href="${esc(source.href)}" target="_blank" rel="noopener" class="figure-srclink"
             data-tip="${esc(source.what)} / ${esc(state.detail)}">${esc(source.name)}</a>`
        : `<span class="figure-srclink is-flat" data-tip="${esc(source.hrefNote || source.what)}">${esc(source.name)}</span>`;
    }).filter(Boolean);
    slot.innerHTML = links.length ? `<span class="figure-src-label">Source</span>${links.join('<span class="figure-src-sep">/</span>')}` : '';
  });
}

function renderSources() {
  renderFigureSources();
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

const BENCH_OF_LABEL = {company: 'Company', computer: 'Computer', unassigned: 'Unassigned'};
function renderBenchCards() {
  const snapshot = commandSnapshot();
  const roster = new Map(data.trainers.map(row => [row.email.toLowerCase(), row]));
  const bench = email => {
    const team = roster.get(String(email || '').toLowerCase())?.team;
    return team === 'Company' ? 'Company' : ['Computer A', 'Computer B'].includes(team) ? 'Computer' : 'Unassigned';
  };
  // Status comes from the console, never the GCS ledger. This panel used to
  // count gcsPipeline.current, which is evidence - the repo's own rule makes
  // the console authoritative for status, and the two disagree materially.
  const live = pipelineRowsModel.filter(row => !row.legacy && inRange(row.date));
  byId('benchCards').innerHTML = ['Computer', 'Company', 'Unassigned'].map(name => {
    const tasks = live.filter(row => BENCH_OF_LABEL[row.bench] === name);
    const groups = [...new Set(snapshot.folders.filter(row => bench(row.trainer?.email) === name).map(row => row.name))];
    return `<div class="bench-card"><h3>${name} bench</h3>${[
      ['Tasks', pipelineRowsModel.length ? tasks.length : null],
      ['Accepted', pipelineRowsModel.length ? tasks.filter(row => row.status === 'Accepted').length : null],
      ['Delivered to the bucket', snapshot.ready ? groups.length : null]
    ].map(([label, value]) => `<div class="bench-metric"><span>${label}</span><b>${value == null ? '-' : fmt(value)}</b></div>`).join('')}</div>`;
  }).join('');
}

function uniqueTeams() {
  return [...new Set(data.trainers.map((trainer) => trainer.team || "Unassigned"))].sort();
}

function populateFilters() {
  const population = pipelinePopulation();
  PIPELINE_FILTERS.forEach(filter => {
    const counts = new Map();
    population.forEach(task => {
      const key = filter.of(task);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const select = byId(filter.id), selected = select.value;
    const options = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    select.innerHTML = `<option value="">All ${filter.label} (${fmt(population.length)})</option>` +
      options.map(([value, count]) => `<option value="${esc(value)}">${esc(value)} (${fmt(count)})</option>`).join('');
    select.value = counts.has(selected) ? selected : '';
  });
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
    if (node.classList.contains('is-exempt')) {
      // PRD X1 names every page, but the workbook records what was PAID, not
      // when the work happened - filtering it would silently drop people paid
      // for older work. Stating the exemption is the honest way to meet X1.
      node.innerHTML = '<span class="rangeecho-label">Date range</span>Not applied here &mdash; the workbook records when payment was made, not when the work was done.';
      return;
    }
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

const PIPELINE_CONTROLS = ['pipelineFilter', 'pipelineLegacy', 'pipelineType', 'pipelineTrainer', 'pipelineEvidence'];
let pipelineRowsModel = [];
const expandedRows = new Set();

let throughputModel = null;

function buildThroughput() {
  // Built from the rows preparePipeline already produced, so acceptance counts
  // distinct tasks on the canonical identity rather than regrouping the console
  // by name a second time. Must therefore run after buildPipeline().
  if (!pipelineRowsModel.length) { throughputModel = null; return; }
  try {
    throughputModel = window.prepareThroughput(data.plan, gcsPipeline, pipelineRowsModel, consoleLive);
  } catch (error) {
    throughputModel = null;
    setText('throughputStatus', `Throughput could not be built: ${error.message}`);
  }
}

function buildPipeline() {
  if (!consoleLive) { pipelineRowsModel = []; return; }
  try {
    pipelineRowsModel = window.preparePipeline(consoleLive, gcsPipeline, finalisationRows, data.trainers,
      taskFingerprints);
  } catch (error) {
    pipelineRowsModel = [];
    setText('pipelineSourceStatus', `Pipeline could not be built: ${error.message}`);
  }
}

function pipelineFilters() {
  return {
    status: byId('pipelineFilter').value,
    legacy: byId('pipelineLegacy').value,
    type: byId('pipelineType').value,
    trainer: byId('pipelineTrainer').value,
    evidence: byId('pipelineEvidence').value,
    search: byId('pipelineSearch').value,
    start: dateRange.start,
    end: dateRange.end,
  };
}

function populateFilters() {
  const scope = byId('pipelineLegacy').value;
  const population = scope === 'only' ? pipelineRowsModel.filter(row => row.legacy)
    : scope === 'all' ? pipelineRowsModel
    : pipelineRowsModel.filter(row => !row.legacy);
  const specs = [
    ['pipelineFilter', 'statuses', row => row.status],
    ['pipelineType', 'types', row => row.taskType],
    ['pipelineTrainer', 'trainers', row => row.owner || 'No owner recorded'],
  ];
  for (const [id, label, of] of specs) {
    const counts = new Map();
    population.forEach(row => {
      const key = of(row);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const select = byId(id), chosen = select.value;
    const options = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    select.innerHTML = `<option value="">All ${label} (${fmt(population.length)})</option>` +
      options.map(([value, count]) => `<option value="${esc(value)}">${esc(value)} (${fmt(count)})</option>`).join('');
    select.value = counts.has(chosen) ? chosen : '';
  }
  populateThroughputFilters();
}

function renderPipelineTimeline(rows, statuses) {
  const dated = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  const byDate = new Map();
  dated.forEach(row => {
    if (!byDate.has(row.date)) byDate.set(row.date, new Map());
    const day = byDate.get(row.date);
    day.set(row.status, (day.get(row.status) || 0) + 1);
  });
  const days = [...byDate.keys()].sort();
  const order = statuses.map(([status]) => status);
  const tallest = Math.max(...days.map(day => [...byDate.get(day).values()].reduce((total, value) => total + value, 0)), 1);
  byId('pipelineTimeline').innerHTML = days.length ? `
    <figcaption>${fmt(dated.length)} tasks across ${fmt(days.length)} days, by the day the task was last submitted</figcaption>
    <div class="timeline-plot">
      ${days.map(day => {
        const counts = byDate.get(day);
        const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
        return `<div class="timeline-day">
          <div class="timeline-total">${fmt(total)}</div>
          <div class="timeline-column" style="height:${Math.max((total / tallest) * 100, 1.5)}%">
            ${order.filter(status => counts.get(status)).map(status =>
              `<span class="timeline-seg" data-status="${esc(status)}" style="flex:${counts.get(status)}" data-tip="${esc(day)} / ${esc(status)}: ${fmt(counts.get(status))} of ${fmt(total)} tasks"></span>`).join('')}
          </div>
          <div class="timeline-date">${esc(day.slice(5))}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="chart-key">${order.map(status =>
      `<span class="key-item" data-status="${esc(status)}"><i></i>${esc(status)}</span>`).join('')}</div>` :
    '<p class="empty">No dated tasks in this selection.</p>';
}

function drilldown(row) {
  const ledger = row.ledger, bucket = row.bucket;
  const cells = [
    ['Console', `${row.status} at the latest of ${fmt(row.submissions)} submission${row.submissions === 1 ? '' : 's'}` +
      (row.failedStage ? ` / failed at ${esc(row.failedStage)}` : '')],
    ['Evaluation ledger', ledger.cycles
      ? `${fmt(ledger.cycles)} cycle${ledger.cycles === 1 ? '' : 's'}, up to attempt ${fmt(ledger.attempts)} / ledger says ${esc(ledger.statuses.join(', ') || 'nothing')}` +
        (ledger.disagrees ? ' <strong class="negative">— disagrees with the console</strong>' : '')
      : 'No evaluation cycles recorded for this task'],
    ['Delivered', bucket.folders
      ? `${fmt(bucket.folders)} folder${bucket.folders === 1 ? '' : 's'} in ${esc(bucket.cohorts.join(', '))} / ${fmt(bucket.archives)} archive${bucket.archives === 1 ? '' : 's'} / ${esc(bucket.domain)}${bucket.connector ? ' / connector' : ''}`
      : 'Nothing in the accepted cohorts of the bucket'],
    ['Owner', row.owner
      ? `${esc(row.owner)}${row.onRoster ? ` / ${esc(row.trainer.team || 'no team')}` : ' <strong class="negative">— not on the roster</strong>'}`
      : 'The console records no submitter'],
  ];
  return `<tr class="drill"><td colspan="8"><dl class="drill-grid">` +
    cells.map(([term, detail]) => `<dt>${esc(term)}</dt><dd>${detail}</dd>`).join('') +
    `</dl></td></tr>`;
}


// An audit detail, not a headline: a task whose identity came from a content
// fingerprint rather than its name is marked, and says what else it was called.
// Deliberately quiet - most rows carry it, so anything louder would be noise.
function identityBadge(row) {
  const identity = row.identity;
  if (!identity || identity.basis !== 'content') return '';
  const aka = identity.alsoKnownAs || [];
  const tip = aka.length
    ? `Identified by content fingerprint. The same content is also delivered under ${aka.length === 1 ? 'another name' : `${aka.length} other names`}: ${aka.join(', ')}. Counting by name would treat ${aka.length === 1 ? 'it' : 'them'} as separate work.`
    : 'Identified by the content of what was delivered, not by its name. No other name delivers this content.';
  return `<span class="idbadge${aka.length ? ' is-shared' : ''}" data-tip="${esc(tip)}"
    role="img" aria-label="${esc(tip)}">${aka.length ? '◈' : '◇'}</span>`;
}

function renderPipelineRows(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  pipelinePage = Math.min(Math.max(pipelinePage, 0), pages - 1);
  const from = pipelinePage * 50;
  const page = rows.slice(from, from + 50);
  setText('pipelinePage', rows.length
    ? `${fmt(from + 1)}-${fmt(from + page.length)} of ${fmt(rows.length)} tasks / page ${fmt(pipelinePage + 1)} of ${fmt(pages)}`
    : 'No tasks match these filters');
  byId('pipelinePrevious').disabled = pipelinePage === 0;
  byId('pipelineNext').disabled = pipelinePage >= pages - 1;
  byId('pipelineRows').innerHTML = page.map(row => {
    const open = expandedRows.has(row.key);
    return `<tr class="drill-head${open ? ' is-open' : ''}" data-key="${esc(row.key)}">
        <td><button class="drill-toggle" aria-expanded="${open}" aria-label="Evidence for ${esc(row.name)}">${open ? '\u2212' : '+'}</button></td>
        <td><div class="person"><strong>${esc(row.name)}${identityBadge(row)}</strong><span>${row.legacy ? 'Legacy' : 'Live'}${row.ledger.disagrees ? ' / ledger disagrees' : ''}</span></div></td>
        <td><span class="pill" data-status="${esc(row.status)}">${esc(row.status)}</span></td>
        <td>${esc(row.trainer?.name || row.owner || 'No owner')}${row.owner && !row.onRoster ? '<small>not on roster</small>' : ''}</td>
        <td>${esc(row.taskType.replace(' tasks', ''))}</td>
        <td>${esc(row.date || 'Not recorded')}</td>
        <td class="num">${fmt(row.ledger.attempts || row.submissions)}</td>
        <td class="num">${fmt(row.bucket.folders)}</td>
      </tr>` + (open ? drilldown(row) : '');
  }).join('') || '<tr><td colspan="8" class="empty">No tasks match these filters.</td></tr>';
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
  // PRD X1: the shared range reaches this view too, applied to the object's
  // last-modified date. Folders are not filtered - a folder has no date of its
  // own, and hiding the path to a file would make the range look like data loss.
  let rows = explorerEntry.files.filter(file =>
    (!needle || file.name.toLowerCase().includes(needle)) && inRange(file.updated));
  rows = rows.slice().sort((a, b) => sort === 'size' ? b.size - a.size
    : sort === 'updated' ? String(b.updated).localeCompare(String(a.updated))
    : a.name.localeCompare(b.name));

  files.innerHTML = rows.length
    ? rows.map(file => `<tr><td class="mono">${esc(file.name)}</td><td class="num">${bytes(file.size)}</td><td>${esc(String(file.updated).replace('T', ' ').replace(/\..*$/, ''))}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty">${explorerEntry.files.length ? 'No file matches that filter.' : 'No files directly in this folder.'}</td></tr>`;

  setText('explorerFoot', `${fmt(explorerEntry.dirs.length)} folder${explorerEntry.dirs.length === 1 ? '' : 's'} / ` +
    `${fmt(rows.length)} of ${fmt(explorerEntry.files.length)} file${explorerEntry.files.length === 1 ? '' : 's'} shown / ` +
    `${bytes(explorerEntry.bytes)} in this folder. ` +
    ((dateRange.start || dateRange.end) ? `Files are limited to ${rangeLabel().toLowerCase()} by last-modified date; folders are not filtered. ` : '') +
    `Sizes and dates come from the object metadata; contents are never read.`);
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


let deltaModel = null;

function buildDelta() {
  if (!pipelineRowsModel.length) { deltaModel = null; return; }
  try {
    deltaModel = window.prepareDelta(pipelineRowsModel.filter(row => !row.legacy), gcsPipeline);
  } catch (error) {
    deltaModel = null;
    setText('deltaNote', `Daily delta could not be built: ${error.message}`);
  }
}

// PRD C6. One line per status, so the shape of a day is readable at a glance:
// a spike in Accepted and a spike in Rejected are the same height on the same
// axis and can be compared directly.
function renderDailyDelta() {
  const figure = byId('deltaChart');
  if (!figure) return;
  if (!deltaModel) {
    figure.innerHTML = '<p class="empty">Waiting for the console pull.</p>';
    byId('deltaPeaks').innerHTML = '';
    setText('deltaNote', '');
    return;
  }
  const picked = byId('deltaStatus').value;
  const result = window.filterDelta(deltaModel,
    {start: dateRange.start, end: dateRange.end, status: picked});

  figure.innerHTML = lineChart(result.days, result.statuses.map(status => ({
    label: status,
    token: STATUS_TOKENS[status] || '--slate',
    values: result.days.map(day => result.series[status][day] || 0),
  })), {label: 'Tasks reaching each status per day',
        empty: result.invalidDates ? 'The start date is after the end date.'
                                   : 'No status changes in this selection.'});

  byId('deltaPeaks').innerHTML = `<span class="peakstrip-label">Busiest day</span>` +
    result.statuses.filter(status => result.peak[status].count).map(status => {
      const peak = result.peak[status];
      return `<span class="peakstrip-item"><i style="background:var(${STATUS_TOKENS[status] || '--slate'})"></i>${
        esc(status)} <b>${fmt(peak.count)}</b> <small>${esc(peak.date.slice(5))}</small></span>`;
    }).join('');

  // A date that had to be inferred is not a date that was observed, and the
  // page says which is which rather than presenting one as the other.
  const inferred = result.dated.submission;
  setText('deltaNote', `${fmt(result.tasks)} tasks, ${rangeLabel().toLowerCase()}. ` + (inferred
    ? `${fmt(inferred)} dated by submission, not the ledger \u2014 those sit earlier than they moved.`
    : 'All dated by the ledger.'));
}

function populateDeltaFilter() {
  const select = byId('deltaStatus');
  if (!select || !deltaModel) return;
  const counts = new Map();
  deltaModel.events.forEach(event => counts.set(event.status, (counts.get(event.status) || 0) + 1));
  const chosen = select.value;
  select.innerHTML = '<option value="">All statuses</option>' +
    [...counts].sort((a, b) => b[1] - a[1]).map(([status, count]) =>
      `<option value="${esc(status)}">${esc(status)} (${fmt(count)})</option>`).join('');
  select.value = counts.has(chosen) ? chosen : '';
}


// PRD F2. Three counts of the same work. Deliberately not collapsed to one:
// each is the previous count with a specific kind of repeat removed, and the
// arithmetic is shown closing so nobody reads them as competing figures.
function renderTaskBasis() {
  const tiles = byId('taskBasisTiles');
  if (!tiles) return;
  if (!pipelineRowsModel.length) {
    tiles.innerHTML = '<p class="empty">Waiting for the console pull.</p>';
    setText('taskBasisEquation', '');
    setText('taskBasisNote', '');
    return;
  }
  // Live scope, following the shared date range. Pipeline's own status and
  // trainer filters are deliberately not applied: this is the Overview.
  const result = window.filterPipeline(pipelineRowsModel,
    {legacy: '', start: dateRange.start, end: dateRange.end});
  const tasks = result.identities;
  const resubmitted = result.submissions - result.rows.length;
  const folded = result.rows.length - result.identities;

  tiles.innerHTML = [
    ['Tasks', tasks, 'Distinct pieces of work', 'is-headline'],
    ['Submissions', result.submissions, 'Every attempt, as the console counts', ''],
    ['Re-submitted', resubmitted, 'Attempts beyond the first', ''],
  ].map(([label, value, note, tone]) => `<article class="basis-tile ${tone}">
      <h3>${esc(label)}</h3><strong>${fmt(value)}</strong><p>${esc(note)}</p>
    </article>`).join('');

  // Four terms, not three: folding two names onto one task is a different
  // correction from a re-submission, and collapsing them would hide it.
  setText('taskBasisEquation', folded
    ? `${fmt(tasks)} tasks  +  ${fmt(resubmitted)} re-submitted  +  ${fmt(folded)} same task under another name  =  ${fmt(result.submissions)} submissions`
    : `${fmt(tasks)} tasks  +  ${fmt(resubmitted)} re-submitted  =  ${fmt(result.submissions)} submissions`);
  setText('taskBasisNote', `${fmt(result.identifiedByContent)} of ${fmt(result.rows.length)} identified by content. ` +
    (folded ? `${fmt(result.sharedIdentity)} rows share content under different names.` : 'No shared names.') +
    ` ${rangeLabel()}.`);
}

function renderConsoleBasis(result) {
  const node = byId('consoleBasis');
  if (!node) return;
  const repeats = result.repeatTasks;
  const order = ['Accepted', 'Rejected', 'Failed', 'Running', 'Queued', 'Legacy accepted'];
  const names = [...new Set([...order, ...Object.keys(result.submissionStatuses), ...Object.keys(result.statuses)])]
    .filter(name => result.submissionStatuses[name] || result.statuses[name]);
  node.innerHTML = `
    <p class="basis-lede">The console counts <b>submissions</b>. This page counts <b>tasks</b>, each at its latest
      submission. ${fmt(result.submissions)} submissions collapse to ${fmt(result.rows.length)} tasks:
      ${fmt(repeats)} task${repeats === 1 ? ' was' : 's were'} submitted more than once, adding
      ${fmt(result.submissions - result.rows.length)} extra rows the console shows and this page does not.</p>
    <div class="table-wrap">
      <table class="grid basis-table">
        <thead><tr><th scope="col">Status</th><th scope="col" class="num">Submissions (console)</th><th scope="col" class="num">Tasks (this page)</th></tr></thead>
        <tbody>${names.map(name => `<tr><th scope="row">${esc(name)}</th>
          <td class="num">${fmt(result.submissionStatuses[name] || 0)}</td>
          <td class="num">${fmt(result.statuses[name] || 0)}</td></tr>`).join('')}
        <tr class="basis-total"><th scope="row">All</th><td class="num">${fmt(result.submissions)}</td><td class="num">${fmt(result.rows.length)}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="muted footnote">Compare the left column against the console's cards. Its filter starts at a time of
      day where ours starts at midnight, so the console reads slightly lower for the same period.${
        (dateRange.start || dateRange.end || pipelineFilters().status || pipelineFilters().trainer)
          ? ' While a date range or filter is applied these two columns are indicative only: a task is selected on its latest submission, so earlier submissions of a task that has since moved on are not counted here.'
          : ''}</p>`;
}

function renderPipeline(resetPage = true) {
  if (resetPage) pipelinePage = 0;
  if (!pipelineRowsModel.length) {
    setText('pipelineSourceStatus', consoleLive ? 'Building...' : 'No console pull found. Run tools/console-pull.js on the signed-in console tab and drop harbor-console-live.json into assets/.');
    byId('pipelineStats').innerHTML = '';
    byId('pipelineRows').innerHTML = '<tr><td colspan="8" class="empty">Waiting for the console pull.</td></tr>';
    return;
  }
  const filters = pipelineFilters();
  const result = window.filterPipeline(pipelineRowsModel, filters);
  const statuses = Object.entries(result.statuses).sort((a, b) => b[1] - a[1]);
  byId('pipelineStats').innerHTML = statuses
    .map(([status, count]) => `<article class="status-card" data-status="${esc(status)}"><span>${esc(status)}</span><strong>${fmt(count)}</strong></article>`)
    .join('') || '<p class="empty">No tasks match these filters.</p>';
  const cover = consoleLive.coverage || {};
  setText('pipelineSourceStatus', `Console pull ${ageOf(consoleLive.pulledAt)} / ${fmt(cover.tasks)} submissions covering ${cover.from} to ${cover.to} / GCS scan ${gcsPipeline ? gcsPipeline.generatedAt.slice(0, 16).replace('T', ' ') : 'not loaded'}`);
  setText('consoleNote', `Status comes from the Harbor Console. ${fmt(result.population.length)} task${result.population.length === 1 ? '' : 's'} in scope, ${fmt(pipelineRowsModel.length - result.population.length)} out of scope.`);
  renderConsoleBasis(result);
  setText('pipelineAudit', `${fmt(result.rows.length)} of ${fmt(result.population.length)} tasks shown / ${fmt(result.delivered)} have a folder in the bucket / ${fmt(result.disagreements)} where the evaluation ledger disagrees with the console / ${fmt(result.offRoster)} owners not on the roster / ${fmt(result.unowned)} with no owner recorded.`);
  setText('consoleReconcile', `The console is the source of truth for status. Our bucket scan holds ${fmt(finalisationRows.length)} accepted folders, which is a count of what is stored rather than what was accepted - the prefix is pruned while the console keeps the record.`);
  renderPipelineTimeline(result.rows, statuses);
  renderPipelineRows(result.rows);
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


// A small inline line chart. SVG rather than a div stack because these are
// trends over a date axis, and a trend needs a shared y scale to be readable.
const BENCH_TOKENS = {Company: '--blue', Computer: '--aqua', Unassigned: '--slate'};
function lineChart(days, series, options) {
  const settings = options || {};
  if (!days.length || !series.length) return `<p class="empty">${esc(settings.empty || 'No data in this selection.')}</p>`;
  // Axis labels are HTML, not SVG. Text inside a scaling viewBox is painted at
  // whatever the scale factor happens to be - at a 1280px window a 10px label
  // painted at 8px, and at 1024px at 5.8px, which smears into something that
  // reads as bold and cannot be read at all. Only the lines scale now, and they
  // hold their stroke width through vector-effect.
  const peak = Math.max(1, ...series.flatMap(line => line.values));
  const quiet = line => Math.max(0, ...line.values) < peak * 0.05;
  const ordered = [...series.filter(line => !quiet(line)), ...series.filter(quiet)];
  const stroke = line => quiet(line) ? '--line' : (line.token || '--slate');
  // Percentages, so the plot is resolution-independent and the labels can sit
  // outside it at a real font size.
  const px = index => days.length === 1 ? 50 : (index / (days.length - 1)) * 100;
  const py = value => (1 - value / peak) * 100;
  const ticks = [peak, Math.round(peak / 2), 0];

  const points = line => line.values.map((value, index) => `${px(index)},${py(value)}`).join(' ');
  return `
    <div class="linechart-frame">
      <div class="linechart-yaxis" aria-hidden="true">${ticks.map(tick =>
        `<span style="top:${py(tick)}%">${fmt(tick)}</span>`).join('')}</div>
      <div class="linechart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
             aria-label="${esc(settings.label || 'Trend')}">
          <title>${esc(settings.label || 'Trend')}</title>
          ${ticks.map(tick => `<line class="grid" vector-effect="non-scaling-stroke"
            x1="0" x2="100" y1="${py(tick)}" y2="${py(tick)}"/>`).join('')}
          ${ordered.map(line => `<polyline vector-effect="non-scaling-stroke"
            class="spark${line.dashed ? ' is-dashed' : ''}${quiet(line) ? ' is-quiet' : ''}"
            fill="none" stroke="var(${stroke(line)})" points="${points(line)}"/>`).join('')}
        </svg>
        ${ordered.map(line => line.values.map((value, index) =>
          `<span class="spark-dot" style="left:${px(index)}%;top:${py(value)}%;background:var(${stroke(line)})"
             data-tip="${esc(line.label)} / ${esc(days[index])}: ${fmt(value)}"></span>`).join('')).join('')}
      </div>
      <div class="linechart-xaxis">${days.map((day, index) =>
        `<span style="left:${px(index)}%">${esc(day.slice(5))}</span>`).join('')}</div>
    </div>
    <div class="chart-key">${ordered.map(line =>
      `<span class="key-item${line.dashed ? ' is-dashed' : ''}${quiet(line) ? ' is-quiet' : ''}" data-series
        style="--tone: var(${stroke(line)})">${esc(line.label)}</span>`).join('')}</div>`;
}

function renderThroughput() {
  if (!byId('throughputMining')) return;
  if (!throughputModel) {
    setText('throughputStatus', consoleLive
      ? 'Throughput needs the pipeline rows and the GCS export.'
      : 'No console pull loaded, so throughput cannot be built.');
    ['throughputMining', 'throughputAcceptance'].forEach(id =>
      byId(id).innerHTML = '<p class="empty">Waiting for the console pull.</p>');
    byId('throughputStats').innerHTML = '';
    byId('throughputSplit').innerHTML = '';
    return;
  }
  const bench = byId('throughputBench').value;
  const type = byId('throughputType').value;
  const result = window.filterThroughput(throughputModel, {
    start: dateRange.start, end: dateRange.end, bench: bench || '', type: type || '',
  });
  const benches = bench ? [bench] : window.THROUGHPUT_BENCHES;
  const at = map => result.days.map(day => map[day] || 0);

  const planSeries = result.planApplies
    ? benches.filter(name => name !== 'Unassigned').map(name => ({
        label: `${name} plan`, token: '--violet', dashed: true, values: at(result.mining.plan[name])}))
    : [];
  byId('throughputMining').innerHTML = lineChart(result.days, [
    ...planSeries,
    ...benches.map(name => ({label: `${name} submitted`, token: BENCH_TOKENS[name], values: at(result.mining.actual[name])})),
  ], {label: 'Tasks submitted per day against the daily commitment',
      empty: result.invalidDates ? 'The start date is after the end date.' : 'No submissions in this selection.'});

  byId('throughputAcceptance').innerHTML = lineChart(result.days,
    benches.map(name => ({label: `${name} accepted`, token: BENCH_TOKENS[name], values: at(result.acceptance.actual[name])})),
    {label: 'Tasks accepted per day', empty: 'No acceptances in this selection.'});

  const attainment = result.totals.attainment;
  byId('throughputStats').innerHTML = [
    ['Submitted', fmt(result.totals.mined), 'Console rows in this range'],
    ['Daily commitment', result.planApplies ? fmt(result.totals.target) : 'n/a', result.planApplies ? 'Workbook mining plan' : 'Plan is not split by type'],
    ['Attainment', attainment == null ? '-' : `${Math.round(attainment * 100)}%`, 'Submitted against commitment'],
    ['Accepted', fmt(result.totals.accepted), 'Distinct tasks, first acceptance'],
    ['Accepted per submission', result.totals.acceptanceRate == null ? '-' : `${Math.round(result.totals.acceptanceRate * 100)}%`, 'Not a per-task acceptance rate'],
  ].map(([label, value, note]) =>
    `<article class="status-card"><h3>${esc(label)}</h3><strong>${esc(value)}</strong><p>${esc(note)}</p></article>`).join('');

  setText('throughputPlanNote', result.planApplies
    ? 'Plan is the workbook’s New Task Mining Daily Plan, which commits to tasks submitted. Days with no commitment recorded read zero.'
    : 'The workbook commitment is not split by connector type, so no plan line is drawn for this filter. Clear the Type filter to compare against plan.');
  setText('throughputAcceptanceNote', `${fmt(result.totals.accepted)} distinct task${result.totals.accepted === 1 ? '' : 's'} accepted in this range, dated by the GCS ledger. A task accepted after several attempts is counted once, on its first acceptance.`);

  byId('throughputSplit').innerHTML = [
    ...window.THROUGHPUT_BENCHES.map(name => [`${name} bench`, `${fmt(result.byBench[name].mined)} submitted / ${fmt(result.byBench[name].accepted)} accepted`]),
    ...throughputModel.types.map(name => [name, `${fmt(result.byType[name].mined)} submitted / ${fmt(result.byType[name].accepted)} accepted`]),
  ].map(([label, value]) => `<div class="summary-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('') +
    (throughputModel.typeConflicts
      ? `<p class="muted footnote">A task&rsquo;s connector label is its representative submission&rsquo;s, decided by the same rule that decides its status. ${fmt(throughputModel.typeConflicts)} task names carry conflicting labels across their submissions, so for those the rule is choosing rather than reading. Content fingerprinting does not settle it: it groups delivered packages and cannot split one console record in two.</p>`
      : '');

  setText('throughputStatus', `Mining from the Harbor Console pull (${consoleLive?.pulledAt ? ageOf(consoleLive.pulledAt) : 'unknown age'}); acceptance dated from the GCS ledger scan ${gcsPipeline?.generatedAt ? `of ${new Date(gcsPipeline.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}` : '(not loaded)'}.`);
}

function populateThroughputFilters() {
  if (!byId('throughputBench') || !throughputModel) return;
  const specs = [
    ['throughputBench', 'benches', window.THROUGHPUT_BENCHES, event => event.bench],
    ['throughputType', 'types', throughputModel.types, event => event.type],
  ];
  for (const [id, label, values, of] of specs) {
    const counts = new Map(values.map(value => [value, 0]));
    throughputModel.events.forEach(event => counts.set(of(event), (counts.get(of(event)) || 0) + 1));
    const select = byId(id), chosen = select.value;
    select.innerHTML = `<option value="">All ${label}</option>` + values.map(value =>
      `<option value="${esc(value)}">${esc(value)} (${fmt(counts.get(value) || 0)})</option>`).join('');
    select.value = values.includes(chosen) ? chosen : '';
  }
}

function wireEvents() {
  ['throughputBench', 'throughputType'].forEach(id =>
    byId(id).addEventListener('change', renderThroughput));
  byId('deltaStatus').addEventListener('change', renderDailyDelta);
  byId('pipelinePrevious').addEventListener('click',()=>{pipelinePage--;renderPipeline(false);});
  byId('pipelineNext').addEventListener('click',()=>{pipelinePage++;renderPipeline(false);});
  byId('refreshGcsPipeline').addEventListener('click', refreshGcsPipeline);
  byId('refreshConsole').addEventListener('click', async () => {
    const button = byId('refreshConsole');
    button.disabled = true;
    const before = consoleLive?.pulledAt || null;
    await loadConsoleLive();
    if (finalisationSource) loadFinalisation();
    const fresh = consoleLive?.pulledAt && consoleLive.pulledAt !== before;
    setText('consoleNote', (consoleLive
      ? (fresh ? 'Loaded a newer console pull. ' : 'Re-read the console pull; it has not changed. ')
      : 'No console pull found. ') +
      'The console is behind IAP, so the page cannot fetch it directly: run tools/console-pull.js on the signed-in console tab, then drop harbor-console-live.json into assets/.');
    setTimeout(renderPipeline, 4000);
    button.disabled = false;
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
    if (!target) return;
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
  PIPELINE_CONTROLS.forEach(id => byId(id).addEventListener('change', () => {
    if (id === 'pipelineLegacy') populateFilters();
    renderPipeline();
  }));
  byId('pipelineSearch').addEventListener('input', () => renderPipeline());
  byId('clearPipelineDates').addEventListener('click', () => {
    [...PIPELINE_CONTROLS, 'pipelineSearch'].forEach(id => byId(id).value = '');
    populateFilters();
    renderPipeline();
  });
  byId('pipelineRows').addEventListener('click', event => {
    const row = event.target.closest('.drill-head');
    if (!row) return;
    const key = row.dataset.key;
    if (expandedRows.has(key)) expandedRows.delete(key); else expandedRows.add(key);
    renderPipeline(false);
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
    // Below a chart point is the axis row and then the legend, so points
    // prefer to open upwards; everything else keeps the old preference.
    const inChart = Boolean(element.closest && element.closest('.linechart-plot'));
    const below = anchor.bottom + 9;
    const above = anchor.top - box.height - 9;
    const fitsAbove = above >= 12;
    const fitsBelow = below + box.height <= window.innerHeight - 12;
    popover.style.left = `${left}px`;
    popover.style.top = `${(inChart && fitsAbove) || !fitsBelow
      ? Math.max(12, above) : below}px`;
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
const VIEW_SEARCH = {payouts: 'personSearch', pipeline: 'pipelineSearch'};

function syncSearch(viewName) {
  const target = VIEW_SEARCH[viewName];
  const box = byId('globalSearch');
  box.closest('.search').classList.toggle('is-off', !target);
  box.disabled = !target;
  box.placeholder = target ? (viewName === 'payouts' ? 'Search a person, team or manager' : 'Search a task, owner or failed stage') : 'Search is available on Payouts and Pipeline';
  box.value = target ? byId(target).value : '';
}

function init() {
  renderHero();
  renderTopPendingCards();
  renderDonut();
  renderBenchCards();
  populateFilters();
  renderTrainerRows();
  renderTeams();
  renderPipeline();
  renderPlan();
  renderThroughput();
  renderDailyDelta();
  wireEvents();
  applyRange();
  switchView(location.hash.slice(1) || 'command', false);
  loadPayoutLedger();
  loadClientAcceptance();
  loadHarborConsole();
  loadConsoleLive();
  loadGcsPipeline();
}

init();
