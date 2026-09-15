const data = window.OPS_REVIEW_DATA;
let finalisationSource = null;
let finalisationRows = [];
let finalisationCohorts = [];
const FINALISATION_ROW_CAP = 400;
let gcsPipeline = null;
let payoutLedger = null;
let payoutLedgerTasks = [];
let clientAcceptance = null;
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
  ownership: 'Owners are joined to tasks by declared task name against the trainer records in the bucket. Finalisation repackages archives, so an archive digest never matches the trainer record digest and the name is the only join available - it is evidence, not proof. Where two trainer records claim the same name the task is left contested rather than assigned.',
  pipeline: 'The ledger stores only six raw states and none of them is accepted or rejected; those come from the verdict recorded on the submission, which wins over the raw state. Done means the evaluation finished with no verdict at all, so Done is not an acceptance. Infrastructure Error means the run failed on tooling, not on the work. Current counts the latest attempt per family; All attempts counts retries separately.',
  dates: 'Filters records by their recorded date, inclusive at both ends, and either end can be left empty. Records with no date are excluded as soon as a date is set. Status counts and the table use the same filter. Payout figures are untouched.',
  workbook: 'A workbook-wide snapshot with no reliable person-level allocation, so it does not respond to the filters on the other tabs and cannot be split by trainer.',
};

function renderEverything() {
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams(); renderPipeline();
  renderFinalisation();
  renderBenchCards();
}

function renderFinalisation() {
  if (!finalisationRows.length) return;
  const filters = {
    outcome: byId('finalisationOutcome').value,
    cohort: byId('finalisationCohort').value,
    bench: byId('finalisationBench').value,
    ownership: byId('finalisationOwnership').value,
    type: byId('finalisationType').value,
    domain: byId('finalisationDomain').value,
    search: byId('finalisationSearch').value,
    start: byId('finalisationStart').value,
    end: byId('finalisationEnd').value,
    duplicates: byId('duplicateFilter').value,
  };
  const result = window.filterFinalisation(finalisationRows, filters);
  const rows = result.rows;
  const domainSelect = byId('finalisationDomain');
  const domains = [...new Set(result.population.map(row => row.filterDomain))].sort();
  if (filters.domain && !domains.includes(filters.domain)) domains.push(filters.domain);
  domainSelect.innerHTML = '<option value="">All domains</option>' + domains.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  domainSelect.value = filters.domain;
  byId('finalisationDateError').hidden = !result.invalidDates;
  ['finalisationStart', 'finalisationEnd'].forEach(id => byId(id).setAttribute('aria-invalid', String(result.invalidDates)));
  byId('finalisationSummary').innerHTML = [
    ['Folders shown', rows.length], ['Distinct tasks shown', result.tasks],
    ['Roster-linked folders', result.linked], ['Cross-cohort repeats shown', result.duplicates]
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${fmt(value)}</strong></div>`).join('');
  const cohorts = finalisationCohorts.filter(cohort => !filters.outcome || cohort.outcome === filters.outcome);
  const counted = cohorts.reduce((total, cohort) => total + cohort.tasks, 0);
  const unscanned = cohorts.filter(cohort => cohort.tasks && !cohort.scanned);
  setText('finalisationAudit', `${fmt(rows.length)} of ${fmt(result.population.length)} scanned folders shown / ${fmt(result.tasks)} distinct task names / ${fmt(result.duplicates)} folders repeat a task already counted in another cohort / ${fmt(result.conflicts)} contested owners${unscanned.length ? ` / counted but not itemised: ${unscanned.map(cohort => `${cohort.label} ${fmt(cohort.tasks)}`).join(', ')}` : ''} / cohort totals ${fmt(counted)} tasks`);
  const shown = rows.slice(0, FINALISATION_ROW_CAP);
  byId('finalisationRows').innerHTML = shown.map(row => `<tr>
      <td><div class="person"><strong>${esc(row.displayName)}</strong><span>${esc(row.folder)}${row.archives > 1 ? ` / ${fmt(row.archives)} archives` : ''}</span></div></td>
      <td data-outcome="${esc(row.outcome)}"><span class="tag">${esc(row.cohortLabel)}</span><small>${esc(row.outcome)}</small></td>
      <td>${esc(row.trainer?.name || (row.ownership === 'conflict' ? 'Contested' : 'Unassigned'))}<br><small>${esc(row.trainer?.email || row.owner || (row.ownership === 'conflict' ? 'More than one trainer record claims this task' : 'No trainer record'))}</small></td>
      <td>${esc({linked:'Roster-linked',unlinked:'Owner recorded, not roster-linked',missing:'Owner not recorded',conflict:'Conflicting owners'}[row.ownership])}<br><small>${esc(row.attribution)}</small></td>
      <td>${esc(row.filterType)}${row.connector_provenance ? `<br><small>${esc(row.connector_provenance)}</small>` : ''}</td>
      <td><span class="tag" data-domain="${esc(row.filterDomain)}">${esc(row.filterDomain)}</span></td>
      <td>${esc(row.date || 'Not recorded')}</td>
      <td><span class="pill ${row.duplicate ? 'is-warn' : 'is-ok'}">${row.duplicate ? 'Repeat' : 'Counted'}</span>${row.groupSize > 1 ? `<div class="muted">${fmt(row.groupSize)} cohorts: ${esc(row.cohortsForTask.join(', '))}</div>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No folders match this selection.</td></tr>';
  byId('finalisationTruncated').hidden = shown.length === rows.length;
  setText('finalisationTruncated', `Showing the first ${fmt(shown.length)} of ${fmt(rows.length)} matching folders. Filter further to narrow the list; every card and audit number above counts all ${fmt(rows.length)}.`);
}

function loadFinalisation() {
  const button = byId('refreshFinalisation');
  button.disabled = true;
  if (!gcsPipeline?.finalisation) {
    setText('finalisationStatus', 'Finalisation is published inside the GCS export. Refresh the pipeline snapshot to load it.');
    button.disabled = false;
    return;
  }
  try {
    finalisationSource = gcsPipeline.finalisation;
    finalisationRows = window.prepareFinalisation(finalisationSource, data.trainers);
    finalisationCohorts = finalisationSource.cohorts;
  } catch (error) {
    setText('finalisationStatus', `Finalisation export rejected: ${error.message}`);
    button.disabled = false;
    return;
  }
  const outcomes = byId('finalisationOutcome'), chosen = outcomes.value || 'accepted';
  const labels = {accepted: 'Accepted', rejected: 'Rejected', unsubmitted: 'Unsubmitted', promoted: 'Handshake promoted'};
  const present = [...new Set(finalisationCohorts.map(cohort => cohort.outcome))];
  outcomes.innerHTML = present.map(value => `<option value="${esc(value)}">${esc(labels[value] || value)}</option>`).join('') + '<option value="">All outcomes</option>';
  outcomes.value = present.includes(chosen) ? chosen : '';
  const select = byId('finalisationCohort'), selected = select.value;
  select.innerHTML = '<option value="">All cohorts</option>' + finalisationCohorts
    .map(cohort => `<option value="${esc(cohort.prefix)}">${esc(cohort.label)} (${fmt(cohort.tasks)})</option>`).join('');
  select.value = finalisationCohorts.some(cohort => cohort.prefix === selected) ? selected : '';
  const totals = finalisationSource.totals;
  setText('finalisationStatus', `Read-only scan of ${finalisationSource.bucket} at ${gcsPipeline.generatedAt} / ${fmt(finalisationCohorts.length)} cohorts / accepted ${fmt(totals.accepted)}, rejected ${fmt(totals.rejected)}, unsubmitted ${fmt(totals.unsubmitted)} / ${fmt(finalisationSource.tasks.length)} accepted folders opened for task metadata`);
  renderFinalisation();
  button.disabled = false;
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
  renderHero();
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
  renderHero(); renderTopPendingCards(); renderBenchCards();
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
      populateFilters(); renderPipeline(); renderDonut(); loadFinalisation(); renderTrainerRows();
    renderHero(); renderTopPendingCards(); renderBenchCards();
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

const VIEWS = ['command', 'payouts', 'delivery', 'pipeline', 'finalisation'];
// The same status is the same colour in the donut, the cards and the table.
const STATUS_TOKENS = {
  Accepted: '--aqua', Done: '--blue', 'Waiting For Trainer Edit': '--yellow',
  'Infrastructure Error': '--orange', Rejected: '--red', 'Conflicting verdict': '--magenta',
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
  if (byId('globalSearch')) syncSearch(viewName);
  if (push && location.hash.slice(1) !== viewName) history.pushState({viewName}, '', `#${viewName}`);
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function commandSnapshot() {
  const folders = finalisationRows;
  // One task can be finalised into several cohorts; the accepted count is task names, not folders.
  const tasks = new Set(folders.map(row => row.name));
  return {
    ready: Boolean(finalisationRows.length && gcsPipeline),
    folders,
    tasks,
    current: gcsPipeline?.current || [],
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

  setText("metricAccepted", snapshot.ready ? fmt(snapshot.tasks.size) : '-');
  const v2 = (gcsPipeline?.finalisation?.cohorts || []).find(cohort => cohort.prefix === 'finalisation_client_qc_accepted_iteration_2');
  setText('metricClientAccepted', clientAcceptance ? fmt(clientAcceptance.accepted) : '-');
  setText('metricClientAcceptedNote', clientAcceptance
    ? `Priority Low of ${fmt(clientAcceptance.tasks)} audited tasks${clientAcceptance.live ? '' : ' / saved snapshot'}`
    : 'Harbor 240 dashboard unavailable');
  setText('metricV2Accepted', v2 ? fmt(v2.tasks) : '-');
  setText('metricV2AcceptedNote', v2 ? 'Folders in the client QC accepted iteration 2 cohort' : 'Bucket scan not loaded');
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

const PIPELINE_FILTERS = [
  {id: 'pipelineFilter', label: 'statuses', of: task => task.status || 'Unknown'},
  {id: 'pipelineType', label: 'types', of: task => pipelineType(task)},
  {id: 'pipelineDomainFilter', label: 'domains', of: task => pipelineDomain(task)},
  {id: 'pipelineTrainer', label: 'trainers', of: task => task.trainer || 'Unattributed'},
];

function pipelinePopulation() {
  return gcsPipeline ? gcsPipeline[byId('pipelineMode').value] || [] : [];
}

function filteredPipelineTasks() {
  const start = byId('pipelineStart').value;
  const end = byId('pipelineEnd').value;
  const search = byId('pipelineSearch').value.trim().toLowerCase();
  if (start && end && start > end) return [];
  const chosen = PIPELINE_FILTERS.map(filter => [filter, byId(filter.id).value]).filter(([, value]) => value);
  return pipelinePopulation().filter(task => {
    if (!chosen.every(([filter, value]) => filter.of(task) === value)) return false;
    if (search && ![task.task, task.taskId, task.trainer].join(' ').toLowerCase().includes(search)) return false;
    if (!start && !end) return true;
    return /^\d{4}-\d{2}-\d{2}$/.test(task.date) && (!start || task.date >= start) && (!end || task.date <= end);
  });
}

function renderPipeline(resetPage = true) {
  if (resetPage) pipelinePage = 0;
  if (gcsPipeline) {
    const mode = byId('pipelineMode').value;
    const description = mode === 'current' ? 'Latest cycle per owner and task family; unevaluated uploads excluded.' : mode === 'historical' ? 'All recorded evaluation cycles; retries count separately.' : 'Legacy QC runs from archived owner snapshots; Done is not an acceptance verdict.';
    setText('pipelineSourceStatus', `GCS export: ${gcsPipeline.generatedAt} / ${description}`);
  }
  const invalid = Boolean(byId('pipelineStart').value && byId('pipelineEnd').value && byId('pipelineStart').value > byId('pipelineEnd').value);
  byId('pipelineDateError').hidden = !invalid;
  byId('pipelineStart').setAttribute('aria-invalid', String(invalid));
  byId('pipelineEnd').setAttribute('aria-invalid', String(invalid));
  const allTasks = filteredPipelineTasks();
  const statuses = Object.entries(
    allTasks.reduce((acc, task) => {
      const key = task.status || "Unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  byId("pipelineStats").innerHTML = statuses
    .map(([status, count]) => `<article class="status-card" data-status="${esc(status)}"><span>${esc(status)}</span><strong>${fmt(count)}</strong></article>`)
    .join("") || '<p class="empty">No records match these filters.</p>';
  renderPipelineTimeline(allTasks, statuses);
  renderPipelineRows(allTasks);
}

function renderPipelineTimeline(rows, statuses) {
  // Volume per day, split by status: a stacked column, because the question is
  // how much work landed each day and what happened to it.
  const dated = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  const byDate = new Map();
  dated.forEach(row => {
    if (!byDate.has(row.date)) byDate.set(row.date, new Map());
    const day = byDate.get(row.date);
    const key = row.status || 'Unknown';
    day.set(key, (day.get(key) || 0) + 1);
  });
  const days = [...byDate.keys()].sort();
  const order = statuses.map(([status]) => status);
  const tallest = Math.max(...days.map(day => [...byDate.get(day).values()].reduce((total, value) => total + value, 0)), 1);
  byId('pipelineTimeline').innerHTML = days.length ? `
    <figcaption>${fmt(dated.length)} dated records across ${fmt(days.length)} days${dated.length === rows.length ? '' : ` / ${fmt(rows.length - dated.length)} undated records not plotted`}</figcaption>
    <div class="timeline-plot">
      ${days.map(day => {
        const counts = byDate.get(day);
        const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
        return `<div class="timeline-day">
          <div class="timeline-total">${fmt(total)}</div>
          <div class="timeline-column" style="height:${Math.max((total / tallest) * 100, 1.5)}%">
            ${order.filter(status => counts.get(status)).map(status =>
              `<span class="timeline-seg" data-status="${esc(status)}" style="flex:${counts.get(status)}" data-tip="${esc(day)} / ${esc(status)}: ${fmt(counts.get(status))} of ${fmt(total)} records"></span>`).join('')}
          </div>
          <div class="timeline-date">${esc(day.slice(5))}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="chart-key">${order.map(status =>
      `<span class="key-item" data-status="${esc(status)}"><i></i>${esc(status)}</span>`).join('')}</div>` :
    '<p class="empty">No dated records in this selection.</p>';
}

function renderPipelineRows(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / 100));
  pipelinePage = Math.min(pipelinePage, pages - 1);
  setText('pipelinePage', `${fmt(rows.length)} records / Page ${pipelinePage + 1} of ${pages}`);
  byId('pipelinePrevious').disabled = pipelinePage === 0;
  byId('pipelineNext').disabled = pipelinePage >= pages - 1;
  byId("pipelineRows").innerHTML = rows
    .slice(pipelinePage * 100, (pipelinePage + 1) * 100)
    .map(
      (task) => `
        <tr>
          <td>${esc(task.date || "-")}</td>
          <td>${esc(task.task)}<div class="muted">${esc(task.taskId || '')}</div></td>
          <td>${esc(task.trainer || "-")}</td>
          <td>${esc(pipelineType(task))}</td>
          <td><span class="tag" data-domain="${esc(pipelineDomain(task))}">${esc(pipelineDomain(task))}</span></td>
          <td><span class="pill" data-status="${esc(task.status || 'Unknown')}">${esc(task.status || "Unknown")}</span></td>
        </tr>
      `,
    )
    .join("") || '<tr><td colspan="6" class="empty">No pipeline records match these filters.</td></tr>';
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
  if (!benches.length || !dates.length) {
    byId('planCharts').innerHTML = '<p class="empty">No daily plan recorded in the workbook.</p>';
    return;
  }
  const cells = bench => bench.dates.map((day, index) => {
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
        <thead><tr><th scope="col">Bench</th>${dates.map(day => `<th scope="col">${esc(day.slice(5))}</th>`).join('')}</tr></thead>
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
      const planned = bench.plan.reduce((total, value) => total + (Number(value) || 0), 0);
      const done = bench.actual.reduce((total, value) => total + (Number(value) || 0), 0);
      return `${esc(bench.bench)}: ${fmt(done)} of ${fmt(planned)} planned tasks delivered (${Math.round((done / (planned || 1)) * 100)}%)`;
    }).join(' / ')}</p>`;
}

function wireEvents() {
  byId('pipelinePrevious').addEventListener('click',()=>{pipelinePage--;renderPipeline(false);});
  byId('pipelineNext').addEventListener('click',()=>{pipelinePage++;renderPipeline(false);});
  byId('refreshGcsPipeline').addEventListener('click', refreshGcsPipeline);
  byId('pipelineMode').addEventListener('change', () => { populateFilters(); renderPipeline(); renderDonut(); });
  const finalisationFilters = ['finalisationBench','finalisationOwnership','duplicateFilter','finalisationType','finalisationDomain','finalisationStart','finalisationEnd','finalisationCohort'];
  [...finalisationFilters, 'finalisationOutcome'].forEach(id=>byId(id).addEventListener('change',renderFinalisation));
  byId('finalisationSearch').addEventListener('input', renderFinalisation);
  byId('resetFinalisationFilters').addEventListener('click', () => {
    [...finalisationFilters, 'finalisationSearch'].forEach(id => byId(id).value = '');
    byId('finalisationOutcome').value = 'accepted';
    renderFinalisation();
  });
  byId('refreshFinalisation').addEventListener('click',loadFinalisation);
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
  const pipelineControls = [...PIPELINE_FILTERS.map(filter => filter.id), 'pipelineStart', 'pipelineEnd'];
  pipelineControls.forEach(id => byId(id).addEventListener('change', () => renderPipeline()));
  byId('pipelineSearch').addEventListener('input', () => renderPipeline());
  byId('clearPipelineDates').addEventListener('click', () => {
    [...pipelineControls, 'pipelineSearch'].forEach(id => byId(id).value = '');
    populateFilters();
    renderPipeline();
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
const VIEW_SEARCH = {payouts: 'personSearch', finalisation: 'finalisationSearch'};

function syncSearch(viewName) {
  const target = VIEW_SEARCH[viewName];
  const box = byId('globalSearch');
  box.closest('.search').classList.toggle('is-off', !target);
  box.disabled = !target;
  box.placeholder = target ? (viewName === 'payouts' ? 'Search a person, team or manager' : 'Search a task, folder or owner') : 'Search is available on Payouts and Finalisation';
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
  wireEvents();
  renderEverything();
  switchView(location.hash.slice(1) || 'command', false);
  loadPayoutLedger();
  loadClientAcceptance();
  loadGcsPipeline();
}

init();
