const data = window.OPS_REVIEW_DATA;
let finalisationSource = null;
let finalisationRows = [];
let gcsPipeline = null;
let pipelinePage = 0;
const filterKeys = {teamFilter: 'team', leaderFilter: 'em', managerFilter: 'managerName', trainerFilter: 'email'};
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
function enrichFinalisationOwners() {
  if (!gcsPipeline || !finalisationRows.length) return 0;
  if (finalisationSource) finalisationRows = window.reconcileFinalisation(finalisationSource, data.trainers);
  const roster = new Map(data.trainers.map(trainer => [trainer.email.toLowerCase(), trainer]));
  const ownersByTask = new Map();
  ['current', 'historical', 'legacy'].forEach(scope => (gcsPipeline[scope] || []).forEach(record => {
    const task = acceptedMatchKey(record.task || record.taskId);
    const email = String(record.trainer || '').toLowerCase();
    if (!task || !email) return;
    if (!ownersByTask.has(task)) ownersByTask.set(task, new Set());
    ownersByTask.get(task).add(email);
  }));
  (gcsPipeline.trainerRecords || []).forEach(record => {
    const task = acceptedMatchKey(record.task || record.taskName);
    const email = String(record.trainer || record.ownerEmail || '').toLowerCase();
    if (!task || !email) return;
    if (!ownersByTask.has(task)) ownersByTask.set(task, new Set());
    ownersByTask.get(task).add(email);
  });
  let enriched = 0;
  finalisationRows = finalisationRows.map(row => {
    if (row.trainer || row.owner_contested || row.owner) return row;
    const candidates = [...(ownersByTask.get(acceptedMatchKey(row.declared_name || row.folder)) || [])];
    if (candidates.length !== 1 || !roster.has(candidates[0])) return row;
    enriched += 1;
    return {...row, trainer: roster.get(candidates[0]), attribution: 'Name match only', owner_source: 'GCS task-name candidate from evaluation/history/trainer records'};
  });
  return enriched;
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
  finalisation: 'The headline cards show the Harbor Finalisation source only: accepted folders, distinct task names, roster-linked folders, and unresolved owner folders. The duplicate audit below compares that source with current GCS Accepted records. Payouts counts each reconciled task group once.',
  duplicates: 'Duplicate records are accepted source records that belong to a task group already represented by another Finalisation or current Accepted record. They remain visible for audit, while accepted and payout totals count the group once. Conflicting owner groups are not assigned to a person.',
  dates: 'Filters Pipeline records by the workbook Date column, including both start and end dates. Either date can be left blank for an open-ended range. Undated records are excluded when a date is selected. Status counts and rows use the same filters. Payout calculations are unaffected.',
  bench: 'Company bench includes the Company team. Computer bench includes Computer A and Computer B. Other or missing teams appear under Unassigned bench. This payout-only filter combines with team, leader, manager, trainer, search and payment state. Totals sum the matching person records without changing payment formulas.',
  accepted: 'Command snapshot accepted tasks: sum of the Trainers tab v2 total accepted column for the selected people. This is separate from the Payouts view.',
  payoutAccepted: 'Payouts accepted tasks: the deduplicated union of accepted Finalisation folders and current GCS Accepted records. Matching task names are counted once; unresolved owners are not assigned to trainers.',
  payoutTotals: 'Paid tasks is the sum of Total Tasks Approved from the Paid Out tab for the people currently shown. Paid amount is the corresponding Total Payment Amount. Accepted and pending tasks come from the reconciled Finalisation/current GCS owner data. Filters update these totals.',
  paid: 'Paid tasks use the larger of the Trainers paid-out count and the matching paid out tab approved count, joined by email. Displayed paid amount = paid tasks x $300. This is the draft payment model, not a bank-confirmed transaction total.',
  pending: 'Estimated pending tasks = max(v2 accepted tasks - paid tasks, 0), calculated separately for each person. Estimated pending amount = pending tasks x $300. Totals sum these person-level values; paid tasks can exceed current v2 accepted tasks.',
  active: 'Count of selected trainer records whose workbook status is Active. The smaller total includes every status.',
  pipeline: 'GCS trainer evaluation ledgers and legacy history snapshots. Current counts the latest cycle per owner and family; it excludes uploads never evaluated. History counts cycles, including retries. Legacy counts archived QC runs separately. These populations overlap and must not be added. Accepted requires an explicit submission verdict. Trainer filters join owner email to the roster. Type uses the workbook pipeline mapping when available, with conservative task-name inference for newer GCS-only records. Domain is derived from the task-name prefix. The chart follows the selected Pipeline view.',
  daily: 'Accepted in the last 24 hours as recorded in the workbook snapshot, not a live rolling window.',
  workbook: 'Workbook-wide snapshot. These source summaries do not contain a reliable person-level allocation and do not change with the review filters.'
};

function scopedTrainers(exclude) {
  return data.trainers.filter(row => Object.entries(filterKeys).every(([id,key]) => id === exclude || !byId(id).value || (row[key] || 'Unassigned') === byId(id).value));
}
function scopedTasks() {
  const all = gcsPipeline ? gcsPipeline[byId('pipelineMode').value] : [];
  if (!Object.keys(filterKeys).some(id => byId(id).value)) return all;
  const emails = new Set(scopedTrainers().map(row => row.email.toLowerCase()));
  return all.filter(task => emails.has(task.trainer.toLowerCase()));
}
function refreshScope() {
  populateScopeFilters();
  setText('filterCount', `${fmt(scopedTrainers().length)} of ${fmt(data.trainers.length)} trainers`);
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams(); renderPipeline();
  renderFinalisation();
}

function renderFinalisation() {
  if (!finalisationSource) return;
  const scope = new Set(scopedTrainers().map(row => row.email));
  const hasScope = Object.keys(filterKeys).some(id => byId(id).value);
  const bench = byId('finalisationBench').value;
  const ownership = byId('finalisationOwnership').value;
  const duplicateFilter = byId('duplicateFilter').value;
  const audit = acceptedReconciliation();
  const sourceRows = audit.rows.filter(row => row.source === 'Finalisation');
  const scopedSource = sourceRows.filter(row => {
    const team = row.trainer?.team;
    const rowBench = team === 'Company' ? 'company' : ['Computer A','Computer B'].includes(team) ? 'computer' : 'unassigned';
    return (!hasScope || (row.trainer && scope.has(row.trainer.email))) && (!bench || bench === rowBench) && (!ownership || row.attribution === ownership);
  });
  const scoped = duplicateFilter === 'duplicates' || duplicateFilter === 'groups'
    ? audit.rows.filter(row => {
      const team = row.trainer?.team;
      const rowBench = team === 'Company' ? 'company' : ['Computer A','Computer B'].includes(team) ? 'computer' : 'unassigned';
      return (!hasScope || (row.trainer && scope.has(row.trainer.email))) && (!bench || bench === rowBench) && (!ownership || row.attribution === ownership);
    })
    : scopedSource;
  const rows = scoped.filter(row => !duplicateFilter || (duplicateFilter === 'duplicates' ? row.duplicate : duplicateFilter === 'groups' ? row.groupSize > 1 : !row.duplicate));
  const sourceDistinct = new Set(scopedSource.map(row => String(row.declared_name || row.folder || '').toLowerCase().trim().replace(/^harbor\//, '')));
  const sourceUnresolved = scopedSource.filter(row => row.domain == null).length;
  const auditGroups = new Set(scoped.map(row => row.countedId));
  byId('finalisationSummary').innerHTML = [
    ['Accepted folders', scopedSource.length], ['Distinct task names', sourceDistinct.size],
    ['Roster-linked folders', scopedSource.length - sourceUnresolved], ['Unresolved owner folders', sourceUnresolved]
  ].map(([label,value])=>`<div class="summary-item"><span>${label}</span><strong>${fmt(value)}</strong></div>`).join('');
  const duplicateCount = audit.rows.filter(row => row.duplicate).length;
  const conflictCount = audit.groups.filter(group => auditGroups.has(group.id) && group.conflict).length;
  setText('finalisationAudit', `Reconciliation audit: ${fmt(audit.groups.length)} unique task groups / ${fmt(duplicateCount)} duplicate records excluded from counts / ${fmt(conflictCount)} ownership conflicts.`);
  byId('finalisationRows').innerHTML = rows.map(row=>`<tr><td><div class="person"><strong>${esc(row.displayName)}</strong><span>${esc(row.source)} / ${esc(row.folder)}</span></div></td><td>${esc(row.trainer?.name || row.email || row.owner || 'Not recorded')}</td><td>${esc(row.trainer?.team || 'Unassigned')}</td><td>${esc(row.conflict ? 'Conflicting owners - excluded from person totals' : row.attribution)}<br><small>${esc(row.owner_source || '')}</small></td><td>${esc(row.source === 'Finalisation' ? (row.is_connector ? 'Connector' : 'Non-connector') : pipelineType(row))}</td><td>${esc(row.date)}</td><td><span class="pill">${row.duplicate ? 'Duplicate - excluded' : 'Counted once'}</span><div class="muted">${fmt(row.groupSize)} records in group</div>${row.duplicate ? `<small>Counted record: ${esc(row.countedId)}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No accepted records match these filters.</td></tr>';
}

async function loadFinalisation() {
  const button = byId('refreshFinalisation');
  button.disabled = true;
  setText('finalisationStatus', 'Refreshing Harbor finalisation...');
  let source, fallback = false;
  try {
    const response = await fetch('https://rahuls17-cell.github.io/harbor-pipeline-dashboard/', {cache:'no-store',signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('Source unavailable');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    source = JSON.parse(doc.getElementById('pipeline-data').textContent);
    finalisationRows = window.reconcileFinalisation(source, data.trainers);
  } catch {
    fallback = true;
    try {
      const response = await fetch('assets/finalisation.json', {cache:'no-store'});
      if (!response.ok) throw new Error('Snapshot unavailable');
      source = await response.json();
      finalisationRows = window.reconcileFinalisation(source, data.trainers);
    } catch {
      setText('finalisationStatus', finalisationSource ? 'Refresh failed. Previous finalisation snapshot remains displayed.' : 'Finalisation data unavailable. Retry refresh.');
      button.disabled = false;
      return;
    }
  }
  finalisationSource = source;
  enrichFinalisationOwners();
  setText('finalisationStatus', `${fallback ? 'Saved snapshot (live source unavailable)' : 'Connected to Harbor'} / Scanned ${source.generated_at} / ${fmt(finalisationRows.length)} accepted iteration-2 folders`);
  setText('payoutSourceStatus', 'Accepted sync is reconciling Finalisation with the current GCS Accepted snapshot / Paid synced from the paid out tab');
  renderFinalisation();
  renderTrainerRows();
  button.disabled = false;
}

async function loadGcsPipeline(manual = false) {
  try {
    const response = await fetch(`assets/gcs-pipeline.json?refresh=${manual ? Date.now() : 'startup'}`, {cache:'no-store'});
    if (!response.ok) throw new Error('GCS export unavailable');
    const payload = await response.json();
    if (![1, 2].includes(payload.schemaVersion) || !['current','historical','legacy'].every(key=>Array.isArray(payload[key]))) throw new Error('Invalid GCS export');
    ['current', 'historical', 'legacy'].forEach(key => payload[key].forEach(task => { task.domain = pipelineDomain(task); }));
    gcsPipeline = payload;
    enrichFinalisationOwners();
    populateFilters(); renderPipeline(); renderDonut(); renderFinalisation(); renderTrainerRows();
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
function populateScopeFilters() {
  const labels = {teamFilter:'teams',leaderFilter:'leaders',managerFilter:'managers',trainerFilter:'trainers'};
  Object.entries(filterKeys).forEach(([id,key]) => {
    const select = byId(id), selected = select.value;
    const options = new Map(scopedTrainers(id).map(row => [row[key] || 'Unassigned', id === 'trainerFilter' ? `${row.name || row.email} (${row.email})` : row[key] || 'Unassigned']));
    select.innerHTML = `<option value="">All ${labels[id]}</option>` + [...options].sort((a,b)=>a[1].localeCompare(b[1])).map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
    select.value = options.has(selected) ? selected : '';
  });
}

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

function switchView(viewName) {
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("is-active", view.id === `view-${viewName}`);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHero() {
  const rows = scopedTrainers();
  const summary = {paidAmount:sum(rows,'paidAmount'),pendingAmount:sum(rows,'pendingAmount'),pendingTasks:sum(rows,'pendingTasks'),acceptedTasks:sum(rows,'acceptedTasks'),activeTrainers:rows.filter(r=>r.status.toLowerCase()==='active').length,totalTrainers:rows.length};
  const generated = new Date(data.meta.generatedAt);
  const paid = summary.paidAmount;
  const pending = summary.pendingAmount;
  const totalExposure = paid + pending;
  const paidPct = Math.round((paid / (totalExposure || 1)) * 100);

  setText("generatedAt", generated.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  setText("sourceName", data.meta.sourceWorkbook.split("\\").pop());
  setText("heroPending", money(pending));
  setText("heroExposureText", `${paidPct}% paid / ${fmt(summary.pendingTasks)} tasks pending`);
  byId("heroPaidMeter").style.width = `${paidPct}%`;

  setText("metricAccepted", fmt(summary.acceptedTasks));
  setText("metricPaid", money(paid));
  setText("metricPendingTasks", fmt(summary.pendingTasks));
  setText("metricPending", `${money(pending)} pending`);
  setText("metricActive", fmt(summary.activeTrainers));
  setText("metricRoster", `${fmt(summary.totalTrainers)} total trainer records`);
}

function renderTopPendingCards() {
  const rows = [...scopedTrainers()]
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
  const entries = Object.entries(groupBy(scopedTasks(), row => row.status)).map(([key,rows])=>[key,rows.length]).sort((a,b)=>b[1]-a[1]);
  const total = entries.reduce((sumValue, [, value]) => sumValue + value, 0);
  const statusColors = {Accepted:'#16866a',Rejected:'#bd4a50',Error:'#d18a2c',Failed:'#874b66',Running:'#0071e3',Queued:'#8b8b93'};
  const colors = entries.map(([status]) => statusColors[status] || '#8b8b93');
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
  byId("benchCards").innerHTML = data.rollup
    .map(
      (section) => `
        <div class="bench-card">
          <h3>${section.name}</h3>
          ${section.metrics
            .slice(0, 4)
            .map((metric) => `<div class="bench-metric"><span>${metric.label}</span><b>${fmt(metric.value)}</b></div>`)
            .join("")}
        </div>
      `,
    )
    .join("");
}

function uniqueTeams() {
  return [...new Set(data.trainers.map((trainer) => trainer.team || "Unassigned"))].sort();
}

function populateFilters() {
  populateScopeFilters();

  const statuses = [
    ...new Set((gcsPipeline ? gcsPipeline[byId('pipelineMode').value] : []).map((task) => task.status || "Unknown")),
  ].sort();
  byId("pipelineFilter").innerHTML =
    `<option value="">All statuses</option>` +
    statuses.map((status) => `<option value="${status}">${status}</option>`).join("");
}

function filteredTrainers() {
  const search = byId("personSearch").value.trim().toLowerCase();
  const payment = byId('paymentFilter').value;
  const bench = byId('benchFilter').value;
  return payoutRows()
    .filter(row => !bench || (row.team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(row.team) ? 'computer' : 'unassigned') === bench)
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

function acceptedReconciliation() {
  const acceptedByEmail = new Map();
  const roster = new Map(data.trainers.map(row => [row.email.toLowerCase(), row]));
  const records = finalisationRows.map(row => ({...row, id: `finalisation:${row.folder}`,
    source: 'Finalisation', name: row.declared_name || row.folder,
    email: row.trainer?.email?.toLowerCase(), contested: row.owner_contested,
    displayName: row.declared_short || row.folder, date: (row.updated || '').slice(0, 10)}));
  (gcsPipeline?.current || []).filter(row => row.status === 'Accepted').forEach(row => {
    const email = String(row.trainer || '').trim().toLowerCase();
    records.push({...row, id: `current:${row.ownerKey}:${row.id}`, source: 'Current pipeline',
      name: row.task, displayName: row.task || row.taskId, folder: row.taskId,
      email, trainer: roster.get(email), attribution: 'GCS evaluation owner'});
  });
  const audit = window.reconcileAcceptedTasks(records);
  audit.groups.forEach(group => {
    if (roster.has(group.email)) acceptedByEmail.set(group.email, (acceptedByEmail.get(group.email) || 0) + 1);
  });
  return {
    ...audit,
    acceptedByEmail,
    unifiedFolders: audit.groups.length,
    rosterLinked: [...acceptedByEmail.values()].reduce((total, count) => total + count, 0),
  };
}

function payoutRows() {
  const acceptedByEmail = acceptedReconciliation().acceptedByEmail;
  const paidByEmail = new Map((data.paidOut || []).map(row => [String(row.email || '').toLowerCase(), row]));
  return scopedTrainers().map(row => {
    const paid = paidByEmail.get(row.email.toLowerCase());
    const acceptedTasks = finalisationSource || gcsPipeline ? (acceptedByEmail.get(row.email.toLowerCase()) || 0) : row.acceptedTasks;
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
  const reconciliation = acceptedReconciliation();
  setText('payoutSourceStatus', `Accepted: ${fmt(reconciliation.unifiedFolders)} unique task groups / ${fmt(reconciliation.duplicateCount)} duplicate records excluded / Paid: paid out tab`);
}

function renderTrainerRows() {
  const rows = filteredTrainers();
  renderPayoutSummary(rows);
  byId("trainerRows").innerHTML = rows
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
  const teams = Object.entries(groupBy(scopedTrainers(), (trainer) => trainer.team)).sort(
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

function filteredPipelineTasks() {
  const start = byId('pipelineStart').value;
  const end = byId('pipelineEnd').value;
  const status = byId('pipelineFilter').value;
  if (start && end && start > end) return [];
  return scopedTasks().filter(task => {
    if (status && (task.status || 'Unknown') !== status) return false;
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
    .map(([status, count]) => `<article class="status-card"><span>${status}</span><strong>${fmt(count)}</strong></article>`)
    .join("");
  renderPipelineRows(allTasks);
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
          <td>${esc(pipelineDomain(task))}</td>
          <td><span class="pill">${esc(task.status || "Unknown")}</span></td>
        </tr>
      `,
    )
    .join("") || '<tr><td colspan="6" class="empty">No pipeline records match these filters.</td></tr>';
}

function renderPlan() {
  byId("planCharts").innerHTML = data.plan
    .map((bench) => {
      const max = Math.max(...bench.plan, ...bench.actual, 1);
      const rows = bench.dates
        .map((day, index) => {
          const plan = bench.plan[index] || 0;
          const actual = bench.actual[index] || 0;
          return `
            <div class="plan-day">
              <strong>${day.slice(5) || "-"}</strong>
              <div class="plan-pair">
                <div class="thin-bar plan"><span style="width:${safePct(plan, max)}"></span></div>
                <div class="thin-bar actual"><span style="width:${safePct(actual, max)}"></span></div>
              </div>
              <span>${fmt(actual)} / ${fmt(plan)}</span>
            </div>
          `;
        })
        .join("");
      return `<div class="plan-chart"><h3>${bench.bench}</h3><div class="chart-bars">${rows}</div></div>`;
    })
    .join("");
}


function wireEvents() {
  byId('pipelinePrevious').addEventListener('click',()=>{pipelinePage--;renderPipeline(false);});
  byId('pipelineNext').addEventListener('click',()=>{pipelinePage++;renderPipeline(false);});
  byId('refreshGcsPipeline').addEventListener('click', refreshGcsPipeline);
  byId('pipelineMode').addEventListener('change', () => { populateFilters(); renderPipeline(); renderDonut(); });
  ['finalisationBench','finalisationOwnership','duplicateFilter'].forEach(id=>byId(id).addEventListener('change',renderFinalisation));
  byId('refreshFinalisation').addEventListener('click',loadFinalisation);
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.jump));
  });
  byId("personSearch").addEventListener("input", renderTrainerRows);
  Object.keys(filterKeys).forEach(id => byId(id).addEventListener('change', refreshScope));
  byId('paymentFilter').addEventListener('change', renderTrainerRows);
  byId('benchFilter').addEventListener('change', renderTrainerRows);
  byId('resetFilters').addEventListener('click', () => {
    Object.keys(filterKeys).forEach(id => byId(id).value = '');
    byId('personSearch').value = ''; byId('paymentFilter').value = ''; byId('benchFilter').value = ''; byId('pipelineFilter').value = '';
    byId('pipelineStart').value = ''; byId('pipelineEnd').value = '';
    byId('finalisationBench').value = ''; byId('finalisationOwnership').value = '';
    byId('duplicateFilter').value = '';
    refreshScope();
  });
  ['pipelineFilter', 'pipelineStart', 'pipelineEnd'].forEach(id => byId(id).addEventListener('change', renderPipeline));
  byId('clearPipelineDates').addEventListener('click', () => {
    byId('pipelineStart').value = ''; byId('pipelineEnd').value = '';
    renderPipeline();
  });
  const popover = byId('infoPopover');
  function showInfo(button) {
    popover.textContent = infoCopy[button.dataset.info];
    popover.hidden = false;
    const rect = button.getBoundingClientRect();
    popover.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 12))}px`;
    popover.style.top = `${Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - popover.offsetHeight - 12))}px`;
  }
  document.querySelectorAll('.info').forEach(button => {
    button.addEventListener('mouseenter',()=>showInfo(button));
    button.addEventListener('mouseleave',()=>popover.hidden=true);
    button.addEventListener('focus',()=>showInfo(button));
    button.addEventListener('blur',()=>popover.hidden=true);
    button.addEventListener('click',event=>{event.stopPropagation();showInfo(button);});
  });
  document.addEventListener('click',()=>popover.hidden=true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape')popover.hidden=true;});
  window.addEventListener('scroll',()=>popover.hidden=true, true);
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
  refreshScope();
  loadFinalisation();
  loadGcsPipeline();
}

init();
