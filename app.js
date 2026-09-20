const data = window.OPS_REVIEW_DATA;
let finalisationSource = null;
let finalisationRows = [];
let finalisationCohorts = [];
const FINALISATION_ROW_CAP = 400;
let gcsPipeline = null;
let payoutLedger = null;
let payoutLedgerTasks = [];
let payoutLedgerError = null;
let clientAcceptance = null;
// The GCS-derived pipeline (tools/ingest_verdicts.py -> build_provenance.py).
// Every state and predicate on these rows was decided by that chain, so the
// browser only selects and tallies - it never re-derives a status.
let truth = null;
let truthPage = 0;
let openChain = null;
const TRUTH_PAGE_SIZE = 40;
let audit = null;
let auditPage = 0;
const AUDIT_PAGE_SIZE = 40;
const AUDIT_FILTERS = ['aBatch', 'aCategory', 'aType', 'aDifficulty', 'aGlm',
  'aAcceptance', 'aPriority', 'aTrainer', 'aSource', 'aFlagged'];

const TRUTH_FILTERS = ['tState', 'tGate', 'tFinding', 'tDelivery', 'tDelivered', 'tCarried',
  'tConfidence', 'tDuplicate', 'tDomain', 'tOwner'];
let explorer = null;
let explorerPath = '';
let explorerEntry = null;
// PRD X1: one range for the whole dashboard except Payouts, which reports what
// the workbook paid rather than when the work happened.
const dateRange = {start: '', end: '', preset: ''};
let harborConsole = null;
let consoleLive = null;
let pipelinePage = 0;
let payoutPage = 0;
let ledgerPage = 0;
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
// Shared derivation chain, rendered as popover text.
let scopeChain = [];
let scopeCaveats = null;
function scopeChainCopy() {
  const chain = scopeChain.length
    ? scopeChain.map(step => `${fmt(step.count)} ${step.step}`).join(' \u2192 ') + '. '
    : '';
  const caveats = scopeCaveats
    ? `Of those ${fmt(scopeCaveats.total)}, ${fmt(scopeCaveats.inferred)} have a decision date the chain inferred rather than read from a verdict, ${fmt(scopeCaveats.duplicates)} may be duplicates of another task, and ${fmt(scopeCaveats.lowConfidence)} were identified with low confidence. They are all counted; the flags are an audit trail, not a deduction. `
    : '';
  return chain + caveats + 'Every figure on this dashboard is that same population narrowed by one more step. None of it is recomputed in the browser: these are the counts the ingest chain published alongside the data, so the page and the harness cannot disagree about what a number means. Open a figure on Pipeline to see the step it adds on the end.';
}

const infoCopy = {
  accepted: 'Distinct tasks found in the finalisation cohorts of the bucket. A task finalised into more than one cohort has a folder in each, so folders are collapsed to task names first - the name is read from task.toml inside the archive, because folder names are sometimes opaque pipeline ids. This is delivered work, not the payout basis.',
  sources: 'Every number on this dashboard comes from one of these, and each entry states what it holds, why we read it and how it reaches the page. Live means the page read it during this visit; snapshot means a committed export, which moves only when the export is re-run; not connected means nothing reads it yet. All access is read-only - the dashboard never writes to a bucket, a sheet or a database.',
  consoleCounts: 'The Harbor Console is the source of truth for finalisation. Its counts are shown here as pulled, not recomputed. Our bucket scan lists what is physically stored under tasks/, and that prefix is reorganised and pruned - of 194 folders that left the accepted cohorts overnight, 172 were still in the console and 171 still accepted. So a folder count under-reports accepted work and the console figure is the one to quote. Legacy is the console\u2019s own bucket for anything before 5 September. The console sits behind IAP, so this is a pull through an authenticated browser session rather than a live read.',
  basis: 'The Harbor Console lists one row per submission, and its cards count those rows. This page lists one row per task, taken at its latest submission, because a task resubmitted five times is still one piece of work and counting it five times would overstate delivery and pay. Neither number is wrong: subtract the re-submissions from the console figure and you get this page. The residual few are the console filter starting at a time of day where ours starts at midnight, and anything submitted since the last pull.',
  explorerScope: 'A metadata-only mirror of the delivery prefixes of the GCS bucket: the seven finalisation cohorts and the trainer evaluation records. It holds names, sizes and timestamps, never object contents, and it never writes to the bucket. The whole bucket is far larger - over 22 million objects and 9 million folders - which cannot be mirrored into a static page, so prefixes outside this scope are deliberately absent rather than silently empty.',
  auditComposition: 'The audited batches broken down four ways. These are the 412 tasks the Computer Bench audit covered - batches 1 to 4.1 - not the whole bucket, so this is a different population from the Pipeline tab and the two will not add up to each other.',
  auditGlm: 'How many of four OpenCode GLM trials solved the task. 0/4 means no trial solved it and 4/4 means every trial did; a task is a useful benchmark when some trials succeed and some fail, so the middle buckets are the valuable ones. This score exists only for audited tasks - the pipeline itself records no difficulty score.',
  auditDifficulty: 'The audit workbook rating of Harder or Easier. It comes from the audit, not from Harbor: the pipeline records no difficulty field at all, which is why this rating exists nowhere else on this dashboard.',
  auditAcceptance: 'Accepted, Rejected or Pending as recorded by the audit workbook, not by the GCS verdicts the Pipeline tab reads. The two are different sources judged at different times, so a task can read Accepted here and Rejected there. The status line above gives the date this snapshot was built.',
  auditSource: 'How the task was attributed to a trainer. Accepted portal and Trainer records are direct. QC run owner is inferred from who ran the QC, and unverified means that inference was not confirmed. Contested means more than one trainer claims it, and Unattributed means nobody could be identified.',
  auditFlags: 'Three quality caveats carried per task: contested owner - more than one trainer claims it; unverified - the attribution was inferred and not confirmed; version dependent - the result changes between task versions.',
  manifest: 'A manifest is the list of tasks to hand over next. It is cut from whatever the table is showing, so any filter you set narrows it. It is built from task names rather than rows: the pipeline holds more ready rows than ready tasks, because a task submitted more than once appears more than once and the bucket appends version suffixes such as -v5 that the delivery audit does not carry. One entry per task means the same work is never handed over twice in one manifest. Entries are ordered oldest decision first, so the work that has been sitting accepted the longest goes out first, and the run chosen to represent a task is its most recent decided one. Every entry lists the rows it stands for, so nothing is dropped silently. To cut a second round, load the first manifest back in and its tasks are left out.',
  truthFlags: 'Short codes so the task name is never squeezed out of its column. DL - already delivered, covered by the Delivery tab. Times-N - the same task appears N times in the pipeline and is counted once while the Delivered filter is on. CK - check before shipping: the identifier names a task the audit already covers although the name does not match. DUP - another task shares its name and trainer, so it is probably the same work counted twice; red when the date and outcome match too. UM - unmerged: it arrived with no family id, so repeat runs of it may be counted separately. CO - carried over: first decided before the cut and settled after it. Hover any code for the full explanation for that row, and open the row with + for its evidence.',
  truthVersions: 'The pipeline records one row per submission, not per task. 152 of the delivered rows arrived without a family id, so the pipeline never merged their repeat runs, and another 30 are recorded under an alias or a placeholder name - 534 rows for 367 real tasks. Setting this filter therefore counts tasks rather than rows: a task with several versions appears once, tagged with how many it has, which one is being shown and why. Nothing is dropped - the tag lists the other versions, and clearing the filter brings every row back.',
  truthDelivered: 'Whether this task is one of the 412 already covered by the delivery audit on the Delivery tab. The two datasets share only the task name, so they are joined on it - exactly first, then with version and status suffixes such as -final or -v5 stripped, and never when that would pull in more than one task. The join was checked against the package hash on the 66 tasks that carry one, and agreed on all 66. Ready for delivery means accepted, package collectable at the current bar, and no match to anything already delivered. 93 audited tasks have no counterpart here at all, but only 2 of them are accepted, so the split is reliable for accepted work.',
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
  scopeFunnel: scopeChainCopy,
  currentEvaluations: 'The latest evaluation of each task family in the GCS bucket, by status. It is the evidence feed rather than the console, so it answers what the pipeline last recorded about a family rather than what the task\u2019s decided state is - the Pipeline view carries that.',
  acceptanceScope: 'The date range is not applied to this half. The 240 audit sheet publishes counts only, with no per-task date to filter on, and the workbook records when a payment was made rather than when the work was done. Filtering would therefore cut what was paid while what was accepted stayed whole - and pending is accepted minus paid, so every outstanding balance on the page would quietly rise. The figures here are all-time, whatever range is set on the pipeline half.',
  dailyDelta: 'How many tasks reached each state on each day - the movement, not the standing total, so a quiet day and a busy day look different rather than both reading as a large total. The Pipeline figures are the standing total; this is the change. One row is one task: the chain has already grouped submissions into identities and chosen a canonical run for each, so a task resubmitted five times moves the line once. Where the chain could not read a decision date from a verdict it inferred the day, and the count of those is stated beneath the chart, because an inferred date should not be presented as an observed one.',
  workbook: 'A workbook-wide snapshot with no reliable person-level allocation, so it does not respond to the filters on the other tabs and cannot be split by trainer.',
};


// Inline line chart. Axis labels are HTML so they render at a fixed size;
// only the plot scales.
function lineChart(days, series, options) {
  const settings = options || {};
  if (!days.length || !series.length) return `<p class="empty">${esc(settings.empty || 'No data in this selection.')}</p>`;
  const peak = Math.max(1, ...series.flatMap(line => line.values));
  // A series that never gets near the others cannot be read off a shared scale
  // anyway. It keeps its place and its tooltip, but stops claiming a colour.
  const quiet = line => Math.max(0, ...line.values) < peak * 0.05;
  const ordered = [...series.filter(line => !quiet(line)), ...series.filter(quiet)];
  const stroke = line => quiet(line) ? '--line' : (line.token || '--slate');
  const px = index => days.length === 1 ? 50 : (index / (days.length - 1)) * 100;
  const py = value => (1 - value / peak) * 100;
  const ticks = [peak, Math.round(peak / 2), 0];
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
          ${ordered.length && !quiet(ordered[0]) ? `<polygon class="spark-area" fill="var(${stroke(ordered[0])})"
            points="0,100 ${ordered[0].values.map((value, index) => `${px(index)},${py(value)}`).join(' ')} 100,100"/>` : ''}
          ${ordered.map(line => `<polyline vector-effect="non-scaling-stroke"
            class="spark${quiet(line) ? ' is-quiet' : ''}" fill="none" stroke="var(${stroke(line)})"
            points="${line.values.map((value, index) => `${px(index)},${py(value)}`).join(' ')}"/>`).join('')}
        </svg>
        ${ordered.map(line => line.values.map((value, index) =>
          `<span class="spark-dot" style="left:${px(index)}%;top:${py(value)}%;background:var(${stroke(line)})"
             data-tip="${esc(line.label)} / ${esc(days[index])}: ${fmt(value)}"></span>`).join('')).join('')}
      </div>
      <div class="linechart-xaxis">${days.map((day, index) =>
        `<span style="left:${px(index)}%">${esc(day.slice(5))}</span>`).join('')}</div>
    </div>
    <div class="chart-key">${ordered.map(line =>
      `<span class="key-item${quiet(line) ? ' is-quiet' : ''}" data-series
        style="--tone: var(${stroke(line)})">${esc(line.label)}</span>`).join('')}</div>`;
}

function renderScopeFunnel() {
  const value = byId('countFunnel');
  if (!value) return;
  if (!truth) { value.textContent = '-'; return; }
  const rows = truth.rows;
  // The scope chain is the longest published chain, cut at the step that
  // produced the in-scope count; later steps are figure-specific.
  const longest = [...truth.figures.values()].map(figure => figure.steps || [])
    .sort((a, b) => b.length - a.length)[0] || [];
  const cut = longest.findIndex(step => step.count === rows.length);
  const shared = cut >= 0 ? longest.slice(0, cut + 1) : [];
  scopeChain = shared;
  // Caveat counts feed the tooltip only.
  scopeCaveats = {
    total: rows.length,
    inferred: rows.filter(row => row.decidedInferred).length,
    duplicates: rows.filter(row => row.possibleDuplicate).length,
    lowConfidence: rows.filter(row => row.confidence === 'low').length,
  };
  animateCount(value, truth.counts?.inScope ?? rows.length);
  setTextIfPresent('commandScopeNote', `since ${truth.cut}`);
  const node = byId('detailScope');
  if (node) node.innerHTML = shared.map(step => `<div><span>${esc(step.step)}</span><b>${fmt(step.count)}</b></div>`).join('');
}

let deltaModel = null;

function buildDelta() {
  if (!truth) { deltaModel = null; return; }
  try {
    deltaModel = window.prepareDelta(truth);
  } catch (error) {
    deltaModel = null;
    setText('deltaNote', `Daily delta could not be built: ${error.message}`);
  }
}

// Daily delta: one line per state, tasks reaching that state per day.
function renderDailyDelta() {
  const figure = byId('deltaChart');
  if (!figure) return;
  if (!deltaModel) {
    figure.innerHTML = '<p class="empty">Waiting for the derived pipeline.</p>';
    byId('deltaPeaks').innerHTML = '';
    setText('deltaNote', '');
    return;
  }
  const picked = byId('deltaState').value;
  const result = window.filterDelta(deltaModel,
    {start: dateRange.start, end: dateRange.end, state: picked});

  figure.innerHTML = lineChart(result.days, result.states.map(state => ({
    label: state,
    token: STATE_TOKENS[state] || '--slate',
    values: result.days.map(day => result.series[state][day] || 0),
  })), {label: 'Tasks reaching each state per day',
        empty: result.invalidDates ? 'The start date is after the end date.'
                                   : 'No decisions in this selection.'});

  byId('deltaPeaks').innerHTML = `<span class="peakstrip-label">Busiest day</span>` +
    result.states.filter(state => result.peak[state].count).map(state =>
      `<span class="peakstrip-item"><span class="peakstrip-top"><i style="background:var(${
        STATE_TOKENS[state] || '--slate'})"></i>${esc(state)} <b>${fmt(result.peak[state].count)}</b></span>` +
       `<small>(${esc(result.peak[state].date.slice(5))})</small></span>`).join('');

  setText('deltaNote', '');
}

function populateDeltaFilter() {
  const select = byId('deltaState');
  if (!select || !deltaModel) return;
  const counts = new Map();
  deltaModel.events.forEach(event => counts.set(event.state, (counts.get(event.state) || 0) + 1));
  const chosen = select.value;
  select.innerHTML = '<option value="">All states</option>' +
    deltaModel.states.map(state =>
      `<option value="${esc(state)}">${esc(state)} (${fmt(counts.get(state) || 0)})</option>`).join('');
  select.value = counts.has(chosen) ? chosen : '';
}

function renderEverything() {
  renderSources();
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams();
  renderBenchCards();
  renderPlan();
  if (truth) { renderTruth(); renderCarried(); }
  if (audit) renderAudit();
  renderScopeFunnel();
  populateDeltaFilter();
  renderDailyDelta();
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
    payoutLedgerError = null;
  } catch (error) {
    // Without the ledger the accepted and pending figures fall back to the
    // workbook, which is a different source; say so rather than switch quietly.
    payoutLedgerError = error.message;
    const note = byId('payoutSourceNote');
    if (note) { note.hidden = false; note.textContent = `The payout ledger did not load (${error.message}). Accepted and pending figures below are the workbook's, not the ledger's.`; }
    renderTrainerRows(); renderHero(); renderTopPendingCards();
    return;
  }
  const note = byId('payoutSourceNote');
  if (note) note.hidden = true;
  populateLedgerFilters();
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

let ledgerSort = {key: 'task', dir: 1};
const PAYMENT_TONES = {Paid: 'aqua', Pending: 'red', 'Not itemised': 'yellow'};

function renderPayoutLedger() {
  if (!payoutLedger) return;
  const filters = {
    bench: byId('benchFilter').value,
    search: byId('ledgerSearch').value,
    payment: byId('ledgerPayment').value,
    type: byId('ledgerType').value,
    validity: byId('ledgerValidity').value,
    duplicates: byId('ledgerDuplicates').value,
  };
  const result = window.filterPayoutLedger(payoutLedgerTasks, filters);
  const rows = result.rows;
  const people = new Map((payoutLedger.people || []).map(person => [person.email, person]));

  // The strip above the table: each cell is a filter on the ledger.
  const cell = (label, value, base, tone, filter, filterValue, tip) => {
    const on = filter && byId(filter)?.value === filterValue;
    return `<${filter ? 'button' : 'div'} class="stat" style="--c:var(--${tone})"${filter ? ` data-lfilter="${filter}" data-value="${esc(filterValue)}" aria-pressed="${on}"` : ''} data-tip="${esc(tip)}">
      <b class="stat-n" data-count="${value}" data-key="ledger:${esc(label)}">${fmt(value)}</b>
      <span class="stat-l">${esc(label)}</span>
      <span class="stat-bar"><i style="--pct:${base ? Math.round((value / base) * 100) : 0}"></i><small>${base ? `${Math.round((value / base) * 100)}%` : ''}</small></span>
    </${filter ? 'button' : 'div'}>`;
  };
  const n = rows.length || 1;
  const pending = rows.filter(row => row.paymentState === 'Pending').length;
  const invalid = rows.filter(row => !row.valid).length;
  byId('ledgerStrip').innerHTML =
    cell('ledger tasks', rows.length, payoutLedgerTasks.length, 'slate', null, null, `${fmt(rows.length)} of ${fmt(payoutLedgerTasks.length)} tasks in the ledger match the filters.`) +
    cell('paid', result.paid, n, 'aqua', 'ledgerPayment', 'Paid', 'Paid and itemised against a payment request.') +
    cell('not itemised', result.unitemised, n, 'yellow', 'ledgerPayment', 'Not itemised', 'Paid in a lump that the request did not itemise task by task.') +
    cell('owed', pending, n, 'red', 'ledgerPayment', 'Pending', 'Accepted, not yet in any payment request.') +
    cell('valid = 0', invalid, n, 'orange', 'ledgerValidity', 'invalid', 'Accepted rows the tracker marks as not valid; excluded from what is payable.') +
    cell('folded rows', result.duplicateRows, null, 'violet', 'ledgerDuplicates', 'duplicates', 'Source rows repeated for the same task and folded into one line.');
  animateCounts(byId('ledgerStrip'));

  const labels = {ledgerSearch: 'Search', ledgerPayment: 'Payment', ledgerType: 'Type', ledgerValidity: 'Valid', ledgerDuplicates: 'Repeats', benchFilter: 'Bench'};
  const shown = {valid: 'Valid', invalid: 'Valid = 0', duplicates: 'Folded only', unique: 'Single-row only'};
  const active = Object.keys(labels).map(id => [id, byId(id)?.value]).filter(([, value]) => value);
  byId('ledgerChips').innerHTML = active.length
    ? active.map(([id, value]) => `<button type="button" class="chipbtn" data-lclear="${id}"><span>${labels[id]}</span>${esc(shown[value] || value)}<i aria-hidden="true">×</i></button>`).join('') +
      '<button type="button" class="chipbtn is-clear" data-lclear="all">Clear all</button>'
    : '<span class="chips-empty">No filters applied · the bench filter above also applies here</span>';

  const sorted = [...rows].sort((a, b) => {
    const key = ledgerSort.key;
    const pick = row => key === 'trainerName' ? (row.trainer?.name || row.email || '') : key === 'valid' ? (row.valid ? 1 : 0) : key === 'duplicateRows' ? row.duplicateRows : String(row[key] || '');
    const va = pick(a), vb = pick(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * ledgerSort.dir || String(a.task).localeCompare(String(b.task));
  });
  document.querySelectorAll('#ledgerTable .sort').forEach(button => {
    const on = button.dataset.sort === ledgerSort.key;
    button.classList.toggle('is-on', on);
    button.dataset.dir = on ? (ledgerSort.dir > 0 ? 'asc' : 'desc') : '';
  });
  const ledgerSize = pageSize('ledgerPageSize');
  const ledgerPages = Math.max(1, Math.ceil(sorted.length / ledgerSize));
  ledgerPage = Math.min(Math.max(ledgerPage, 0), ledgerPages - 1);
  const ledgerFrom = ledgerPage * ledgerSize;
  const ledgerShown = sorted.slice(ledgerFrom, ledgerFrom + ledgerSize);
  setText('ledgerPage', sorted.length
    ? `${fmt(ledgerFrom + 1)}–${fmt(ledgerFrom + ledgerShown.length)} of ${fmt(sorted.length)}`
    : 'No matches');
  byId('ledgerPrevious').disabled = ledgerPage === 0;
  byId('ledgerNext').disabled = ledgerPage >= ledgerPages - 1;
  byId('ledgerRows').innerHTML = ledgerShown.map((row, index) => {
    const person = people.get(row.email);
    const payment = row.paymentState === 'Not itemised'
      ? `${fmt(person?.paidTasks)} of ${fmt(person?.listedTasks)} paid` : '';
    return `
        <tr style="--i:${index}">
          <td class="num serial">${fmt(ledgerFrom + index + 1)}</td>
          <td><div class="taskcell"><span class="taskname" title="${esc(row.task)}">${esc(row.task)}</span>${row.harborLink ? `<a class="flag flag-info" href="${esc(row.harborLink)}" target="_blank" rel="noopener" title="Open in the Harbor console">HC ↗</a>` : ''}</div></td>
          <td><span class="who"><i class="avatar">${esc(initials(row.email))}</i><span title="${esc(row.email)}">${esc(row.trainer?.name || row.email || 'Unassigned')}</span></span></td>
          <td><span class="diff" style="--c:${row.filterType === 'Connector' ? 'var(--aqua-ink)' : 'var(--blue-ink)'}">${esc(row.filterType)}</span><small class="muted"> ${esc(row.trainer?.team || 'Unassigned')}</small></td>
          <td><span class="pill ${row.valid ? 'is-ok' : 'is-warn'}">${row.valid ? 'Valid' : 'Valid = 0'}</span></td>
          <td><span class="pill" data-tone="${PAYMENT_TONES[row.paymentState] || 'slate'}" style="--tone:var(--${PAYMENT_TONES[row.paymentState] || 'slate'});--tone-soft:var(--${PAYMENT_TONES[row.paymentState] || 'slate'}-soft);--tone-ink:var(--${PAYMENT_TONES[row.paymentState] || 'slate'}-ink)">${esc(row.paymentState)}</span>${payment ? `<div class="muted">${esc(payment)}</div>` : ''}</td>
          <td>${row.cj ? `<span class="batch-chip">${esc(row.cj)}</span>` : '<span class="muted">–</span>'}</td>
          <td class="num">${fmt(row.duplicateRows + 1)}</td>
        </tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No matches.</td></tr>';
}

async function loadDeliveryAudit() {
  try {
    const response = await fetch(`assets/delivery-audit.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!response.ok) throw new Error(`asset returned ${response.status}`);
    audit = window.prepareDeliveryAudit(await response.json());
    populateAuditFilters();
    renderAudit();
  } catch (error) {
    audit = null;
    setText('auditStatus', `The task audit could not be loaded: ${error.message}. ` +
      'Rebuild it with tools/build_delivery_audit.py.');
  }
  renderSources();
}

function auditFilters() {
  return {
    batch: byId('aBatch').value, category: byId('aCategory').value,
    type: byId('aType').value, difficulty: byId('aDifficulty').value,
    glm: byId('aGlm').value, acceptance: byId('aAcceptance').value,
    priority: byId('aPriority').value, trainer: byId('aTrainer').value,
    flagged: byId('aFlagged').value, search: byId('aSearch').value,
    source: byId('aSource')?.value || '',
  };
}

function populateAuditFilters() {
  if (!audit) return;
  const all = window.filterDeliveryAudit(audit.rows, {});
  fillSelect('aBatch', all.byBatch, 'Any batch');
  fillSelect('aCategory', all.byCategory, 'Any category');
  fillSelect('aType', all.byType, 'Any type');
  fillSelect('aDifficulty', all.byDifficulty, 'Any difficulty');
  fillSelect('aGlm', all.byGlm, 'Any score');
  fillSelect('aAcceptance', all.byAcceptance, 'Any acceptance');
  fillSelect('aPriority', all.byPriority, 'Any priority');
  fillSelect('aTrainer', all.byTrainer, 'Any trainer');
  fillSelect('aSource', all.bySource, 'Any source');
}

// A share-of-total bar per value, biggest first. Same shape for all four
// breakdowns so they read as one family rather than four charts.
function renderBreakdown(id, counts, total) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const top = entries[0]?.[1] || 1;
  byId(id).innerHTML = entries.length ? entries.map(([label, n]) => `
    <div class="bd-row" data-tip="${esc(label)}: ${fmt(n)} of ${fmt(total)} shown (${Math.round((n / (total || 1)) * 100)}%)">
      <span class="bd-label">${esc(label)}</span>
      <span class="bd-track"><span class="bd-fill" style="width:${Math.max((n / top) * 100, 2)}%"></span></span>
      <span class="bd-value">${fmt(n)}</span>
    </div>`).join('') : '<p class="empty">Nothing in this selection.</p>';
}

const AUDIT_TONES = {
  category: {Code: '--blue', 'Other/unclassified': '--slate', General: '--violet', Connector: '--aqua', Health: '--magenta', Law: '--orange', Finance: '--yellow'},
  acceptance: {Accepted: '--aqua', Rejected: '--red', Pending: '--yellow'},
  glm: {'0/4': '--slate', '1/4': '--blue', '2/4': '--violet', '3/4': '--accent', '4/4': '--aqua'},
  difficulty: {Easier: '--aqua', Harder: '--orange'},
  type: {Connector: '--aqua', 'Non-connector': '--blue'},
};
const AUDIT_LENS_FILTER = {category: 'aCategory', acceptance: 'aAcceptance', glm: 'aGlm', batch: 'aBatch', difficulty: 'aDifficulty', type: 'aType', source: 'aSource'};
const AUDIT_FLAG_CODES = {'contested owner': 'CO', 'owner still contested': 'OC', unverified: 'UV', 'version dependent': 'VD'};
let auditLens = 'category';
let auditSort = {key: 'task', dir: 1};

const auditTone = (lens, key) => `var(${(AUDIT_TONES[lens] || {})[key] || '--slate'})`;
const lensValue = (row, lens) => lens === 'glm' ? row.glmBucket : (row[lens] || window.DELIVERY_AUDIT_UNSET);
const verdictBar = (acc, rej, pen, total) => `<span class="vbar" aria-hidden="true">
  ${acc ? `<i class="is-accepted" style="flex:${acc}" data-tip="Accepted ${fmt(acc)} (${Math.round((acc / total) * 100)}%)"></i>` : ''}
  ${rej ? `<i class="is-rejected" style="flex:${rej}" data-tip="Rejected ${fmt(rej)} (${Math.round((rej / total) * 100)}%)"></i>` : ''}
  ${pen ? `<i class="is-pending" style="flex:${pen}" data-tip="Pending ${fmt(pen)} (${Math.round((pen / total) * 100)}%)"></i>` : ''}
</span>`;
function verdicts(rows) {
  const acc = rows.filter(r => r.acceptance === 'Accepted').length;
  const rej = rows.filter(r => r.acceptance === 'Rejected').length;
  return {acc, rej, pen: rows.length - acc - rej, rate: acc + rej ? Math.round((acc / (acc + rej)) * 100) : null};
}
const glmDots = bucket => {
  const n = Number(String(bucket).split('/')[0]);
  return `<span class="glm-dots" data-tip="${esc(bucket)} trials solved">${[0, 1, 2, 3].map(i => `<i class="${Number.isFinite(n) && i < n ? 'is-on' : ''}"></i>`).join('')}<b>${esc(bucket)}</b></span>`;
};
const initials = email => String(email || '').split('@')[0].split(/[._-]/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('') || '?';

function renderAuditRows(rows) {
  const size = pageSize('auditPageSize');
  const sorted = [...rows].sort((a, b) => {
    const key = auditSort.key;
    const va = key === 'glm' ? Number(String(a.glmBucket).split('/')[0]) : key === 'size_mb' ? Number(a.size_mb) || 0 : String(a[key] || '');
    const vb = key === 'glm' ? Number(String(b.glmBucket).split('/')[0]) : key === 'size_mb' ? Number(b.size_mb) || 0 : String(b[key] || '');
    return (va < vb ? -1 : va > vb ? 1 : 0) * auditSort.dir || String(a.task).localeCompare(String(b.task));
  });
  const pages = Math.max(Math.ceil(sorted.length / size), 1);
  auditPage = Math.min(auditPage, pages - 1);
  const from = auditPage * size;
  const slice = sorted.slice(from, from + size);
  const maxMb = Math.max(1, ...rows.map(row => Number(row.size_mb) || 0));
  document.querySelectorAll('.inv .sort').forEach(button => {
    const active = button.dataset.sort === auditSort.key;
    button.classList.toggle('is-on', active);
    button.dataset.dir = active ? (auditSort.dir > 0 ? 'asc' : 'desc') : '';
  });
  byId('auditRows').innerHTML = slice.length ? slice.map((row, index) => {
    const id = `audit-drill-${from + index}`;
    const list = value => Array.isArray(value) ? value : (typeof value === 'string' && value.startsWith('[') ? value.replace(/[\[\]']/g, '').split(',').map(v => v.trim()).filter(Boolean) : (value ? [value] : []));
    const dates = list(row.dates), connectors = list(row.connectorList.length ? row.connectorList : row.connectors);
    return `
    <tr class="drill-head" style="--i:${index}">
      <td><button class="drill-toggle" aria-expanded="false" aria-controls="${id}" aria-label="Details for ${esc(row.task)}">+</button></td>
      <td class="num serial">${fmt(from + index + 1)}</td>
      <td><div class="taskcell"><span class="taskname" title="${esc(row.task)}">${esc(row.task)}</span>
        ${row.flags.map(f => `<span class="flag flag-warn" title="${esc(f)}">${AUDIT_FLAG_CODES[f] || esc(f)}</span>`).join('')}</div></td>
      <td><span class="batch-chip">${esc(String(row.batch || '-').replace(/^Batch\s*/i, 'B'))}</span></td>
      <td><span class="cat" style="--c:${auditTone('category', row.category)}"><i></i>${esc(row.category || '-')}</span></td>
      <td>${glmDots(row.glmBucket)}</td>
      <td><span class="diff" style="--c:${auditTone('difficulty', row.difficulty)}">${esc(row.difficulty || '-')}</span></td>
      <td>${row.trainer
        ? `<span class="who"><i class="avatar">${esc(initials(row.trainer))}</i><span>${esc(row.trainer)}</span>${row.resolvedFromPipeline ? '<em class="chip" title="The audit workbook left this unattributed; this owner is the one the GCS verdicts record for the task.">from verdicts</em>' : ''}</span>`
        : '<span class="who is-none"><i class="avatar">?</i><span>Unattributed</span></span>'}</td>
      <td><span class="state state-${esc(String(row.acceptance || '').toLowerCase())}">${esc(row.acceptance || '-')}</span></td>
      <td class="num"><span class="mb"><i style="--pct:${Math.round(((Number(row.size_mb) || 0) / maxMb) * 100)}"></i>${row.size_mb ? Number(row.size_mb).toFixed(1) : '-'}</span></td>
    </tr>
    <tr class="drill" id="${id}" hidden><td colspan="10">
      <dl class="drill-grid">
        <dt>SHA</dt><dd><code>${esc(row.sha || '-')}</code></dd>
        <dt>Size</dt><dd>${row.size_mb ? `${Number(row.size_mb).toFixed(2)} MB` : '-'}</dd>
        <dt>Versions</dt><dd>${esc(String(row.versions || '1'))}</dd>
        <dt>Dates</dt><dd>${dates.length ? dates.map(esc).join(', ') : '-'}</dd>
        <dt>Connectors</dt><dd>${connectors.length ? connectors.map(c => `<span class="chip">${esc(c)}</span>`).join(' ') : 'none'}</dd>
        <dt>Priority</dt><dd>${esc(row.priority || 'not set')}</dd>
        <dt>QC result</dt><dd>${esc(row.qc_result || 'not recorded')}</dd>
        <dt>Attribution</dt><dd>${esc(row.source || '-')}${row.pipelineOwners.length ? ` · pipeline owners: ${row.pipelineOwners.map(esc).join(', ')}` : ''}</dd>
        <dt>Flags</dt><dd>${row.flags.length ? row.flags.map(esc).join(', ') : 'none'}</dd>
        <dt>Feedback</dt><dd>${row.feedback_url ? `<a href="${esc(row.feedback_url)}" target="_blank" rel="noopener">Open the feedback sheet</a>` : '-'}</dd>
      </dl>
    </td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">No tasks match these filters.</td></tr>';
  setText('auditPage', `${fmt(sorted.length ? from + 1 : 0)}–${fmt(from + slice.length)} of ${fmt(sorted.length)}`);
  byId('auditPrev').disabled = auditPage === 0;
  byId('auditNext').disabled = auditPage >= pages - 1;
}

// Size the map to the list beside it: pick the column count whose square
// cells fill that height, so the two columns end together.
function fitWaffle() {
  const waffle = byId('auditWaffle');
  const list = byId('auditList')?.parentElement;
  if (!waffle || !list) return;
  const n = waffle.querySelectorAll('.sq').length;
  if (!n) { waffle.style.gridTemplateColumns = ''; return; }
  const gap = 4, pad = 20;
  const width = waffle.clientWidth - pad;
  const target = Math.max(120, list.getBoundingClientRect().height - (waffle.previousElementSibling?.getBoundingClientRect().height || 0) - 8 - pad);
  let best = {cols: 30, diff: Infinity};
  for (let cols = 10; cols <= 80; cols += 1) {
    const cell = (width - gap * (cols - 1)) / cols;
    if (cell < 8) break;
    const rows = Math.ceil(n / cols);
    const height = rows * cell + gap * (rows - 1);
    const diff = Math.abs(height - target);
    if (diff < best.diff) best = {cols, diff};
  }
  waffle.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
}
window.addEventListener('resize', () => { if (audit) fitWaffle(); });

function renderAuditChips(filters) {
  const labels = {aBatch: 'Batch', aCategory: 'Category', aType: 'Type', aDifficulty: 'Difficulty', aGlm: 'GLM', aAcceptance: 'Acceptance', aPriority: 'Priority', aTrainer: 'Trainer', aSource: 'Source', aFlagged: 'Flagged', aSearch: 'Search'};
  const active = [...AUDIT_FILTERS, 'aSearch'].map(id => [id, byId(id)?.value]).filter(([, value]) => value);
  byId('auditChips').innerHTML = active.length
    ? active.map(([id, value]) => `<button type="button" class="chipbtn" data-clear="${id}" title="Remove this filter"><span>${labels[id]}</span>${esc(id === 'aFlagged' ? (value === 'yes' ? 'Flagged' : 'Not flagged') : value)}<i aria-hidden="true">×</i></button>`).join('')
      + `<button type="button" class="chipbtn is-clear" data-clear="aReset-all">Clear all</button>`
    : '<span class="chips-empty">No filters applied · click any figure, square or bar above to filter</span>';
}

function renderAudit() {
  if (!audit) return;
  const filters = auditFilters();
  const result = window.filterDeliveryAudit(audit.rows, filters);
  const rows = result.rows;
  const shown = rows.length;
  const total = audit.rows.length;

  // Figures: each one filters on click.
  const figures = [
    ['Audited tasks', shown, `of ${fmt(total)} in the audit`, 'slate', null, null, total ? Math.round((shown / total) * 100) : 0],
    ['Accepted', result.accepted, 'by the audit workbook', 'aqua', 'aAcceptance', 'Accepted', shown ? Math.round((result.accepted / shown) * 100) : 0],
    ['Rejected', result.rejected, 'by the audit workbook', 'red', 'aAcceptance', 'Rejected', shown ? Math.round((result.rejected / shown) * 100) : 0],
    ['Pending', result.pending, 'no decision recorded', 'yellow', 'aAcceptance', 'Pending', shown ? Math.round((result.pending / shown) * 100) : 0],
    ['Connector tasks', result.connectors, `${shown ? Math.round((result.connectors / shown) * 100) : 0}% of those shown`, 'blue', 'aType', 'Connector', shown ? Math.round((result.connectors / shown) * 100) : 0],
    ['Trainers', result.trainers, `${fmt(shown - result.attributed)} unattributed`, 'violet', null, null, null],
  ];
  const figuresHost = byId('auditFigures');
  figuresHost.innerHTML = figures.map(([label, value, note, tone, filter, filterValue, pct], index) => {
    const pressed = filter ? byId(filter)?.value === filterValue : false;
    const tag = filter ? 'button' : 'div';
    return `<${tag} class="kpi kpi-button${filter ? '' : ' kpi-static'}" data-tone="${tone}" style="--i:${index}"${filter ? ` data-filter="${filter}" data-value="${esc(filterValue)}" aria-pressed="${pressed}"` : ''}>
      <div class="kpi-top"><h3>${esc(label)}</h3></div>
      <strong data-count="${value}" data-key="audit:${esc(label)}">${fmt(value)}</strong>
      <p class="kpi-note">${esc(note)}</p>
      ${pct == null ? '' : `<span class="tile-share"><i style="--pct:${pct}"></i></span>`}
      ${filter ? `<span class="kpi-cue">${pressed ? 'filtering · click to clear' : 'click to filter'}</span>` : ''}
    </${tag}>`;
  }).join('');
  animateCounts(figuresHost);

  // Composition: one dimension at a time. The list is the legend, each row
  // carrying its count, share, verdict mix and acceptance of decided tasks;
  // the map colours every task by the same dimension.
  const lens = auditLens;
  document.querySelectorAll('#auditLens [data-lens]').forEach(button => button.classList.toggle('is-on', button.dataset.lens === lens));
  const groups = Object.entries(groupBy(rows, row => lensValue(row, lens))).map(([key, list]) => ({key, list, n: list.length, ...verdicts(list)}));
  const orderFor = {
    batch: (a, b) => parseFloat(String(a.key).replace(/[^\d.]/g, '')) - parseFloat(String(b.key).replace(/[^\d.]/g, '')),
    glm: (a, b) => parseInt(b.key, 10) - parseInt(a.key, 10),
    acceptance: (a, b) => ['Accepted', 'Rejected', 'Pending'].indexOf(a.key) - ['Accepted', 'Rejected', 'Pending'].indexOf(b.key),
    difficulty: (a, b) => ['Easier', 'Harder'].indexOf(a.key) - ['Easier', 'Harder'].indexOf(b.key),
  };
  groups.sort(orderFor[lens] || ((a, b) => b.n - a.n));
  const SOURCE_TONES = ['--accent', '--blue', '--aqua', '--violet', '--magenta', '--orange', '--yellow', '--slate', '--red'];
  const toneFor = key => {
    if (AUDIT_TONES[lens]?.[key]) return `var(${AUDIT_TONES[lens][key]})`;
    return `var(${SOURCE_TONES[groups.findIndex(g => g.key === key) % SOURCE_TONES.length]})`;
  };
  const lensFilter = AUDIT_LENS_FILTER[lens];
  const lensTitle = {category: 'By category', acceptance: 'By verdict', batch: 'By batch', glm: 'By GLM score', difficulty: 'By difficulty', type: 'By type', source: 'By attribution'}[lens];
  const maxN = Math.max(1, ...groups.map(g => g.n));
  setText('auditListTitle', `${lensTitle} · ${fmt(groups.length)} group${groups.length === 1 ? '' : 's'}`);
  let previousRate = null;
  byId('auditList').innerHTML = groups.length ? groups.map((g, index) => {
    const on = byId(lensFilter)?.value === g.key;
    const trend = lens === 'batch' && g.rate != null && previousRate != null
      ? (g.rate > previousRate ? '<em class="trend up" data-tip="Up on the batch before">↑</em>' : g.rate < previousRate ? '<em class="trend down" data-tip="Down on the batch before">↓</em>' : '<em class="trend flat">→</em>')
      : '';
    if (lens === 'batch' && g.rate != null) previousRate = g.rate;
    return `<button type="button" class="dim-row${on ? ' is-on' : ''}" style="--i:${index};--c:${toneFor(g.key)}" data-filter="${lensFilter}" data-value="${esc(g.key)}" data-v="${esc(g.key)}">
      <span class="dim-swatch"><i></i></span>
      <span class="dim-label">${lens === 'glm' ? glmDots(g.key) : esc(g.key)}</span>
      <b class="dim-n" data-count="${g.n}" data-key="dim:${lens}:${esc(g.key)}">${fmt(g.n)}</b>
      <span class="dim-share"><i style="--pct:${Math.round((g.n / maxN) * 100)}"></i><small>${Math.round((g.n / (shown || 1)) * 100)}%</small></span>
      ${lens === 'acceptance' ? '<span></span><span></span>' : `${verdictBar(g.acc, g.rej, g.pen, g.n)}<span class="dim-rate">${g.rate == null ? '<small>no decisions</small>' : `<b>${g.rate}%</b>${trend}`}</span>`}
    </button>`;
  }).join('') : '<p class="empty">No tasks match these filters.</p>';
  animateCounts(byId('auditList'));

  const largest = groups[0] && [...groups].sort((a, b) => b.n - a.n)[0];
  const decided = groups.filter(g => g.rate != null && g.acc + g.rej >= 5);
  const best = decided.length ? decided.reduce((b, g) => g.rate > b.rate ? g : b) : null;
  const worst = decided.length > 1 ? decided.reduce((b, g) => g.rate < b.rate ? g : b) : null;
  setText('auditInsight', !largest ? '' : lens === 'acceptance'
    ? `${fmt(result.accepted + result.rejected)} of ${fmt(shown)} shown have a decision; ${fmt(result.pending)} are still pending.`
    : `Largest group ${largest.key} (${fmt(largest.n)}, ${Math.round((largest.n / (shown || 1)) * 100)}%)` +
      (best ? ` · highest acceptance of decided tasks ${best.key} (${best.rate}%)` : '') +
      (worst && worst !== best ? ` · lowest ${worst.key} (${worst.rate}%)` : '') + '. Acceptance counts decided tasks only.');

  const rank = key => groups.findIndex(g => g.key === key);
  const grouped = [...rows].sort((a, b) => rank(lensValue(a, lens)) - rank(lensValue(b, lens)) || String(a.task).localeCompare(String(b.task)));
  byId('auditWaffle').innerHTML = grouped.map((row, index) => {
    const v = lensValue(row, lens);
    return `<i class="sq" role="button" tabindex="0" data-task="${esc(row.task)}" data-v="${esc(v)}" style="--c:${toneFor(v)};--i:${Math.min(index, 60)}" data-tip="${esc(row.task)} · ${esc(row.category || '-')} · ${esc(row.acceptance || '-')} · GLM ${esc(row.glmBucket)} · ${esc(row.difficulty || '-')} · ${esc(row.batch || '-')}"></i>`;
  }).join('') || '<p class="empty">No tasks match these filters.</p>';
  setText('auditMapNote', `${fmt(shown)} of ${fmt(total)} · hover a row to light its tasks · click a square to find it below`);
  fitWaffle();

  const built = audit.dataGeneratedAt
    ? new Date(audit.dataGeneratedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})
    : 'unknown';
  setText('auditStatus', `The Computer Bench task audit: ${fmt(audit.rows.length)} tasks across batches 1 to 4.1, built ${built}. ` +
    'A different population from Pipeline, judged by the audit workbook rather than by the GCS verdicts, so the two will not agree task for task.');
  setText('auditCaveats',
    `${fmt(result.flagged)} of ${fmt(shown)} shown carry a quality flag. ` +
    (result.resolvedFromPipeline
      ? `${fmt(result.resolvedFromPipeline)} had no usable owner in the workbook and take one from `
        + 'the GCS verdicts instead, marked on the row. '
      : '') +
    `Acceptance here is the workbook figure, recorded ${audit.statusGeneratedAt ? audit.statusGeneratedAt.slice(0, 10) : 'an unknown date'}; `
    + 'the Pipeline tab reads the bucket instead.');
  setText('auditAudit', `${fmt(shown)} of ${fmt(audit.rows.length)} tasks · ` +
    `${fmt(result.harder)} rated Harder · ${fmt(result.trainers)} trainers · ${result.megabytes.toFixed(0)} MB`);
  renderAuditChips(filters);
  renderAuditRows(rows);
}

async function loadTruth() {
  try {
    const response = await fetch(`assets/pipeline-truth.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!response.ok) throw new Error(`asset returned ${response.status}`);
    // The delivered index is optional: it needs a second dataset, and the
    // pipeline is still worth reading without it. A missing index leaves the
    // rows with no `delivered` attribute at all rather than a false one.
    let deliveredIndex = null;
    try {
      const idx = await fetch(`assets/delivered-index.json?t=${Date.now()}`, {cache: 'no-store'});
      if (idx.ok) deliveredIndex = await idx.json();
    } catch (ignored) { deliveredIndex = null; }
    const payload = await response.json();
    truth = window.prepareTruth(payload, deliveredIndex);
    truth.counts = payload.counts || null;
    populateTruthFilters();
    renderTruth();
    renderCarried();
    buildDelta();
    renderScopeFunnel();
    populateDeltaFilter();
    renderDailyDelta();
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
        // Go through loadTruth rather than preparing the payload here: it also
        // fetches the delivered index. Preparing without it left every row
        // unmarked, so Already delivered fell to 0 and Ready rose to include
        // work that had already gone out - and the stale guard cannot fire on
        // an index that is absent rather than old, so nothing said a word.
        await loadTruth();
        // And only call it published if it actually loaded; loadTruth writes
        // its own message when it fails, which this would otherwise bury.
        if (truth && truth.generatedAt === payload.generatedAt) {
          setText('truthStatus', `New data published ${new Date(payload.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}.`);
        }
      }
    } catch { /* keep waiting; a deploy in flight can serve a partial response */ }
  }, 30000);
}

async function rebuildTruth() {
  const button = byId('truthRefresh');
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const label = button.textContent;
  if (!local) {
    // A published page is static and cannot hold a credential, so it has no way
    // to start the rebuild itself. It does not need to: the chain runs on a
    // schedule and pushes its result here, so this button looks for newer data
    // rather than handing the visitor a GitHub page to press Run on.
    const before = truth?.generatedAt || '';
    button.disabled = true;
    button.textContent = 'Checking…';
    setText('truthStatus', 'Looking for a newer build…');
    try {
      await loadTruth();
      const changed = (truth?.generatedAt || '') !== before;
      setText('truthStatus', changed
        ? `Loaded the build from ${new Date(truth.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}.`
        : 'Already showing the newest published build. The pipeline rebuilds itself every 15 minutes; ' +
          'this page will pick the next one up on its own.');
      // Nothing newer yet, so keep watching rather than making anyone press again.
      if (!changed) watchForRebuild();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
    return;
  }
  button.disabled = true;
  button.textContent = 'Rebuilding…';
  setText('truthStatus', 'Running the eight-step chain on the Harbor VM: verdicts, delivery, identity, canonical run, state, tags, provenance, reconcile. This takes about half a minute.');
  try {
    const response = await fetch('/api/refresh-truth', {method: 'POST', cache: 'no-store'});
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.busy) {
      // Someone else is already rebuilding - another tab, or a second click.
      // Not a failure, so do not dress it as one; wait for the result instead.
      setText('truthStatus', `${body.error} This page will load the new data when it lands.`);
      watchForRebuild();
      return;
    }
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
      Object.entries(body.figures || {}).slice(0, 4).map(([k, v]) => `${k} ${fmt(v)}`).join(' / ') +
      // The delivered join is rebuilt with the pipeline. If only that half
      // failed the pipeline figures are still good, so name the stale half
      // rather than calling the whole rebuild a failure.
      (body.rejoinError
        ? ` / the delivered join could not be rebuilt (${body.rejoinError}), so the delivered and ready figures are from the previous pipeline`
        : ''));
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
    delivered: byId('tDelivered') ? byId('tDelivered').value : '',
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
  fillSelect('cGate', v.gateEra, 'Any gate');
  fillSelect('cDomain', v.domain, 'Any domain');
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

function renderScope(result) {
  if (!truth) return;
  const days = [...new Set(result.rows.map(row => row.decided).filter(Boolean))].sort();
  const chart = byId('scopeChart');
  if (!days.length) {
    chart.innerHTML = '<p class="empty">No decisions in this selection.</p>';
    byId('scopeKey').innerHTML = '';
    setText('scopeNote', '');
    return;
  }
  const order = ['accepted', 'legacy accepted', 'rejected', 'error', 'running'];
  const label = state => (state === 'error' ? 'no QC decision' : state);
  const states = order.filter(state => result.rows.some(row => row.state === state));
  const grid = new Map();
  const perDay = new Map();
  for (const row of result.rows) {
    if (!row.decided) continue;
    grid.set(`${row.state}|${row.decided}`, (grid.get(`${row.state}|${row.decided}`) || 0) + 1);
    perDay.set(row.decided, (perDay.get(row.decided) || 0) + 1);
  }
  const max = Math.max(...perDay.values(), 1);
  setText('scopeNote', `${fmt(result.rows.length)} tasks decided ${days[0]} to ${days.at(-1)}, by decision day`);

  const active = byId('tState').value;
  byId('scopeKey').innerHTML = states.map(state =>
    `<button class="key-item key-button${active === state ? ' is-on' : ''}" data-series data-state="${esc(state)}"
       style="--tone: var(${STATE_TOKENS[state] || '--slate'})">${esc(label(state))}</button>`).join('');

  chart.innerHTML = `
    <div class="daybars-axis"><span>${fmt(max)}</span><span>${fmt(Math.round(max / 2))}</span><span>0</span></div>
    <div class="daybars-track">${days.map(day => {
      const total = perDay.get(day) || 0;
      return `<div class="daybar" style="--h:${(total / max) * 100}%">
        <div class="daybar-stack" data-tip="${esc(day)}: ${fmt(total)} tasks">${states.map(state => {
          const n = grid.get(`${state}|${day}`) || 0;
          return n ? `<i style="flex:${n};background:var(${STATE_TOKENS[state] || '--slate'})" data-tip="${esc(day)} \u00b7 ${esc(label(state))}: ${fmt(n)} of ${fmt(total)}"></i>` : '';
        }).join('')}</div>
        <span class="daybar-x">${esc(day.slice(5))}</span>
      </div>`;
    }).join('')}</div>`;
}

function renderTruthFigures(result, filtered) {
  const cue = filtered ? 'filtered' : 'how is this counted?';
  const cards = [
    ['Accepted', result.accepted, 'package at the current bar', 'aqua'],
    ['Rejected', result.rejected, 'failed a QC decision', 'yellow'],
    ['No QC decision', result.undecided, 'parked, crashed or never decided', 'orange'],
    ['Running', result.running, 'in a stage', 'violet'],
    ['Legacy accepted', result.legacyAccepted, 'accepted before the current bar', 'blue'],
  ];
  // The five states partition the shown tasks; the bar above the cards says so.
  const total = cards.reduce((n, [, v]) => n + (v || 0), 0) || 1;
  byId('truthPartition').innerHTML = cards.filter(([, v]) => v).map(([label, value, , tone], index) =>
    `<button class="part${openChain === label ? ' is-on' : ''}" style="flex:${value};--c:var(--${tone});--i:${index}" data-chain="${esc(label)}" aria-pressed="${openChain === label}" data-tip="${esc(label)}: ${fmt(value)} of ${fmt(total)} (${Math.round((value / total) * 100)}%)">
      ${value / total >= 0.07 ? `<span>${esc(label)}</span><b>${Math.round((value / total) * 100)}%</b>` : ''}
    </button>`).join('');
  byId('truthFigures').innerHTML = cards.map(([label, value, hint, tone], index) => `
    <button class="kpi kpi-button" data-tone="${tone}" data-chain="${esc(label)}" aria-pressed="${openChain === label}" style="--i:${index}">
      <div class="kpi-top"><h3>${esc(label)}</h3></div>
      <strong data-count="${value}" data-key="truth:${esc(label)}">${fmt(value)}</strong>
      <p class="kpi-note">${esc(hint)}</p>
      <span class="kpi-cue">${cue}</span>
    </button>`).join('');
  animateCounts(byId('truthFigures'));

  // The same compact cell for the delivery join and the flags, so the second
  // row reads as one strip. The join has no published chain - it depends on
  // the delivery audit, which the ingest chain never sees - so those two cells
  // explain themselves in the tooltip; the flags open their chain like the cards.
  const stat = (label, value, base, tip, chain, tone) => `<${chain ? 'button' : 'div'} class="stat" style="--c:var(--${tone})"${chain ? ` data-chain="${esc(chain)}" aria-pressed="${openChain === chain}"` : ''} data-tip="${esc(tip)}">
      <b class="stat-n" data-count="${value}" data-key="stat:${esc(label)}">${fmt(value)}</b>
      <span class="stat-l">${esc(label)}</span>
      <span class="stat-bar"><i style="--pct:${base ? Math.min(100, Math.round((value / base) * 100)) : 0}"></i><small>${base ? `${Math.round((value / base) * 100)}%` : ''}</small></span>
    </${chain ? 'button' : 'div'}>`;
  const idx = truth?.deliveredIndex;
  byId('truthJoin').innerHTML = idx
    ? stat('already delivered', result.delivered, result.rows.length,
        `${fmt(result.delivered)} delivered${result.collapsed ? ' tasks' : ` rows, ${fmt(result.deliveredNames)} distinct names`} · matched by name against the ${fmt(idx.counts.auditedTasks)} tasks on the Delivery tab; ${fmt(idx.counts.auditedMatched)} found in the pipeline, ${fmt(idx.counts.auditedUnmatched)} not (${fmt(idx.counts.unmatchedAccepted)} of those accepted). Share of the tasks shown.`, null, 'aqua') +
      stat('ready for delivery', result.readyForDelivery, result.rows.length,
        `${fmt(result.readyForDelivery)} accepted, collectable at the current bar and not yet delivered${result.collapsed ? '' : ` · ${fmt(result.readyNames)} distinct names`}. Share of the tasks shown.`, null, 'blue')
    : '<p class="empty">The delivered index is not loaded.</p>';
  byId('truthFlags').innerHTML = [
    ['carried over', result.carriedOver, 'Carried over', 'First decided before the cut and settled by the current pipeline.'],
    ['awaiting re-gate', result.gateOnly, 'Awaiting KESTREL re-gate', 'Accepted under the GLM-5.2 gate only; waiting for the KESTREL re-gate.'],
    ['possible duplicates', result.possibleDuplicates, 'Possible duplicates', 'Same task name and trainer as another task in scope.'],
    ['packages at the bar', result.atCurrentBar, 'Packages at the current bar', 'A package is collectable at the current bar.'],
  ].map(([label, value, chain, tip]) => stat(label, value, result.rows.length, `${tip} Share of the ${fmt(result.rows.length)} tasks shown; a task can carry several flags.`, chain, 'slate')).join('');
  animateCounts(byId('truthJoin')); animateCounts(byId('truthFlags'));
}

function renderChain(label, filtered) {
  const chain = window.chainFor(truth, label, filtered);
  const panel = byId('truthChainPanel');
  if (!chain) { panel.hidden = true; return; }
  openChain = label;
  panel.hidden = false;
  setText('truthChainTitle', `${chain.label}: ${fmt(chain.value)}`);
  setText('truthChainNote', (chain.note || '') +
    (chain.stale ? ' Shown for the whole population; the cards reflect your filters.' : ''));
  const base = Math.max(1, ...chain.steps.map(step => step.count));
  byId('truthChain').innerHTML = chain.steps.map((step, index) => `
    <li${index === chain.steps.length - 1 ? ' class="is-final"' : ''}>
      <span class="chain-count">${fmt(step.count)}</span>
      <span class="chain-body"><span class="chain-step">${esc(step.step)}</span>
        <span class="chain-bar"><i style="width:${Math.max(1, (step.count / base) * 100)}%"></i></span></span>
    </li>`).join('');
  document.querySelectorAll('[data-chain]').forEach(node =>
    node.setAttribute('aria-pressed', String(node.dataset.chain === label)));
}

// The flags a task row can carry.
//
// They used to sit beside the task name and crowded it out - at eight rows on a
// page the name was truncated to "ho..." and on a few rows it disappeared
// entirely. They have a column of their own now, shown as short codes with the
// full explanation on hover and a legend under the table, so the name always
// has the space.
const FLAGS = [
  {code: 'DL', tone: 'good', when: row => row.delivered,
   label: 'delivered',
   tip: row => 'Already covered by the delivery audit on the Delivery tab, matched by ' +
     (row.deliveredVia === 'normalised name'
       ? 'name once version and status suffixes were stripped'
       : row.deliveredVia === 'embedded in the verdict identifier'
         ? 'the task name recorded inside its verdict identifier'
         : 'an exact name match') + '.'},
  {code: row => `×${fmt(row.versions)}`, tone: 'info', when: row => row.versions > 1,
   label: '×N  N versions, counted once',
   tip: row => `This task has ${fmt(row.versions)} versions in the pipeline and is counted once ` +
     `while the Delivered filter is on. Showing the one ${row.chosenBecause}. The others: ` +
     row.otherVersions.map(v => `${v.name} (${v.state}${v.decided ? `, ${v.decided}` : ''})`).join('; ') + '.'},
  {code: 'CK', tone: 'alert', when: row => row.maybeDelivered,
   label: 'check before shipping',
   tip: row => `This task's identifier names "${row.maybeDelivered}", which the delivery audit ` +
     'already covers, but its own name does not match it. It may be a second copy of work that has already gone out.'},
  {code: 'DUP', tone: row => (row.duplicateTier === 'likely' ? 'alert' : 'warn'),
   when: row => row.possibleDuplicate,
   label: 'possible duplicate',
   tip: row => `Same task name and trainer as ${fmt(row.duplicateSiblings)} other task` +
     `${row.duplicateSiblings === 1 ? '' : 's'}` +
     `${row.duplicateSameDay && row.duplicateSameState ? ', decided the same day with the same outcome' : ''}.`},
  {code: 'UM', tone: 'warn', when: row => row.unmerged && !row.possibleDuplicate,
   label: 'unmerged',
   tip: () => 'This submission carried no family id, so it is keyed on its own submission id. ' +
     'Repeat runs of the same task may be counted separately. No other task in scope shares its name and trainer.'},
  {code: 'CO', tone: 'flat', when: row => row.carriedOver,
   label: 'carried over',
   tip: () => `First decided before ${truth.cut} and settled after it, so this is backlog cleared ` +
     'by the current pipeline rather than new work.'},
];

function flagBadges(row) {
  const shown = FLAGS.filter(flag => flag.when(row));
  if (!shown.length) return '<span class="flag-none">-</span>';
  return shown.map(flag => {
    const tone = typeof flag.tone === 'function' ? flag.tone(row) : flag.tone;
    const code = typeof flag.code === 'function' ? flag.code(row) : flag.code;
    return `<span class="flag flag-${esc(tone)}" title="${esc(flag.tip(row))}">${esc(code)}</span>`;
  }).join('');
}

// Only the codes actually present are explained, so the legend stays short and
// never describes something that is not on screen.
function renderFlagLegend(rows) {
  const node = byId('truthFlagLegend');
  if (!node) return;
  const used = FLAGS.filter(flag => rows.some(row => flag.when(row)));
  node.hidden = used.length === 0;
  node.innerHTML = used.map(flag => {
    const code = typeof flag.code === 'function' ? '×N' : flag.code;
    const tone = typeof flag.tone === 'function' ? 'warn' : flag.tone;
    const [head, ...rest] = flag.label.split('  ');
    return `<span class="legend-item"><span class="flag flag-${esc(tone)}">${esc(code)}</span>` +
      `${esc(rest.length ? rest.join(' ') : head)}</span>`;
  }).join('');
}

function renderTruthRows(rows) {
  const size = pageSize('truthPageSize');
  const pages = Math.max(Math.ceil(rows.length / size), 1);
  truthPage = Math.min(truthPage, pages - 1);
  const from = truthPage * size;
  const slice = rows.slice(from, from + size);
  byId('truthRows').innerHTML = slice.length ? slice.map((row, index) => {
    const id = `truth-${truthPage}-${index}`;
    return `<tr class="drill-head">
      <td><button class="drill-toggle" aria-expanded="false" aria-controls="${id}" aria-label="Evidence for ${esc(row.name)}">+</button></td>
      <td class="num serial">${fmt(from + index + 1)}</td>
      <td><div class="taskcell"><span class="taskname" title="${esc(row.name)}">${esc(row.name)}</span></div></td>
      <td class="flagcell">${flagBadges(row)}</td>
      <td><span class="state state-${esc(row.state.replace(/\s+/g, '-'))}">${esc(row.state)}</span></td>
      <td>${esc(row.owner || '\u2013')}</td>
      <td>${esc(row.decided || '\u2013')}${row.decidedInferred ? '<span class="chip chip-warn" title="No decision timestamp on the verdict; dated from when it was last updated">approx</span>' : ''}</td>
      <td>${esc(row.gateEra)}</td>
      <td class="num">${fmt(row.runs)}</td>
    </tr>
    <tr class="drill" id="${id}" hidden><td colspan="9">
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
  }).join('') : '<tr><td colspan="9" class="empty">No tasks match these filters.</td></tr>';
  setText('truthPage', `${fmt(from + 1)}\u2013${fmt(from + slice.length)} of ${fmt(rows.length)}`);
  byId('truthPrev').disabled = truthPage === 0;
  byId('truthNext').disabled = truthPage >= pages - 1;
}

// What the delivered join could not account for.
//
// The Delivery tab lists 412 audited tasks and the Pipeline shows fewer, which
// reads as data missing unless the difference is stated. It is two separate
// things - tasks folded because they are the same work, and tasks with no
// counterpart in the bucket at all - so both are named rather than netted off.
function renderJoinGap(result) {
  const note = byId('truthJoinNote');
  if (!note) return;
  const idx = truth?.deliveredIndex;
  if (!idx || !result.collapsed) {
    note.hidden = true;
    byId('unmatchedPanel').hidden = true;
    byId('unmatchedShow').setAttribute('aria-expanded', 'false');
    return;
  }
  const c = idx.counts;
  note.hidden = false;
  setText('truthJoinText',
    `The Delivery tab lists ${fmt(c.auditedTasks)} audited tasks. ` +
    `${fmt(c.auditedMatched)} of them were found in this bucket and are shown above, ` +
    `folded where one task had several versions. ` +
    `${fmt(c.auditedUnmatched)} could not be found at all` +
    (c.unmatchedAccepted
      ? ` - ${fmt(c.unmatchedAccepted)} of those ${c.unmatchedAccepted === 1 ? 'is' : 'are'} recorded as accepted.` : '.'));
  const open = byId('unmatchedPanel').hidden === false;
  setText('unmatchedShow', open ? 'Hide them' : `Show the ${fmt(c.auditedUnmatched)} that could not be found`);
}

function renderUnmatched() {
  const idx = truth?.deliveredIndex;
  const rows = (idx && idx.unmatchedAudit) || [];
  setText('unmatchedNote',
    `These ${fmt(rows.length)} tasks appear on the Delivery tab but no task in ` +
    `${esc(truth.bucket)} carries their name, so the Pipeline has nothing to show for them. ` +
    'They are listed rather than netted off: a task missing from the bucket is a ' +
    'different problem from a task counted twice, and only one of them is ours to fix here.');
  byId('unmatchedRows').innerHTML = rows.length ? rows.map(row => `
    <tr>
      <td><div class="taskcell"><span class="taskname" title="${esc(row.task)}">${esc(row.task)}</span></div></td>
      <td>${esc(row.batch || '-')}</td>
      <td><span class="state state-${esc(String(row.acceptance || '').toLowerCase())}">${esc(row.acceptance || '-')}</span></td>
      <td class="muted">${esc(row.reason || '')}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">Every audited task was found.</td></tr>';
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
  const idx = truth.deliveredIndex;
  setText('truthCaveats', `${fmt(result.unmerged)} of ${fmt(result.rows.length)} shown are unmerged, so repeat runs of them may still count separately. ` +
    `${fmt(result.inferredDates)} carry no decision timestamp and are dated from when the verdict was last updated.` +
    (idx ? ` Delivered is joined from the ${fmt(idx.counts.auditedTasks)} tasks on the Delivery tab by name; ` +
      `${fmt(idx.counts.auditedUnmatched)} of those found no task here, ${fmt(idx.counts.unmatchedAccepted)} of them accepted.` : '') +
    (truth.deliveredStale ? ' The delivered join was built against an earlier pipeline than the one shown, so treat those two figures as out of date until it is rebuilt.' : ''));
  renderJoinGap(result);
  setText('truthAudit', (result.collapsed
      ? `${fmt(result.rows.length)} tasks shown, folded from ${fmt(result.submissions)} pipeline rows ` +
        `(${fmt(result.versionsFolded)} repeat versions counted once) / `
      : `${fmt(result.rows.length)} of ${fmt(truth.rows.length)} tasks shown / `) +
    `${fmt(result.atCurrentBar)} have a package at the current bar / ${fmt(result.gateOnly)} await a KESTREL re-gate / ` +
    `${fmt(result.owners)} trainers.`);
  renderManifestBar(result);
  renderTruthRows(result.rows);
  renderFlagLegend(result.rows);
}

// --- delivery manifest -----------------------------------------------------
// Names claimed by a manifest the user has already issued. Held only for this
// visit: it is a convenience for cutting a second round, not a record. The
// authoritative record of what went out is the delivery audit itself.
let manifestExclusions = [];
let manifestExcludedFrom = '';

function manifestCandidates(result) {
  // Whatever the table is showing, which is already the ready population plus
  // any further filters the user set. The manifest never widens that.
  return result.rows;
}

function renderManifestBar(result) {
  const bar = byId('manifestBar');
  if (!bar) return;
  const ready = byId('tDelivered')?.value === 'ready';
  bar.hidden = !ready;
  if (!ready) return;

  const preview = window.buildManifest(manifestCandidates(result), {
    size: Number(byId('manifestSize').value),
    exclude: manifestExclusions,
  });
  const s = preview.selection;
  setText('manifestNote',
    `${fmt(s.distinctTasks)} distinct tasks in ${fmt(s.rowsConsidered)} rows currently shown. ` +
    'One entry per task, so a task submitted twice is delivered once.');
  setText('manifestSummary',
    `Would write ${fmt(preview.counts.tasks)} tasks` +
    (preview.counts.supersededRows
      ? `, standing for ${fmt(preview.counts.rowsRepresented)} rows ` +
        `(${fmt(preview.counts.supersededRows)} repeat submission${preview.counts.supersededRows === 1 ? '' : 's'} left out)` : '') +
    ` / ${fmt(preview.counts.owners)} trainers` +
    (s.excludedByPreviousManifest
      ? ` / ${fmt(s.excludedByPreviousManifest)} excluded by ${esc(manifestExcludedFrom || 'a previous manifest')}` : '') +
    (preview.counts.possiblyAlreadyDelivered
      ? ` / ${fmt(preview.counts.possiblyAlreadyDelivered)} flagged to check - their identifier names a task the audit already covers` : '') +
    (preview.counts.namesDerived
      ? ` / ${fmt(preview.counts.namesDerived)} carry a placeholder name and take a readable one from their verdict identifier` : '') +
    (s.shortBy ? ` / ${fmt(s.shortBy)} short of the ${fmt(s.requested)} asked for - only ${fmt(s.availableAfterExclusions)} are available.` : '.'));
  byId('manifestBuild').disabled = preview.counts.tasks === 0;
  byId('manifestClear').hidden = manifestExclusions.length === 0;
  [...bar.querySelectorAll('.size-chip')].forEach(chip => {
    const same = String(Number(chip.dataset.size)) === String(Number(byId('manifestSize').value) || 0);
    chip.setAttribute('aria-pressed', same ? 'true' : 'false');
  });
}

function downloadManifest() {
  if (!truth) return;
  const result = window.filterTruth(truth.rows, truthFilters());
  const manifest = window.buildManifest(manifestCandidates(result), {
    size: Number(byId('manifestSize').value),
    exclude: manifestExclusions,
    pipelineGeneratedAt: truth.generatedAt,
    deliveredIndexGeneratedAt: truth.deliveredIndex?.generatedAt || null,
    // The filters are recorded so the manifest says what it was cut from.
    // A manifest that cannot explain its own selection is not checkable.
    filters: Object.fromEntries(Object.entries(truthFilters()).filter(([, v]) => v)),
  });
  // 2026-09-19-103519: date and time stay separated, so the name sorts and
  // still reads as a date.
  const [day, time] = manifest.generatedAt.slice(0, 19).split('T');
  const stamp = `${day}-${time.replace(/:/g, '')}`;
  const blob = new Blob([JSON.stringify(manifest, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `manifest-${manifest.counts.tasks}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  // Carry it forward so the next cut in this visit does not reissue the same
  // work, and say so rather than doing it invisibly.
  manifestExclusions = [...new Set([...manifestExclusions,
    ...window.namesFromManifest(manifest)])];
  manifestExcludedFrom = `${link.download} and anything loaded before it`;
  renderTruth();
}

async function loadManifestExclusions(file) {
  if (!file) return;
  try {
    const names = window.namesFromManifest(JSON.parse(await file.text()));
    if (!names.length) throw new Error('no tasks in that file');
    manifestExclusions = [...new Set([...manifestExclusions, ...names])];
    manifestExcludedFrom = file.name;
  } catch (error) {
    setText('manifestSummary', `That file could not be read as a manifest: ${error.message}`);
    return;
  }
  renderTruth();
}

// Carried over: the backlog the current pipeline settled, read five ways.
let carriedExtra = {day: '', runs: '', finding: '', why: ''};
let carriedSort = {key: 'decided', dir: -1};
let carriedPage = 0;
const stateTone = state => `var(${STATE_TOKENS[state] || '--slate'})`;
const stateLabel = state => (state === 'error' ? 'no QC decision' : state);
const runsBucket = runs => (runs >= 8 ? '8+' : String(runs));

function carriedFilters() {
  return {
    state: byId('cState').value, owner: byId('cOwner').value, gateEra: byId('cGate')?.value || '',
    domain: byId('cDomain')?.value || '', duplicate: byId('cDuplicate')?.value || '',
    search: byId('cSearch').value, carriedOver: 'yes',
    start: dateRange.start, end: dateRange.end,
  };
}

function renderCarried() {
  if (!truth) return;
  const all = truth.rows.filter(row => row.carriedOver);
  const filters = carriedFilters();
  const base = window.filterTruth(truth.rows, filters).rows;
  const rows = base.filter(row => (!carriedExtra.day || row.decided === carriedExtra.day) &&
    (!carriedExtra.runs || runsBucket(row.runs) === carriedExtra.runs) &&
    (!carriedExtra.finding || (row.findingsAllRuns || row.findings || []).includes(carriedExtra.finding)) &&
    (!carriedExtra.why || row.why === carriedExtra.why));
  const shown = rows.length;
  const settledOf = list => list.filter(row => row.state === 'accepted' || row.state === 'legacy accepted').length;

  // Figures, each one a state filter.
  const figures = [
    ['Carried over', all.length, `first decided before ${truth.cut}, settled after`, 'slate', null],
    ['Now accepted', all.filter(r => r.state === 'accepted').length, 'package at the current bar', 'aqua', 'accepted'],
    ['Legacy accepted', all.filter(r => r.state === 'legacy accepted').length, 'accepted, not at the current bar', 'blue', 'legacy accepted'],
    ['Rejected', all.filter(r => r.state === 'rejected').length, 'failed a QC decision', 'yellow', 'rejected'],
    ['Still unresolved', all.filter(r => !['accepted', 'legacy accepted', 'rejected'].includes(r.state)).length, 'parked or crashed, no decision', 'orange', 'error'],
  ];
  const figuresHost = byId('carriedFigures');
  figuresHost.innerHTML = figures.map(([label, value, note, tone, state], index) => {
    const pressed = state ? byId('cState').value === state : false;
    const tag = state ? 'button' : 'div';
    return `<${tag} class="kpi kpi-button${state ? '' : ' kpi-static'}" data-tone="${tone}" style="--i:${index}"${state ? ` data-filter="cState" data-value="${esc(state)}" aria-pressed="${pressed}"` : ''}>
      <div class="kpi-top"><h3>${esc(label)}</h3></div>
      <strong data-count="${value}" data-key="carried:${esc(label)}">${fmt(value)}</strong>
      <p class="kpi-note">${esc(note)}</p>
      <span class="tile-share"><i style="--pct:${all.length ? Math.round((value / all.length) * 100) : 0}"></i></span>
      ${state ? `<span class="kpi-cue">${pressed ? 'filtering · click to clear' : 'click to filter'}</span>` : ''}
    </${tag}>`;
  }).join('');
  animateCounts(figuresHost);
  setText('carriedStatus', `${fmt(all.length)} tasks of the ${fmt(truth.rows.length)} in scope were first decided before ${truth.cut}; ` +
    `${fmt(settledOf(all))} reached an acceptance under the current pipeline. They are included in the Pipeline figures, not added to them.`);

  // When: stacked bars per settlement day, with the cleared share running above.
  const states = ['accepted', 'legacy accepted', 'rejected', 'error'];
  const days = Object.entries(groupBy(base.filter(row => row.decided), row => row.decided)).sort((a, b) => a[0].localeCompare(b[0]));
  const dayMax = Math.max(1, ...days.map(([, list]) => list.length));
  let cleared = 0;
  const totalDated = base.filter(row => row.decided).length || 1;
  byId('carriedDays').innerHTML = days.length ? `<div class="daychart-plot">${days.map(([day, list], index) => {
    cleared += list.length;
    const on = carriedExtra.day === day;
    return `<button type="button" class="daycol${on ? ' is-on' : ''}" style="--i:${index};--cum:${Math.round((cleared / totalDated) * 100)}" data-extra="day" data-value="${esc(day)}" data-tip="${esc(day)}: ${fmt(list.length)} settled · ${states.filter(st => list.some(r => r.state === st)).map(st => `${fmt(list.filter(r => r.state === st).length)} ${stateLabel(st)}`).join(', ')} · ${Math.round((cleared / totalDated) * 100)}% of the backlog cleared by now">
      <span class="daycol-bar" style="height:${Math.round((list.length / dayMax) * 100)}%">${states.map(st => { const n = list.filter(r => r.state === st).length; return n ? `<i style="flex:${n};--c:${stateTone(st)}"></i>` : ''; }).join('')}</span>
      <b class="daycol-n">${fmt(list.length)}</b>
      <span class="daycol-x">${esc(day.slice(5))}</span>
      <span class="daycol-dot" aria-hidden="true"></span>
    </button>`;
  }).join('')}</div>` : '<p class="empty">No settled tasks match these filters.</p>';
  byId('carriedDaysKey').innerHTML = states.map(st => `<span class="key-item"><i style="background:${stateTone(st)}"></i>${esc(stateLabel(st))}</span>`).join('') + '<span class="key-item"><i class="key-line"></i>share of backlog cleared</span>';
  setText('carriedDaysNote', `${fmt(days.length)} settlement days between ${days[0]?.[0] || '-'} and ${days[days.length - 1]?.[0] || '-'} · click a day to filter`);

  // Attempts: a histogram of runs, stacked by state.
  const buckets = ['2', '3', '4', '5', '6', '7', '8+'];
  const byRuns = groupBy(base, row => runsBucket(row.runs));
  const runsMax = Math.max(1, ...buckets.map(b => (byRuns[b] || []).length));
  byId('carriedRuns').innerHTML = `<div class="hist-plot">${buckets.map((bucket, index) => {
    const list = byRuns[bucket] || [];
    const on = carriedExtra.runs === bucket;
    return `<button type="button" class="histcol${on ? ' is-on' : ''}${list.length ? '' : ' is-empty'}" style="--i:${index}" data-extra="runs" data-value="${bucket}" data-tip="${bucket} run${bucket === '1' ? '' : 's'}: ${fmt(list.length)} tasks · ${fmt(settledOf(list))} accepted">
      <span class="histcol-bar" style="height:${Math.round((list.length / runsMax) * 100)}%">${states.map(st => { const n = list.filter(r => r.state === st).length; return n ? `<i style="flex:${n};--c:${stateTone(st)}"></i>` : ''; }).join('')}</span>
      <b class="histcol-n">${list.length ? fmt(list.length) : ''}</b>
      <span class="histcol-x">${bucket}</span>
    </button>`;
  }).join('')}</div>`;
  const runsSorted = base.map(row => row.runs).sort((a, b) => a - b);
  const median = runsSorted.length ? runsSorted[Math.floor(runsSorted.length / 2)] : 0;
  const fivePlus = base.filter(row => row.runs >= 5).length;
  const most = runsSorted[runsSorted.length - 1] || 0;
  setText('carriedRunsInsight', base.length
    ? `Median ${fmt(median)} runs to settle · ${fmt(fivePlus)} task${fivePlus === 1 ? '' : 's'} needed five or more · the longest took ${fmt(most)}.`
    : '');

  // Who: the trainers with the most carried-over tasks.
  const owners = Object.entries(groupBy(base.filter(row => row.owner), row => row.owner)).map(([owner, list]) => ({owner, n: list.length, settled: settledOf(list)})).sort((a, b) => b.n - a.n || b.settled - a.settled).slice(0, 8);
  const ownerMax = Math.max(1, ...owners.map(o => o.n));
  byId('carriedOwners').innerHTML = owners.length ? owners.map((o, index) => `
    <button type="button" class="leader-row${byId('cOwner').value === o.owner ? ' is-on' : ''}" style="--i:${index}" data-filter="cOwner" data-value="${esc(o.owner)}" data-tip="${esc(o.owner)}: ${fmt(o.n)} carried over, ${fmt(o.settled)} accepted">
      <div class="rank${index < 3 ? ` medal medal-${index + 1}` : ''}">${index + 1}</div>
      <div class="person"><strong>${esc(o.owner.split('@')[0])}</strong><span>${fmt(o.settled)} of ${fmt(o.n)} accepted</span></div>
      <div class="bar-track"><div class="bar-fill is-split" style="width:${Math.round((o.n / ownerMax) * 100)}%"><i style="width:${Math.round((o.settled / o.n) * 100)}%"></i></div></div>
      <div class="amount is-plain" data-count="${o.n}" data-key="owner:${esc(o.owner)}">${fmt(o.n)}</div>
    </button>`).join('') : '<p class="empty">No trainers in this selection.</p>';
  setText('carriedOwnersNote', `${fmt(new Set(base.map(row => row.owner).filter(Boolean)).size)} trainers hold the ${fmt(base.length)} shown · accepted share drawn inside each bar`);

  // Where: gate era, domain and duplicate flags as clickable split bars.
  const PALETTE = ['--accent', '--blue', '--aqua', '--violet', '--magenta', '--orange', '--yellow', '--slate'];
  const splitBar = (label, key, filter, order) => {
    const entries = Object.entries(groupBy(base, row => key(row))).map(([k, list]) => [k, list.length]);
    entries.sort(order || ((a, b) => b[1] - a[1]));
    const sum = entries.reduce((n, [, v]) => n + v, 0) || 1;
    return `<div class="split-row"><span class="split-label">${label}</span>
      <span class="split-bar">${entries.map(([k, n], index) => `<button type="button" class="split-seg${byId(filter)?.value === k ? ' is-on' : ''}" style="flex:${n};--c:var(${PALETTE[index % PALETTE.length]})" data-filter="${filter}" data-value="${esc(k)}" data-tip="${esc(k)}: ${fmt(n)} (${Math.round((n / sum) * 100)}%)">${n / sum >= 0.08 ? `<span>${esc(k)}</span><b>${fmt(n)}</b>` : ''}</button>`).join('')}</span></div>`;
  };
  const dupKey = row => (row.duplicateTier === 'likely' ? 'likely' : row.possibleDuplicate ? 'yes' : 'no');
  const dupName = {yes: 'Possible duplicate', likely: 'Likely duplicate', no: 'Not flagged'};
  byId('carriedSplits').innerHTML = base.length
    ? splitBar('Gate', row => row.gateEra || 'Not recorded', 'cGate') +
      splitBar('Domain', row => row.domain || 'Not recorded', 'cDomain') +
      `<div class="split-row"><span class="split-label">Duplicates</span><span class="split-bar">${['no', 'yes', 'likely'].map((k, index) => {
        const n = base.filter(row => dupKey(row) === k).length;
        return n ? `<button type="button" class="split-seg${byId('cDuplicate')?.value === k ? ' is-on' : ''}" style="flex:${n};--c:var(${['--slate', '--yellow', '--red'][index]})" data-filter="cDuplicate" data-value="${k}" data-tip="${dupName[k]}: ${fmt(n)} (${Math.round((n / base.length) * 100)}%)">${n / base.length >= 0.08 ? `<span>${dupName[k]}</span><b>${fmt(n)}</b>` : ''}</button>` : '';
      }).join('')}</span></div>`
    : '<p class="empty">Nothing in this selection.</p>';

  // Why each task settled the way it did, and the findings raised on the way.
  const whys = Object.entries(groupBy(base, row => row.why || 'Not recorded')).map(([k, list]) => [k, list.length]).sort((a, b) => b[1] - a[1]);
  const findings = Object.entries(base.reduce((acc, row) => { (row.findingsAllRuns || row.findings || []).forEach(f => { acc[f] = (acc[f] || 0) + 1; }); return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const miniList = (entries, extra, tone) => {
    const top = Math.max(1, ...entries.map(([, n]) => n));
    return entries.map(([k, n], index) => `<button type="button" class="mini-row${carriedExtra[extra] === k ? ' is-on' : ''}" style="--i:${index};--c:${tone(k, index)}" data-extra="${extra}" data-value="${esc(k)}" data-tip="${esc(k)}: ${fmt(n)} of ${fmt(base.length)}">
      <span class="mini-label">${esc(k)}</span><span class="mini-track"><i style="--pct:${Math.round((n / top) * 100)}"></i></span><b>${fmt(n)}</b></button>`).join('');
  };
  byId('carriedSplits').insertAdjacentHTML('beforeend', base.length ? `
    <div class="facet"><p class="subhead">Why it settled that way</p><div class="minilist">${miniList(whys, 'why', k => stateTone(k.startsWith('accepted and') ? 'accepted' : k.startsWith('acceptance withdrawn') ? 'legacy accepted' : k.startsWith('reached') ? 'rejected' : 'error'))}</div></div>
    <div class="facet"><p class="subhead">Findings raised on any run<em>top ${fmt(findings.length)}</em></p><div class="minilist">${findings.length ? miniList(findings, 'finding', () => 'var(--accent)') : '<p class="empty">No findings recorded.</p>'}</div></div>` : '');

  // Chips and the table.
  const labels = {cState: 'State', cOwner: 'Trainer', cGate: 'Gate', cDomain: 'Domain', cDuplicate: 'Duplicates', cSearch: 'Search'};
  const active = Object.keys(labels).map(id => [id, byId(id)?.value]).filter(([, value]) => value)
    .concat(carriedExtra.day ? [['day', carriedExtra.day]] : [], carriedExtra.runs ? [['runs', `${carriedExtra.runs} runs`]] : [],
      carriedExtra.finding ? [['finding', carriedExtra.finding]] : [], carriedExtra.why ? [['why', carriedExtra.why]] : []);
  byId('carriedChips').innerHTML = active.length
    ? active.map(([id, value]) => `<button type="button" class="chipbtn" data-clear="${id}"><span>${labels[id] || {day: 'Settled on', runs: 'Runs', finding: 'Finding', why: 'Why'}[id]}</span>${esc(id === 'cDuplicate' ? dupName[value] || value : value)}<i aria-hidden="true">×</i></button>`).join('') +
      '<button type="button" class="chipbtn is-clear" data-clear="all">Clear all</button>'
    : '<span class="chips-empty">No filters applied · click any figure, day, bar or segment to filter</span>';
  setText('carriedAudit', `${fmt(shown)} of ${fmt(all.length)} shown · ${fmt(settledOf(rows))} reached an acceptance · ${fmt(new Set(rows.map(r => r.owner).filter(Boolean)).size)} trainers`);
  renderCarriedRows(rows);
}

function renderCarriedRows(rows) {
  const size = pageSize('carriedPageSize');
  const sorted = [...rows].sort((a, b) => {
    const key = carriedSort.key;
    const va = key === 'runs' ? a.runs : String(a[key] || '');
    const vb = key === 'runs' ? b.runs : String(b[key] || '');
    return (va < vb ? -1 : va > vb ? 1 : 0) * carriedSort.dir || String(a.name).localeCompare(String(b.name));
  });
  const pages = Math.max(Math.ceil(sorted.length / size), 1);
  carriedPage = Math.min(carriedPage, pages - 1);
  const from = carriedPage * size;
  const slice = sorted.slice(from, from + size);
  document.querySelectorAll('#carriedTable .sort').forEach(button => {
    const on = button.dataset.sort === carriedSort.key;
    button.classList.toggle('is-on', on);
    button.dataset.dir = on ? (carriedSort.dir > 0 ? 'asc' : 'desc') : '';
  });
  byId('carriedRows').innerHTML = slice.length ? slice.map((row, index) => {
    const id = `carried-drill-${from + index}`;
    return `
    <tr class="drill-head" style="--i:${index}">
      <td><button class="drill-toggle" aria-expanded="false" aria-controls="${id}" aria-label="Details for ${esc(row.name)}">+</button></td>
      <td class="num serial">${fmt(from + index + 1)}</td>
      <td><div class="taskcell"><span class="taskname" title="${esc(row.name)}">${esc(row.name)}</span>
        ${row.atCurrentBar ? '<span class="flag flag-good" title="Package at the current bar">BAR</span>' : ''}${row.gateOnly ? '<span class="flag flag-warn" title="Awaiting KESTREL re-gate">RG</span>' : ''}${row.possibleDuplicate ? `<span class="flag ${row.duplicateTier === 'likely' ? 'flag-alert' : 'flag-warn'}" title="${row.duplicateTier === 'likely' ? 'Likely' : 'Possible'} duplicate of ${fmt(row.duplicateSiblings)} other task${row.duplicateSiblings === 1 ? '' : 's'}">DUP</span>` : ''}</div></td>
      <td><span class="state state-${esc(row.state.replace(/\s+/g, '-'))}">${esc(row.state)}</span></td>
      <td>${row.owner ? `<span class="who"><i class="avatar">${esc(initials(row.owner))}</i><span>${esc(row.owner)}</span></span>` : '<span class="who is-none"><i class="avatar">?</i><span>Not recorded</span></span>'}</td>
      <td><span class="batch-chip">${esc(row.decided || '-')}</span></td>
      <td>${esc(row.gateEra)}</td>
      <td><span class="cat" style="--c:${auditTone('category', row.domain === 'Engineering' ? 'Code' : row.domain)}"><i></i>${esc(row.domain || 'Not recorded')}</span></td>
      <td class="num"><span class="runs-dots" data-tip="${fmt(row.runs)} runs recorded">${Array.from({length: Math.min(row.runs, 7)}, () => '<i></i>').join('')}${row.runs > 7 ? '<i class="more"></i>' : ''}<b>${fmt(row.runs)}</b></span></td>
    </tr>
    <tr class="drill" id="${id}" hidden><td colspan="9">
      <dl class="drill-grid">
        <dt>Why</dt><dd>${esc(row.why || '-')}</dd>
        <dt>Findings</dt><dd>${(row.findings || []).length ? row.findings.map(f => `<span class="chip">${esc(f)}</span>`).join(' ') : 'none on the settling run'}</dd>
        <dt>Earlier runs</dt><dd>${(row.findingsPrior || []).length ? row.findingsPrior.map(f => `<span class="chip">${esc(f)}</span>`).join(' ') : 'no findings recorded'}</dd>
        <dt>Cohorts</dt><dd>${(row.cohorts || []).length ? row.cohorts.map(esc).join(', ') : 'none'}</dd>
        <dt>Identity</dt><dd>${esc(row.confidence)} confidence${row.unmerged ? ' · unmerged' : ''}${row.canonicalReason ? ` · canonical run: ${esc(row.canonicalReason)}` : ''}</dd>
        <dt>Decided</dt><dd>${esc(row.decided || '-')}${row.decidedInferred ? ' (inferred from the verdict update)' : ''}</dd>
        <dt>Source</dt><dd><code>${esc(row.source || row.id)}</code></dd>
      </dl>
    </td></tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">No carried-over tasks match these filters.</td></tr>';
  setText('carriedPage', `${fmt(sorted.length ? from + 1 : 0)}–${fmt(from + slice.length)} of ${fmt(sorted.length)}`);
  byId('carriedPrev').disabled = carriedPage === 0;
  byId('carriedNext').disabled = carriedPage >= pages - 1;
}

function wireCarried() {
  const panel = byId('view-carried');
  if (!panel) return;
  const rerender = () => { carriedPage = 0; renderCarried(); };
  panel.addEventListener('click', event => {
    if (event.target.closest('a')) return;
    const pick = event.target.closest('[data-filter][data-value]');
    if (pick) {
      const select = byId(pick.dataset.filter);
      if (select && [...select.options].some(o => o.value === pick.dataset.value)) {
        select.value = select.value === pick.dataset.value ? '' : pick.dataset.value;
        rerender();
      }
      return;
    }
    const extra = event.target.closest('[data-extra][data-value]');
    if (extra) {
      const key = extra.dataset.extra;
      carriedExtra[key] = carriedExtra[key] === extra.dataset.value ? '' : extra.dataset.value;
      rerender();
      return;
    }
    const chip = event.target.closest('#carriedChips [data-clear]');
    if (chip) {
      const id = chip.dataset.clear;
      if (id === 'all') { byId('cReset').click(); return; }
      if (id in carriedExtra) carriedExtra[id] = ''; else if (byId(id)) byId(id).value = '';
      rerender();
      return;
    }
    const head = event.target.closest('#carriedRows .drill-head');
    if (head) {
      const drill = head.nextElementSibling;
      const open = head.classList.toggle('is-open');
      if (drill) drill.hidden = !open;
      const toggle = head.querySelector('.drill-toggle');
      if (toggle) { toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? '−' : '+'; }
    }
  });
  panel.querySelectorAll('#carriedTable .sort').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    carriedSort = carriedSort.key === key ? {key, dir: -carriedSort.dir} : {key, dir: key === 'runs' || key === 'decided' ? -1 : 1};
    renderCarried();
  }));
  ['cGate', 'cDomain', 'cDuplicate', 'carriedPageSize'].forEach(id => byId(id)?.addEventListener('change', rerender));
  byId('carriedPrev')?.addEventListener('click', () => { carriedPage -= 1; renderCarried(); });
  byId('carriedNext')?.addEventListener('click', () => { carriedPage += 1; renderCarried(); });
}

async function loadGcsPipeline(manual = false) {
  try {
    const response = await fetch(`assets/gcs-pipeline.json?refresh=${manual ? Date.now() : 'startup'}`, {cache:'no-store'});
    if (!response.ok) throw new Error('GCS export unavailable');
    const payload = await response.json();
    if (payload.schemaVersion !== 3 || !['current','historical','legacy'].every(key=>Array.isArray(payload[key])) || !Array.isArray(payload.finalisation?.tasks)) throw new Error('Invalid GCS export');
    ['current', 'historical', 'legacy'].forEach(key => payload[key].forEach(task => { task.domain = pipelineDomain(task); }));
    gcsPipeline = payload;
    loadFinalisation(); renderDonut(); renderTrainerRows();
    renderSources(); renderHero(); renderTopPendingCards(); renderBenchCards();
    if (manual) setTextIfPresent('pipelineSourceStatus', `Latest published GCS export loaded: ${gcsPipeline.generatedAt}`);
  } catch (error) {
    setTextIfPresent('pipelineSourceStatus', `GCS export not loaded: ${error.message}`);
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

// Rows per page, from the table's own control.
function pageSize(id) {
  const value = Number(byId(id)?.value);
  return value > 0 ? value : 10;
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
// The same state is the same colour in the delta chart as in the status pills.
const STATE_TOKENS = {
  accepted: '--aqua', 'legacy accepted': '--blue', rejected: '--yellow',
  error: '--orange', running: '--violet', queued: '--magenta',
};

// Numbers glide to their new value instead of snapping; the last shown value
// is remembered per key so a re-render animates from where it was.
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const shownCounts = new Map();
function animateCount(node, target, kind = 'int') {
  if (!node) return;
  const key = node.dataset.key || node.id;
  const format = kind === 'money' ? money : kind === 'pct' ? v => `${Math.round(v)}%` : fmt;
  const from = shownCounts.has(key) ? shownCounts.get(key) : 0;
  shownCounts.set(key, target);
  // Frames do not run in a hidden tab, so write the value straight away there.
  if (REDUCED_MOTION || document.hidden || from === target) { node.textContent = format(target); return; }
  const token = (node.countToken = (node.countToken || 0) + 1);
  const start = performance.now();
  const duration = 700;
  const step = now => {
    if (node.countToken !== token) return;
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = format(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function animateCounts(root) {
  root.querySelectorAll('[data-count]').forEach(node => animateCount(node, Number(node.dataset.count), node.dataset.kind || 'int'));
}
function setCount(id, value, kind = 'int') {
  const node = byId(id);
  if (!node) return;
  if (value == null) { node.textContent = '-'; shownCounts.delete(id); return; }
  animateCount(node, value, kind);
}

// A status picked in Current evaluations is echoed across the bench cards.
let focusStatus = null;

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
  // Published totals are displayed as published; per-row sums are the fallback.
  const totals = payoutLedger?.totals;
  const summary = {
    paidAmount: totals ? totals.paidAmount : sum(rows, 'paidAmount'),
    pendingAmount: totals ? totals.pendingAmount : sum(rows, 'pendingAmount'),
    pendingTasks: totals ? totals.pendingTasks : sum(rows, 'pendingTasks'),
    paidTasks: totals ? totals.paidTasks : sum(rows, 'paidTasks'),
    acceptedTasks: totals ? totals.acceptedTasks : sum(rows, 'acceptedTasks'),
    activeTrainers: data.summary?.activeTrainers ?? rows.filter(r => String(r.status).toLowerCase() === 'active').length,
    totalTrainers: data.summary?.totalTrainers ?? rows.length,
  };
  const generated = new Date(data.meta.generatedAt);
  const paid = summary.paidAmount;
  const pending = summary.pendingAmount;
  const totalExposure = paid + pending;
  const paidPct = Math.round((paid / (totalExposure || 1)) * 100);

  setText("generatedAt", generated.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }));
  setText('scanAt', gcsPipeline ? new Date(gcsPipeline.generatedAt).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'}) : 'not loaded');
  setCount('heroPending', pending, 'money');
  setText("heroExposureText", `${paidPct}% paid / ${fmt(summary.pendingTasks)} tasks pending`);
  renderExposureChart(rows);

  const dated = Boolean(dateRange.start || dateRange.end);
  setCount('metricAccepted', snapshot.ready ? snapshot.tasks.size : null);
  // The iteration-2 count is rebuilt from the folder rows so it follows the date
  // range, rather than reading the cohort's static all-time total.
  const v2Folders = snapshot.folders.filter(row => row.cohort === 'finalisation_client_qc_accepted_iteration_2');
  const v2 = snapshot.ready ? {tasks: v2Folders.length} : null;
  setCount('metricClientAccepted', clientAcceptance ? clientAcceptance.accepted : null);
  setText('metricClientAcceptedNote', clientAcceptance
    ? `Priority Low of ${fmt(clientAcceptance.tasks)} audited tasks${clientAcceptance.live ? '' : ' / saved snapshot'}${dated ? ' / all dates: the 240 dashboard snapshot carries counts only' : ''}`
    : 'Harbor 240 dashboard unavailable');
  setCount('metricV2Accepted', v2 ? v2.tasks : null);
  setText('metricV2AcceptedNote', v2 ? `of ${fmt(finalisationRows.length)} accepted folders` : '');
  setCount('metricPaid', paid, 'money');
  setCount('metricPendingTasks', summary.pendingTasks);
  setText("metricPending", `${money(pending)} pending`);
  setCount('metricActive', summary.activeTrainers);
  setText("metricRoster", `${fmt(summary.totalTrainers)} total trainer records`);
  setText('commandSourceStatus', gcsPipeline
    ? `${fmt(snapshot.current.length)} evaluations \u00b7 ${fmt(snapshot.folders.length)} folders${(dateRange.start || dateRange.end) ? ` \u00b7 ${rangeLabel().toLowerCase()}` : ''}`
    : 'Waiting for the bucket scan.');
  const current = gcsPipeline ? snapshot.current.length : null;
  const pipelineAccepted = gcsPipeline ? snapshot.current.filter(row => row.status === 'Accepted').length : null;
  const share = (value, base) => (value == null || !base) ? null : Math.round((value / base) * 100);
  const tiles = [
    ['Current evaluated tasks', current, null, 'aqua'],
    ['Pipeline accepted', pipelineAccepted, share(pipelineAccepted, current), 'aqua'],
    ['Accepted finalisation folders', finalisationRows.length ? snapshot.folders.length : null, null, 'blue'],
    ['Cross-cohort repeats excluded', snapshot.ready ? snapshot.duplicates : null, share(snapshot.ready ? snapshot.duplicates : null, snapshot.folders.length), 'yellow'],
  ];
  const summaryHost = byId('commandSummary');
  summaryHost.innerHTML = tiles.map(([label, value, pct, tone], index) => `<div class="summary-item" style="--i:${index}" data-tone="${tone}">
      <span>${label}</span>
      <strong data-count="${value == null ? '' : value}" data-key="tile:${esc(label)}">${value == null ? '-' : fmt(value)}</strong>
      ${pct == null ? '' : `<span class="tile-share"><i style="--pct:${pct}"></i><em>${pct}% of ${index === 1 ? 'current tasks' : 'folders'}</em></span>`}
    </div>`).join('');
  summaryHost.querySelectorAll('[data-count=""]').forEach(node => node.removeAttribute('data-count'));
  animateCounts(summaryHost);
  setText('commandOwnership', snapshot.ready
    ? `${fmt(snapshot.unassigned)} without a roster-linked owner`
    : '');

  const detail = (id, items) => { const node = byId(id); if (node) node.innerHTML = items.filter(Boolean).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join(''); };
  const cohorts = Object.entries(groupBy(snapshot.folders, row => row.cohortLabel || 'Unlabelled')).map(([k, r]) => [k, r.length]).sort((a, b) => b[1] - a[1]);
  detail('detailAccepted', snapshot.ready ? [
    ['Folders in accepted cohorts', fmt(snapshot.folders.length)],
    ['Same task in more than one cohort', fmt(snapshot.duplicates)],
    ...cohorts.map(([k, v]) => [k, fmt(v)]),
  ] : []);
  detail('detailClient', clientAcceptance ? [
    ['Audited tasks', fmt(clientAcceptance.tasks)],
    ['Accepted = priority Low', fmt(clientAcceptance.accepted)],
    ...Object.entries(clientAcceptance.priorities || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [`Priority ${k}`, fmt(v)]),
    [clientAcceptance.live ? 'Read live from the 240 dashboard' : 'Saved snapshot', clientAcceptance.live ? 'yes' : (clientAcceptance.generatedAt || '').slice(0, 10)],
  ] : []);
  detail('detailV2', v2 ? [
    ['Folders in this cohort', fmt(v2.tasks)],
    ['All accepted folders', fmt(finalisationRows.length)],
    ['Share of accepted folders', `${Math.round((v2.tasks / (finalisationRows.length || 1)) * 100)}%`],
  ] : []);
  const teams = Object.entries(groupBy(rows, r => r.team || 'Unassigned')).map(([k, r]) => [k, r.length]).sort((a, b) => b[1] - a[1]);
  detail('detailTrainers', [
    ['Roster records', fmt(summary.totalTrainers)],
    ['Marked active', fmt(summary.activeTrainers)],
    ...teams.map(([k, v]) => [k, fmt(v)]),
  ]);
  detail('detailPaid', [
    ['Tasks paid', fmt(summary.paidTasks)],
    ['Rate', '$300 per task'],
    payoutLedger ? ['Payment requests', fmt(payoutLedger.totals.paymentRequests)] : null,
    payoutLedger ? ['Ledger built', String(payoutLedger.generatedAt || '').slice(0, 10)] : null,
  ]);
  detail('detailPending', [
    ['Accepted tasks', fmt(summary.acceptedTasks)],
    ['Already paid', fmt(summary.paidTasks)],
    ['Pending = accepted \u2212 paid, never below 0', fmt(summary.pendingTasks)],
    ['Amount', money(pending)],
  ]);
  const owedBy = ['Company', 'Computer', 'Unassigned'].map(b => [b, rows.filter(r => benchOf(r.team) === b.toLowerCase()).reduce((n, r) => n + r.pendingAmount, 0)]).filter(([, v]) => v);
  detail('detailOwed', [
    ['Earned (paid + owed)', money(totalExposure)],
    ['Paid', money(paid)],
    ['Owed', money(pending)],
    ...owedBy.map(([k, v]) => [`Owed \u2014 ${k}`, money(v)]),
  ]);
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

// Each tile and panel names and links its sources.
function renderFigureSources() {
  document.querySelectorAll('.figure-src[data-source]').forEach(slot => {
    const links = slot.dataset.source.split(',').map(id => id.trim()).map(id => {
      const source = window.DASHBOARD_SOURCES.find(entry => entry.id === id);
      if (!source) return '';
      const state = sourceState(source);
      return source.href
        ? `<a href="${esc(source.href)}" target="_blank" rel="noopener" class="figure-srclink"
             data-tip="${esc(source.what)} / ${esc(state.detail)}">${esc(source.name)}</a>`
        : `<span class="figure-srclink is-flat" data-tip="${esc(source.hrefNote || source.what)}">${esc(source.name)}</span>`;
    }).filter(Boolean);
    slot.innerHTML = links.length
      ? `<span class="figure-src-label">Source</span>${links.join('<span class="figure-src-sep">/</span>')}`
      : '';
  });
}

function renderSources() {
  renderFigureSources();
  document.querySelectorAll('[data-sourcelist]').forEach(list => {
    const scope = list.dataset.sourcelist;
    const sources = scope === 'all' ? window.DASHBOARD_SOURCES : window.sourcesFor(scope);
    list.innerHTML = sources.map(source => {
      const state = sourceState(source);
      const name = source.href
        ? `<a href="${esc(source.href)}" target="_blank" rel="noopener">${esc(source.name)}</a>`
        : esc(source.name);
      return `<article class="srcrow" data-tone="${state.tone}" data-expand aria-expanded="false" tabindex="0">
        <div class="srcrow-head">
          <span class="srcrow-kind">${esc(source.kind)}</span>
          <span class="srcrow-name">${name}</span>
          <span class="srcrow-loc">${esc(source.location)}</span>
          <span class="pill" data-tone="${state.tone}">${esc(state.label)}</span>
          <span class="kpi-caret" aria-hidden="true"></span>
        </div>
        <div class="kpi-more"><div class="kpi-detail srcrow-detail">
          <div><span>What</span><b>${esc(source.what)}</b></div>
          <div><span>Why</span><b>${esc(source.why)}</b></div>
          <div><span>How</span><b>${esc(source.how)}</b></div>
          <div><span>Status</span><b>${esc(state.detail)}${source.hrefNote ? ` \u00b7 ${esc(source.hrefNote)}` : ''}</b></div>
          ${sourceTabs(source)}
        </div></div>
      </article>`;
    }).join('');
    const loaded = sources.filter(source => sourceState(source).tone === 'ok').length;
    setTextIfPresent('sourceNote', `${fmt(sources.length)} sources \u00b7 ${fmt(loaded)} read live this visit \u00b7 click a row for what, why and how`);
  });
  document.querySelectorAll('.sourcestrip').forEach(strip => {
    strip.innerHTML = '<span class="sourcestrip-label">Reading from</span>' +
      window.sourcesFor(strip.dataset.sources).map(source => {
        const state = sourceState(source);
        const body = `<span class="source-kind">${esc(source.kind)}</span>${esc(source.name)}<span class="chip-state" data-tone="${state.tone}">${esc(state.label)}</span>`;
        return source.href
          ? `<a class="source-chip" href="${esc(source.href)}" target="_blank" rel="noopener" data-tip="${esc(source.what)} / ${esc(state.detail)}">${body}</a>`
          : `<span class="source-chip is-flat" data-tip="${esc(source.hrefNote || source.what)}">${body}</span>`;
      }).join('');
  });
}

function renderExposureChart(rows) {
  // Paid against owed per bench, all bars on one scale.
  const benches = [['Company', 'company'], ['Computer', 'computer'], ['Unassigned', 'unassigned']]
    .map(([label, key]) => {
      const members = rows.filter(row => benchOf(row.team) === key);
      return {label, key, paid: sum(members, 'paidAmount'), pending: sum(members, 'pendingAmount'),
              paidTasks: sum(members, 'paidTasks'), pendingTasks: sum(members, 'pendingTasks')};
    })
    .filter(bench => bench.paid || bench.pending);
  const scale = Math.max(...benches.map(bench => bench.paid + bench.pending), 1);
  const paid = benches.reduce((value, bench) => value + bench.paid, 0);
  const owed = benches.reduce((value, bench) => value + bench.pending, 0);
  const settled = paid + owed ? Math.round((paid / (paid + owed)) * 100) : 0;
  setTextIfPresent('payoutBalanceNote', (benches.length
    ? `${money(paid + owed)} earned · ${money(paid)} paid · ${money(owed)} owed`
    : '') + (payoutLedgerError ? ' · ledger unavailable, workbook figures shown' : ''));
  const host = byId('exposureChart');
  host.innerHTML = benches.length ? `
    <div class="settle" data-tip="${money(paid)} paid of ${money(paid + owed)} earned">
      <div class="settle-head"><span>Settled</span><b data-count="${settled}" data-kind="pct" data-key="settle">${settled}%</b></div>
      <div class="settle-track"><i style="--pct:${settled}"></i><em style="--pct:${settled}"></em></div>
      <div class="settle-foot"><span>${money(paid)} paid</span><span>${money(owed)} still owed</span></div>
    </div>
    ${benches.map((bench, index) => {
      const benchTotal = bench.paid + bench.pending;
      return `<div class="bench-bar" data-bench="${bench.key}" style="--i:${index}">
        <div class="bench-bar-head"><span>${esc(bench.label)}</span><b data-count="${benchTotal}" data-kind="money" data-key="bar:${bench.key}">${money(benchTotal)}</b></div>
        <div class="stack" style="width:${Math.max((benchTotal / scale) * 100, 2)}%">
          ${segment('is-paid', bench.paid, scale, `${bench.label}: ${money(bench.paid)} paid for ${fmt(bench.paidTasks)} tasks`)}
          ${segment('is-pending', bench.pending, scale, `${bench.label}: ${money(bench.pending)} owed for ${fmt(bench.pendingTasks)} tasks`)}
        </div>
        <div class="bench-bar-foot">${fmt(bench.paidTasks)} of ${fmt(bench.paidTasks + bench.pendingTasks)} tasks paid</div>
      </div>`;
    }).join('')}
    <div class="chart-key">
      <span class="key-item is-paid">Paid</span>
      <span class="key-item is-pending">Owed</span>
    </div>` : '<p class="empty">No payouts in this selection.</p>';
  animateCounts(host);
}

function renderTopPendingCards() {
  if (!finalisationRows.length || !gcsPipeline) {
    byId('topPendingCards').innerHTML = '<p class="empty">Waiting for pipeline and finalisation data.</p>';
    return;
  }
  const rows = payoutRows()
    .filter((row) => row.pendingTasks > 0)
    .sort((a, b) => b.pendingAmount - a.pendingAmount || b.acceptedTasks - a.acceptedTasks)
    .slice(0, 8);
  const max = Math.max(...rows.map((row) => row.pendingAmount), 1);
  const host = byId('topPendingCards');
  host.innerHTML = rows.map((row, index) => `
        <div class="leader-row" role="button" tabindex="0" data-bench="${benchOf(row.team)}" data-person="${esc(row.name || row.email || '')}" style="--i:${index}" data-tip="Open ${esc(row.name || row.email || 'this person')} in Payouts">
          <div class="rank${index < 3 ? ` medal medal-${index + 1}` : ''}">${index + 1}</div>
          <div class="person">
            <strong>${esc(row.name || row.email || 'Unknown')}</strong>
            <span>${fmt(row.pendingTasks)} of ${fmt(row.acceptedTasks)} tasks unpaid · ${esc(row.team || 'no team')}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${safePct(row.pendingAmount, max)}"></div></div>
          <div class="amount" data-count="${row.pendingAmount}" data-kind="money" data-key="owed:${esc(row.email || row.name)}">${money(row.pendingAmount)}</div>
        </div>`).join('') || '<p class="empty">Nothing owed in this selection.</p>';
  animateCounts(host);
}

// Hovering a bench or a person lights up the other side of the panel; a click
// on a person opens them in Payouts.
function wirePayoutBalance() {
  const panel = document.querySelector('.panel-body.exposure');
  if (!panel) return;
  const link = (bench, on) => panel.querySelectorAll(`[data-bench="${bench}"]`).forEach(node => node.classList.toggle('is-linked', on));
  panel.addEventListener('mouseover', event => {
    const node = event.target.closest('[data-bench]');
    if (node) link(node.dataset.bench, true);
  });
  panel.addEventListener('mouseout', event => {
    const node = event.target.closest('[data-bench]');
    if (node) link(node.dataset.bench, false);
  });
  const open = row => {
    switchView('payouts');
    const search = byId('personSearch');
    if (search) { search.value = row.dataset.person; search.dispatchEvent(new Event('input', {bubbles: true})); }
  };
  panel.addEventListener('click', event => {
    const row = event.target.closest('.leader-row[data-person]');
    if (row) open(row);
  });
  panel.addEventListener('keydown', event => {
    const row = event.target.closest && event.target.closest('.leader-row[data-person]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(row); }
  });
}

function wireStatusFocus() {
  const pick = event => {
    const node = event.target.closest('[data-status]');
    if (!node) return;
    event.preventDefault();
    toggleFocusStatus(node.dataset.status);
  };
  ['pipelineDonut', 'benchCards'].forEach(id => {
    const host = byId(id);
    if (!host) return;
    host.addEventListener('click', pick);
    host.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') pick(event); });
  });
}

function renderDonut() {
  const host = byId('pipelineDonut');
  if (!gcsPipeline) { host.innerHTML = '<p class="empty">Waiting for the bucket scan.</p>'; return; }
  const entries = Object.entries(groupBy(commandSnapshot().current, row => row.status))
    .map(([key, rows]) => [key, rows.length]).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (focusStatus && !entries.some(([label]) => label === focusStatus)) focusStatus = null;
  host.classList.toggle('has-focus', Boolean(focusStatus));
  host.innerHTML = `<p class="rankbars-total"><b data-count="${total}" data-key="rank:total">${fmt(total)}</b> records, latest evaluation per task family` +
    `<span class="rankbars-hint">${focusStatus ? `Showing ${esc(focusStatus)} across benches · click again to clear` : 'Click a status to trace it across the benches'}</span></p>` +
    entries.map(([label, count], index) => {
      const pct = Math.round((count / (total || 1)) * 100);
      return `
    <div class="rankbar${index === 0 ? ' is-top' : ''}" role="button" tabindex="0" data-status="${esc(label)}" aria-pressed="${focusStatus === label}"
         style="--i:${index};--c:${statusColor(label)}" data-tip="${esc(label)}: ${fmt(count)} of ${fmt(total)} (${pct}%)">
      <span class="rankbar-label">${esc(label)}${index === 0 ? '<em class="rankbar-badge">most</em>' : ''}</span>
      <span class="rankbar-track"><i style="width:${(count / max) * 100}%"></i></span>
      <b class="rankbar-count" data-count="${count}" data-key="rank:${esc(label)}">${fmt(count)}</b>
      <span class="rankbar-pct">${pct}%</span>
    </div>`;
    }).join('');
  animateCounts(host);
}

function toggleFocusStatus(status) {
  focusStatus = focusStatus === status ? null : status;
  renderDonut();
  renderBenchCards();
}

function renderBenchCards() {
  const snapshot = commandSnapshot();
  const roster = new Map(data.trainers.map(row => [row.email.toLowerCase(), row]));
  const bench = email => {
    const team = roster.get(String(email || '').toLowerCase())?.team;
    return team === 'Company' ? 'Company' : ['Computer A', 'Computer B'].includes(team) ? 'Computer' : 'Unassigned';
  };
  const benches = ['Computer', 'Company', 'Unassigned'].map(name => {
    const tasks = snapshot.current.filter(row => bench(row.trainer) === name);
    const accepted = tasks.filter(row => row.status === 'Accepted').length;
    const groups = new Set(snapshot.folders.filter(row => bench(row.trainer?.email) === name).map(row => row.name)).size;
    const mix = Object.entries(groupBy(tasks, row => row.status)).map(([status, rows]) => [status, rows.length]).sort((a, b) => b[1] - a[1]);
    return {name, tasks: tasks.length, accepted, groups, mix, rate: tasks.length ? (accepted / tasks.length) * 100 : 0};
  });
  // Ranked by pipeline accepted; the order on the page stays fixed so a bench
  // is always found in the same place.
  const order = [...benches].sort((a, b) => b.accepted - a.accepted || b.tasks - a.tasks);
  const rank = new Map(order.map((b, index) => [b.name, index + 1]));
  const host = byId('benchCards');
  host.classList.toggle('has-focus', Boolean(focusStatus));
  host.innerHTML = benches.map((b, index) => {
    const focused = focusStatus ? (b.mix.find(([status]) => status === focusStatus)?.[1] || 0) : null;
    const focusPct = focusStatus && b.tasks ? Math.round(((focused || 0) / b.tasks) * 100) : null;
    return `<div class="bench-card bench-rank-${rank.get(b.name)}" style="--i:${index}">
      <div class="bench-head">
        <h3>${b.name} bench</h3>
        <span class="medal medal-${rank.get(b.name)}" data-tip="Rank ${rank.get(b.name)} of ${benches.length} by pipeline accepted">${rank.get(b.name)}</span>
      </div>
      <div class="bench-ring" data-tip="${fmt(b.accepted)} accepted of ${fmt(b.tasks)} current tasks">
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="15.9155"/><circle class="ring-fg" cx="18" cy="18" r="15.9155" style="--pct:${b.rate.toFixed(1)}"/></svg>
        <div><b data-count="${gcsPipeline ? Math.round(b.rate) : ''}" data-kind="pct" data-key="ring:${b.name}">${gcsPipeline ? `${Math.round(b.rate)}%` : '-'}</b><span>accepted</span></div>
      </div>
      ${[
        ['Current tasks', gcsPipeline ? b.tasks : null],
        ['Pipeline accepted', gcsPipeline ? b.accepted : null],
        ['Unique accepted tasks', snapshot.ready ? b.groups : null],
      ].map(([label, value]) => `<div class="bench-metric"><span>${label}</span><b data-count="${value == null ? '' : value}" data-key="bench:${b.name}:${label}">${value == null ? '-' : fmt(value)}</b></div>`).join('')}
      ${focusStatus ? `<div class="bench-metric is-focus" style="--c:${statusColor(focusStatus)}"><span>${esc(focusStatus)} here</span><b data-count="${focused}" data-key="bench:${b.name}:focus">${fmt(focused)}</b><em>${focusPct}%</em></div>` : ''}
      <div class="bench-mix" aria-label="Status mix">
        ${b.mix.map(([status, count]) => `<i class="mix-seg${focusStatus === status ? ' is-focus' : ''}" role="button" tabindex="0" data-status="${esc(status)}" style="flex:${count};--c:${statusColor(status)}" data-tip="${esc(status)}: ${fmt(count)} (${Math.round((count / (b.tasks || 1)) * 100)}%)"></i>`).join('')}
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-count=""]').forEach(node => node.removeAttribute('data-count'));
  animateCounts(host);
}

function uniqueTeams() {
  return [...new Set(data.trainers.map((trainer) => trainer.team || "Unassigned"))].sort();
}


function filteredTrainers() {
  const search = byId("personSearch").value.trim().toLowerCase();
  const payment = byId('paymentFilter').value;
  const bench = byId('benchFilter').value;
  return payoutRows()
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
  syncPresetPills();
  renderEverything();
}


// Shared date range presets.
const RANGE_PRESETS = {'7': 7, '14': 14, '30': 30};
function setRangeFromPreset(value) {
  if (!value) { dateRange.start = dateRange.end = ''; return; }
  if (value === 'live') { dateRange.start = (truth && truth.cut) || ''; dateRange.end = ''; return; }
  const end = new Date();
  const start = new Date(end.getTime() - (RANGE_PRESETS[value] - 1) * 86400000);
  dateRange.start = start.toISOString().slice(0, 10);
  dateRange.end = end.toISOString().slice(0, 10);
}

function syncPresetPills() {
  document.querySelectorAll('.segmented .segbtn[data-preset]').forEach(pill =>
    pill.classList.toggle('is-on', pill.dataset.preset === (dateRange.preset || '')));
  const chip = byId('dateChip');
  if (chip) chip.textContent = (dateRange.start || dateRange.end) && !dateRange.preset ? rangeLabel() : 'Custom';
  const pop = document.querySelector('.rangepop');
  if (pop) pop.classList.toggle('is-set', Boolean((dateRange.start || dateRange.end) && !dateRange.preset));
}

function syncOverviewSlicer() {
  byId('dateStart').value = dateRange.start;
  byId('dateEnd').value = dateRange.end;
  byId('datePreset').value = dateRange.preset || '';
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

let payoutSort = {key: 'pendingAmount', dir: -1};

function renderPayoutSummary(rows) {
  const paid = sum(rows, 'paidAmount');
  const pending = sum(rows, 'pendingAmount');
  const earned = paid + pending;
  const people = rows.filter(row => row.acceptedTasks || row.paidTasks).length;
  const requests = payoutLedger?.totals?.paymentRequests;
  const requestDays = [...new Set((payoutLedger?.requests || []).map(r => r.requestedOn).filter(Boolean))].sort();
  const cards = [
    ['Accepted tasks', sum(rows, 'acceptedTasks'), 'int', `${fmt(people)} ${people === 1 ? 'person' : 'people'} with accepted work`, 'aqua', null, null],
    ['Paid tasks', sum(rows, 'paidTasks'), 'int', 'at $300 a task', 'blue', 'paymentFilter', 'paid', sum(rows, 'acceptedTasks') ? Math.round((sum(rows, 'paidTasks') / sum(rows, 'acceptedTasks')) * 100) : 0],
    ['Paid', paid, 'money', `${earned ? Math.round((paid / earned) * 100) : 0}% of ${money(earned)} earned`, 'aqua', null, null, earned ? Math.round((paid / earned) * 100) : 0],
    ['Owed', pending, 'money', `${fmt(sum(rows, 'pendingTasks'))} tasks not yet requested`, 'red', 'paymentFilter', 'pending', earned ? Math.round((pending / earned) * 100) : 0],
    ['Payment requests', requests ?? 0, 'int', requestDays.length ? (requestDays.length === 1 ? `all raised on ${requestDays[0]}` : `${requestDays[0]} to ${requestDays[requestDays.length - 1]}`) : 'from the PPT tracker', 'violet', null, null],
  ];
  byId('payoutSummary').innerHTML = cards.map(([label, value, kind, note, tone, filter, filterValue, pct], index) => {
    const pressed = filter ? byId(filter)?.value === filterValue : false;
    const tag = filter ? 'button' : 'article';
    return `<${tag} class="kpi${filter ? ' kpi-button' : ''}" data-tone="${tone}" style="--i:${index}"${filter ? ` data-pfilter="${filter}" data-value="${filterValue}" aria-pressed="${pressed}"` : ''}>
      <div class="kpi-top"><h3>${label}</h3></div>
      <strong data-count="${value}" data-kind="${kind}" data-key="pay:${label}">${kind === 'money' ? money(value) : fmt(value)}</strong>
      <p class="kpi-note">${note}</p>
      ${filter ? `<span class="kpi-cue">${pressed ? 'filtering · click to clear' : 'click to filter'}</span>` : ''}
    </${tag}>`;
  }).join('');
  animateCounts(byId('payoutSummary'));
}

function renderPayoutPanels(rows) {
  const search = byId('personSearch').value.trim().toLowerCase();
  // Settlement by bench: how much of what each bench earned has been paid.
  const benches = [['Company', 'company'], ['Computer', 'computer'], ['Unassigned', 'unassigned']].map(([label, key]) => {
    const members = rows.filter(row => benchOf(row.team) === key);
    const paid = sum(members, 'paidAmount'), owed = sum(members, 'pendingAmount');
    return {label, key, paid, owed, people: members.filter(r => r.paidAmount || r.pendingAmount).length,
            paidTasks: sum(members, 'paidTasks'), owedTasks: sum(members, 'pendingTasks'),
            settled: paid + owed ? Math.round((paid / (paid + owed)) * 100) : 0};
  }).filter(b => b.paid || b.owed);
  byId('payoutBenches').innerHTML = benches.length ? benches.map((b, index) => `
    <button type="button" class="benchring${byId('benchFilter').value === b.key ? ' is-on' : ''}" style="--i:${index}" data-pfilter="benchFilter" data-value="${b.key}" data-tip="${esc(b.label)} bench: ${money(b.paid)} paid of ${money(b.paid + b.owed)} earned · click to filter">
      <div class="ring-big" style="--c:var(--aqua)">
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="15.9155"/><circle class="ring-fg" cx="18" cy="18" r="15.9155" style="--pct:${b.settled}"/></svg>
        <b data-count="${b.settled}" data-kind="pct" data-key="bench:${b.key}:settled">${b.settled}%</b>
      </div>
      <div class="benchring-body">
        <h3>${esc(b.label)} bench</h3>
        <p>${fmt(b.people)} ${b.people === 1 ? 'person' : 'people'} · ${money(b.paid + b.owed)} earned</p>
        <div class="benchring-lines">
          <div><span>Paid</span><b data-count="${b.paid}" data-kind="money" data-key="bench:${b.key}:paid">${money(b.paid)}</b><small>${fmt(b.paidTasks)} tasks</small></div>
          <div><span>Owed</span><b class="is-owed" data-count="${b.owed}" data-kind="money" data-key="bench:${b.key}:owed">${money(b.owed)}</b><small>${fmt(b.owedTasks)} tasks</small></div>
        </div>
        <div class="benchring-bar" aria-hidden="true">${b.paid ? `<i class="is-paid" style="flex:${b.paid}"></i>` : ''}${b.owed ? `<i class="is-owed" style="flex:${b.owed}"></i>` : ''}</div>
      </div>
    </button>`).join('') : '<p class="empty">No payouts in this selection.</p>';

  // One level finer: the same money per team, paid against owed on one scale.
  const teams = Object.entries(groupBy(rows.filter(row => row.paidAmount || row.pendingAmount), row => row.team || 'Unassigned'))
    .map(([team, list]) => ({team, paid: sum(list, 'paidAmount'), owed: sum(list, 'pendingAmount'), people: list.length}))
    .sort((a, b) => (b.paid + b.owed) - (a.paid + a.owed));
  const teamMax = Math.max(1, ...teams.map(t => t.paid + t.owed));
  byId('payoutTeams').innerHTML = teams.length ? `
    <p class="subhead">By team<em>paid against owed, one scale · click a team to filter</em></p>
    <div class="team-rows">${teams.map((t, index) => `<button type="button" class="team-row${search === t.team.toLowerCase() ? ' is-on' : ''}" style="--i:${index}" data-search="${esc(t.team)}" data-tip="${esc(t.team)}: ${money(t.paid)} paid, ${money(t.owed)} owed across ${fmt(t.people)} people">
      <span class="team-name">${esc(t.team)}<small>${fmt(t.people)} people</small></span>
      <span class="team-bar"><span class="team-bar-track" style="width:${Math.max(4, Math.round(((t.paid + t.owed) / teamMax) * 100))}%">${t.paid ? `<i class="is-paid" style="flex:${t.paid}">${t.paid / (t.paid + t.owed) > .18 ? money(t.paid) : ''}</i>` : ''}${t.owed ? `<i class="is-owed" style="flex:${t.owed}">${t.owed / (t.paid + t.owed) > .18 ? money(t.owed) : ''}</i>` : ''}</span></span>
      <span class="team-total"><b>${money(t.paid + t.owed)}</b><small>${Math.round((t.paid / ((t.paid + t.owed) || 1)) * 100)}% settled</small></span>
    </button>`).join('')}</div>
    <div class="chart-key"><span class="key-item"><i style="background:var(--aqua-ink)"></i>paid</span><span class="key-item"><i style="background:var(--red-ink)"></i>owed</span></div>` : '';
  const paid = sum(rows, 'paidAmount'), owed = sum(rows, 'pendingAmount');
  setText('payoutBenchNote', paid + owed ? `${Math.round((paid / (paid + owed)) * 100)}% of ${money(paid + owed)} earned has been paid · ${money(owed)} still owed` : '');
  animateCounts(byId('payoutBenches'));
}

function renderTrainerRows() {
  const rows = filteredTrainers();
  renderPayoutSummary(rows);
  renderPayoutPanels(rows);
  renderPayoutLedger();
  const labels = {personSearch: 'Search', benchFilter: 'Bench', paymentFilter: 'Payment'};
  const shown = {pending: 'Owed', paid: 'Paid', 'no-paid': 'Never paid', zero: 'No accepted work', company: 'Company', computer: 'Computer', unassigned: 'Unassigned'};
  const active = Object.keys(labels).map(id => [id, byId(id)?.value]).filter(([, value]) => value);
  byId('payoutChips').innerHTML = active.length
    ? active.map(([id, value]) => `<button type="button" class="chipbtn" data-pclear="${id}"><span>${labels[id]}</span>${esc(shown[value] || value)}<i aria-hidden="true">×</i></button>`).join('') +
      '<button type="button" class="chipbtn is-clear" data-pclear="all">Clear all</button>'
    : '<span class="chips-empty">No filters applied · click a figure, manager or bench above to filter</span>';
  setText('payoutPeopleNote', `${fmt(rows.length)} people · ${money(sum(rows, 'paidAmount'))} paid · ${money(sum(rows, 'pendingAmount'))} owed · ${fmt(sum(rows, 'last24Accepted'))} accepted in the last 24h`);

  const sorted = [...rows].sort((a, b) => {
    const key = payoutSort.key;
    const va = typeof a[key] === 'number' ? a[key] : String(a[key] || ''), vb = typeof b[key] === 'number' ? b[key] : String(b[key] || '');
    return (va < vb ? -1 : va > vb ? 1 : 0) * payoutSort.dir || b.pendingAmount - a.pendingAmount || String(a.name).localeCompare(String(b.name));
  });
  document.querySelectorAll('#payoutTable .sort').forEach(button => {
    const on = button.dataset.sort === payoutSort.key;
    button.classList.toggle('is-on', on);
    button.dataset.dir = on ? (payoutSort.dir > 0 ? 'asc' : 'desc') : '';
  });
  const size = pageSize('payoutPageSize');
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  payoutPage = Math.min(Math.max(payoutPage, 0), pages - 1);
  const from = payoutPage * size;
  const page = sorted.slice(from, from + size);
  setText('payoutPage', sorted.length ? `${fmt(from + 1)}–${fmt(from + page.length)} of ${fmt(sorted.length)}` : 'No matches');
  byId('payoutPrevious').disabled = payoutPage === 0;
  byId('payoutNext').disabled = payoutPage >= pages - 1;
  const moneyMax = Math.max(1, ...sorted.map(row => row.paidAmount + row.pendingAmount));
  const requestsByEmail = groupBy(payoutLedger?.requests || [], r => String(r.email || '').toLowerCase());
  byId('trainerRows').innerHTML = page.map((row, index) => {
    const id = `pay-drill-${from + index}`;
    const email = String(row.email || '').toLowerCase();
    const tasks = payoutLedgerTasks.filter(task => String(task.email || '').toLowerCase() === email);
    const requests = requestsByEmail[email] || [];
    const total = row.paidAmount + row.pendingAmount;
    return `
        <tr class="drill-head" style="--i:${index}">
          <td><button class="drill-toggle" aria-expanded="false" aria-controls="${id}" aria-label="Ledger for ${esc(row.name || row.email)}">+</button></td>
          <td class="num serial">${fmt(from + index + 1)}</td>
          <td><span class="who"><i class="avatar">${esc(initials(row.email))}</i><span class="who-text"><strong>${esc(row.name || 'Unknown')}</strong><small>${esc(row.email)}</small></span></span></td>
          <td><span class="batch-chip">${esc(row.team || 'Unassigned')}</span></td>
          <td>${esc(row.managerName || row.em || '-')}</td>
          <td class="num"><b>${fmt(row.acceptedTasks)}</b></td>
          <td><span class="moneybar" data-tip="${money(row.paidAmount)} paid for ${fmt(row.paidTasks)} tasks · ${money(row.pendingAmount)} owed for ${fmt(row.pendingTasks)} tasks"><span class="moneybar-track" style="width:${Math.max(4, Math.round((total / moneyMax) * 100))}%">${row.paidAmount ? `<i class="is-paid" style="flex:${row.paidAmount}"></i>` : ''}${row.pendingAmount ? `<i class="is-owed" style="flex:${row.pendingAmount}"></i>` : ''}</span><small>${money(row.paidAmount)} paid</small></span></td>
          <td class="num ${row.pendingAmount ? 'negative' : ''}">${money(row.pendingAmount)}</td>
          <td class="num">${row.last24Accepted ? `<span class="pulse-badge" data-tip="${fmt(row.last24Accepted)} accepted in the last 24 hours">${fmt(row.last24Accepted)}</span>` : '<span class="muted">0</span>'}</td>
        </tr>
        <tr class="drill" id="${id}" hidden><td colspan="9">
          <div class="drill-cols">
            <div>
              <p class="subhead">Ledger tasks<em>${fmt(tasks.length)}</em></p>
              ${tasks.length ? `<ul class="minitasks">${tasks.map(task => `<li><span class="taskname" title="${esc(task.task)}">${esc(task.task)}</span><span class="diff" style="--c:${task.filterType === 'Connector' ? 'var(--aqua-ink)' : 'var(--blue-ink)'}">${esc(task.filterType)}</span><span class="pill" style="--tone:var(--${PAYMENT_TONES[task.paymentState] || 'slate'});--tone-soft:var(--${PAYMENT_TONES[task.paymentState] || 'slate'}-soft);--tone-ink:var(--${PAYMENT_TONES[task.paymentState] || 'slate'}-ink)" data-tone="x">${esc(task.paymentState)}</span>${task.valid ? '' : '<span class="pill is-warn">Valid = 0</span>'}</li>`).join('')}</ul>` : '<p class="muted">No ledger tasks for this person.</p>'}
            </div>
            <div>
              <p class="subhead">Payment requests<em>${fmt(requests.length)}</em></p>
              ${requests.length ? `<ul class="minitasks">${requests.map(r => `<li><span class="batch-chip">${esc(r.requestedOn || '-')}</span><span>${fmt(r.paidTasks)} tasks</span><b>${money(r.paidAmount)}</b>${r.cj ? `<small class="muted">CJ ${esc(r.cj)}</small>` : ''}${String(r.emailMismatch) === 'true' || r.emailMismatch === true ? '<span class="pill is-warn">email mismatch</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">No payment request raised yet.</p>'}
              <dl class="drill-grid compact">
                <dt>Status</dt><dd>${esc(row.status || '-')}</dd>
                <dt>Bench</dt><dd>${esc(benchOf(row.team))}</dd>
                <dt>Manager</dt><dd>${esc(row.managerName || '-')}${row.em ? ` · EM ${esc(row.em)}` : ''}</dd>
              </dl>
            </div>
          </div>
        </td></tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">No matches.</td></tr>';
}

function wirePayouts() {
  const panel = byId('view-payouts');
  if (!panel) return;
  const rerender = () => { payoutPage = 0; ledgerPage = 0; renderTrainerRows(); };
  panel.addEventListener('click', event => {
    if (event.target.closest('a')) return;
    const pf = event.target.closest('[data-pfilter][data-value]');
    if (pf) { const select = byId(pf.dataset.pfilter); if (select) { select.value = select.value === pf.dataset.value ? '' : pf.dataset.value; rerender(); } return; }
    const lf = event.target.closest('[data-lfilter][data-value]');
    if (lf) { const select = byId(lf.dataset.lfilter); if (select) { select.value = select.value === lf.dataset.value ? '' : lf.dataset.value; ledgerPage = 0; renderPayoutLedger(); } return; }
    const mgr = event.target.closest('[data-search]');
    if (mgr) { const search = byId('personSearch'); search.value = search.value.trim().toLowerCase() === mgr.dataset.search.toLowerCase() ? '' : mgr.dataset.search; rerender(); return; }
    const pc = event.target.closest('#payoutChips [data-pclear]');
    if (pc) { if (pc.dataset.pclear === 'all') { byId('payoutReset').click(); return; } byId(pc.dataset.pclear).value = ''; rerender(); return; }
    const lc = event.target.closest('#ledgerChips [data-lclear]');
    if (lc) { if (lc.dataset.lclear === 'all') { byId('resetLedgerFilters').click(); return; } byId(lc.dataset.lclear).value = ''; if (lc.dataset.lclear === 'benchFilter') { rerender(); } else { ledgerPage = 0; renderPayoutLedger(); } return; }
    const head = event.target.closest('#trainerRows .drill-head');
    if (head) {
      const drill = head.nextElementSibling;
      const open = head.classList.toggle('is-open');
      if (drill) drill.hidden = !open;
      const toggle = head.querySelector('.drill-toggle');
      if (toggle) { toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? '−' : '+'; }
    }
  });
  panel.querySelectorAll('#payoutTable .sort').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    const numeric = ['acceptedTasks', 'paidAmount', 'pendingAmount', 'last24Accepted'].includes(key);
    payoutSort = payoutSort.key === key ? {key, dir: -payoutSort.dir} : {key, dir: numeric ? -1 : 1};
    renderTrainerRows();
  }));
  panel.querySelectorAll('#ledgerTable .sort').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    ledgerSort = ledgerSort.key === key ? {key, dir: -ledgerSort.dir} : {key, dir: key === 'duplicateRows' ? -1 : 1};
    renderPayoutLedger();
  }));
  byId('payoutReset')?.addEventListener('click', () => {
    ['personSearch', 'benchFilter', 'paymentFilter'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    rerender();
  });
}

function renderTeams() {
  if (!byId('teamGrid')) return;
  const teams = Object.entries(groupBy(data.trainers, (trainer) => trainer.team || 'Unassigned'))
    .map(([team, rows]) => {
      const accepted = sum(rows, 'acceptedTasks');
      const paid = sum(rows, 'paidAmount');
      const owed = sum(rows, 'pendingAmount');
      const active = rows.filter(row => String(row.status).toLowerCase() === 'active').length;
      return {team, rows, accepted, paid, owed, active,
              managers: new Set(rows.map(row => row.managerName).filter(Boolean)).size,
              settled: paid + owed ? Math.round((paid / (paid + owed)) * 100) : 0};
    })
    .sort((a, b) => b.accepted - a.accepted || b.paid - a.paid);
  const top = Math.max(1, ...teams.map(t => t.accepted));
  byId('teamGrid').innerHTML = teams.map((t, index) => `
        <article class="team-card${index === 0 ? ' is-champion' : ''}" role="button" tabindex="0" data-team="${esc(t.team)}" style="--i:${index}" data-tip="Open ${esc(t.team)} in Payouts">
          <div class="team-head">
            <h3>${esc(t.team)}</h3>
            <span class="medal medal-${Math.min(index + 1, 4)}">${index + 1}</span>
          </div>
          <strong class="hero-number" data-count="${t.accepted}" data-key="team:${esc(t.team)}:accepted">${fmt(t.accepted)}</strong>
          <span class="team-sub">accepted tasks</span>
          <div class="team-race" aria-hidden="true"><i style="--pct:${Math.round((t.accepted / top) * 100)}"></i></div>
          <div class="team-line"><span>Trainers</span><b data-count="${t.rows.length}" data-key="team:${esc(t.team)}:trainers">${fmt(t.rows.length)}</b></div>
          <div class="team-line"><span>Active</span><b data-count="${t.active}" data-key="team:${esc(t.team)}:active">${fmt(t.active)}</b></div>
          <div class="team-line"><span>Managers</span><b data-count="${t.managers}" data-key="team:${esc(t.team)}:managers">${fmt(t.managers)}</b></div>
          <div class="team-line"><span>Paid</span><b data-count="${t.paid}" data-kind="money" data-key="team:${esc(t.team)}:paid">${money(t.paid)}</b></div>
          <div class="team-line"><span>Owed</span><b class="${t.owed ? 'is-owed' : ''}" data-count="${t.owed}" data-kind="money" data-key="team:${esc(t.team)}:owed">${money(t.owed)}</b></div>
          <div class="team-settle" data-tip="${money(t.paid)} paid of ${money(t.paid + t.owed)} earned">
            <span>Settled</span><i><em style="--pct:${t.settled}"></em></i><b data-count="${t.settled}" data-kind="pct" data-key="team:${esc(t.team)}:settled">${t.settled}%</b>
          </div>
        </article>`).join('');
  animateCounts(byId('teamGrid'));
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
  // PRD X1: the shared range reaches this view too, on the object's
  // last-modified date. Folders are not filtered - a folder has no date of its
  // own, and hiding the path to a file would read as data loss.
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
// Plan against actual, as one race per bench: a lane to the target, the
// daily bars beneath it, today marked and future days hatched.
function planWindow() {
  const benches = data.plan || [];
  const dates = benches[0]?.dates || [];
  const within = dates.map(day => inRange(day));
  const shown = dates.filter((day, index) => within[index]);
  const totals = benches.map(bench => {
    const planned = bench.plan.reduce((total, value, index) => total + (within[index] ? Number(value) || 0 : 0), 0);
    const done = bench.actual.reduce((total, value, index) => total + (within[index] ? Number(value) || 0 : 0), 0);
    return {bench: bench.bench, planned, done, share: planned ? done / planned : null};
  });
  return {benches, dates, within, shown, totals, today: new Date().toISOString().slice(0, 10)};
}

function renderPlan() {
  if (!byId('planCharts')) return;
  const {benches, dates, within, shown, totals, today} = planWindow();
  const summary = byId('planSummary');
  if (!benches.length || !shown.length) {
    byId('planCharts').innerHTML = `<p class="empty">No daily plan ${dates.length ? 'in this date range' : 'recorded'}.</p>`;
    if (summary) summary.innerHTML = '';
    return;
  }
  const max = Math.max(1, ...benches.flatMap(bench => bench.dates.map((day, index) =>
    within[index] ? Math.max(Number(bench.plan[index]) || 0, Number(bench.actual[index]) || 0) : 0)));

  if (summary) {
    const planned = totals.reduce((total, row) => total + row.planned, 0);
    const done = totals.reduce((total, row) => total + row.done, 0);
    const card = (label, value, kind, note, tone, key, index) => `<article class="kpi" data-tone="${tone}" style="--i:${index}">
      <div class="kpi-top"><h3>${label}</h3></div><strong data-count="${value}" data-kind="${kind}" data-key="plan:${key}">${kind === 'pct' ? `${value}%` : fmt(value)}</strong><p class="kpi-note">${note}</p></article>`;
    summary.innerHTML =
      card('Planned', planned, 'int', `${fmt(shown.length)} days`, 'violet', 'planned', 0) +
      card('Delivered', done, 'int', planned ? `${Math.round((done / planned) * 100)}% of plan` : 'no plan set', done >= planned ? 'aqua' : 'yellow', 'done', 1) +
      totals.map((row, index) => card(row.bench.replace(/\s*bench$/i, ''), row.done, 'int',
        row.planned ? `of ${fmt(row.planned)} planned` : 'no plan set', 'blue', row.bench, index + 2)).join('');
    animateCounts(summary);
  }

  byId('planCharts').innerHTML = benches.map((bench, benchIndex) => {
    const total = totals.find(row => row.bench === bench.bench);
    const pct = total.planned ? Math.min(100, Math.round((total.done / total.planned) * 100)) : 0;
    const bars = bench.dates.map((day, index) => {
      if (!within[index]) return '';
      const plan = Number(bench.plan[index]) || 0;
      const actual = Number(bench.actual[index]) || 0;
      const state = day === today ? ' is-today' : day > today ? ' is-future' : '';
      const hit = plan && actual >= plan ? ' is-hit' : '';
      const tip = plan
        ? `${bench.bench} ${day}: ${fmt(actual)} of ${fmt(plan)} planned${actual >= plan ? ' · target met' : ''}`
        : `${bench.bench} ${day}: no plan set`;
      return `<div class="plan-day${state}${hit}" style="--i:${index}" data-tip="${esc(tip)}">
        <div class="plan-bars">
          ${plan ? `<i class="plan-planned" style="height:${(plan / max) * 100}%"></i>` : ''}
          ${actual ? `<i class="plan-actual" style="height:${(actual / max) * 100}%"></i>` : ''}
          ${actual ? `<b class="plan-val">${fmt(actual)}</b>` : ''}
        </div>
        <span class="plan-x">${esc(day.slice(5))}</span>
      </div>`;
    }).join('');
    return `<div class="plan-bench" style="--i:${benchIndex}">
      <div class="plan-head">
        <h3>${esc(bench.bench)}</h3>
        <span><b data-count="${total.done}" data-key="lane:${esc(bench.bench)}:done">${fmt(total.done)}</b> of ${fmt(total.planned)}${total.share == null ? '' : ` · <b data-count="${Math.round(total.share * 100)}" data-kind="pct" data-key="lane:${esc(bench.bench)}:pct">${Math.round(total.share * 100)}%</b>`}</span>
      </div>
      <div class="lane" data-tip="${esc(bench.bench)}: ${fmt(total.done)} delivered of ${fmt(total.planned)} planned">
        <div class="lane-track"><i class="lane-fill" style="--pct:${pct}"></i><span class="lane-runner" style="--pct:${pct}"></span></div>
        <span class="lane-flag" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 3v18M5 4h11l-2 4 2 4H5"/></svg></span>
      </div>
      <div class="plan-axis"><span>${fmt(max)}</span><span>${fmt(Math.round(max / 2))}</span><span>0</span></div>
      <div class="plan-track">${bars}</div>
    </div>`;
  }).join('');
  animateCounts(byId('planCharts'));
}

function wireDelivery() {
  const panel = byId('view-delivery');
  if (!panel) return;
  // Anything carrying a filter and a value sets that filter; the same value
  // again clears it.
  const setFilter = (id, value) => {
    const select = byId(id);
    if (!select || ![...select.options].some(option => option.value === value)) return;
    select.value = select.value === value ? '' : value;
    auditPage = 0;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  };
  const pick = event => {
    const node = event.target.closest('[data-filter][data-value]');
    if (!node || event.target.closest('a')) return;
    event.preventDefault();
    setFilter(node.dataset.filter, node.dataset.value);
  };
  panel.addEventListener('click', pick);
  panel.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-filter][data-value]')) pick(event); });

  byId('auditLens')?.addEventListener('click', event => {
    const button = event.target.closest('[data-lens]');
    if (!button) return;
    auditLens = button.dataset.lens;
    renderAudit();
  });
  const list = byId('auditList'), waffle = byId('auditWaffle');
  if (list && waffle) {
    list.addEventListener('mouseover', event => {
      const row = event.target.closest('.dim-row[data-v]');
      if (!row) return;
      waffle.classList.add('is-dim');
      waffle.querySelectorAll('.sq').forEach(sq => sq.classList.toggle('is-lit', sq.dataset.v === row.dataset.v));
    });
    list.addEventListener('mouseleave', () => { waffle.classList.remove('is-dim'); waffle.querySelectorAll('.sq.is-lit').forEach(sq => sq.classList.remove('is-lit')); });
  }
  byId('auditWaffle')?.addEventListener('click', event => {
    const square = event.target.closest('[data-task]');
    if (!square) return;
    const search = byId('aSearch');
    search.value = search.value === square.dataset.task ? '' : square.dataset.task;
    auditPage = 0;
    search.dispatchEvent(new Event('input', {bubbles: true}));
  });
  byId('auditChips')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-clear]');
    if (!chip) return;
    if (chip.dataset.clear === 'aReset-all') { byId('aReset')?.click(); return; }
    const node = byId(chip.dataset.clear);
    if (!node) return;
    node.value = '';
    auditPage = 0;
    node.dispatchEvent(new Event(node.tagName === 'INPUT' ? 'input' : 'change', {bubbles: true}));
  });
  panel.querySelectorAll('.inv .sort').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    auditSort = auditSort.key === key ? {key, dir: -auditSort.dir} : {key, dir: 1};
    renderAudit();
  }));
  byId('auditPageSize')?.addEventListener('change', () => { auditPage = 0; renderAudit(); });
  byId('auditRows')?.addEventListener('click', event => {
    const head = event.target.closest('.drill-head');
    if (!head || event.target.closest('a')) return;
    const drill = head.nextElementSibling;
    const open = head.classList.toggle('is-open');
    if (drill) drill.hidden = !open;
    head.querySelector('.drill-toggle')?.setAttribute('aria-expanded', String(open));
    const toggle = head.querySelector('.drill-toggle'); if (toggle) toggle.textContent = open ? '−' : '+';
  });

  // A team card opens that team in Payouts.
  const openTeam = card => {
    switchView('payouts');
    const search = byId('personSearch');
    if (search) { search.value = card.dataset.team === 'Unassigned' ? '' : card.dataset.team; search.dispatchEvent(new Event('input', {bubbles: true})); }
  };
  panel.addEventListener('click', event => { const card = event.target.closest('.team-card[data-team]'); if (card) openTeam(card); });
  panel.addEventListener('keydown', event => {
    const card = event.target.closest && event.target.closest('.team-card[data-team]');
    if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openTeam(card); }
  });
}

function wireEvents() {
  byId('deltaState').addEventListener('change', renderDailyDelta);
  document.addEventListener('click', event => {
    const pill = event.target.closest('.segmented .segbtn[data-preset]');
    if (!pill) return;
    const select = byId('datePreset');
    select.value = pill.dataset.preset;
    select.dispatchEvent(new Event('change'));
    const pop = document.querySelector('.rangepop'); if (pop) pop.open = false;
  });
  const toggleCard = card => {
    const open = card.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('[data-expand][aria-expanded="true"]').forEach(other => { if (other.className.split(' ')[0] === card.className.split(' ')[0]) other.setAttribute('aria-expanded', 'false'); });
    card.setAttribute('aria-expanded', String(!open));
  };
  document.addEventListener('click', event => {
    const card = event.target.closest('[data-expand]');
    if (!card || event.target.closest('a, button')) return;
    toggleCard(card);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest && event.target.closest('[data-expand]');
    if (!card || event.target !== card) return;
    event.preventDefault(); toggleCard(card);
  });
  byId('truthRefresh')?.addEventListener('click', rebuildTruth);
  wirePayoutBalance();
  wireStatusFocus();
  wireDelivery();
  wireCarried();
  wirePayouts();
  byId('unmatchedShow')?.addEventListener('click', () => {
    const panel = byId('unmatchedPanel');
    const opening = panel.hidden;
    panel.hidden = !opening;
    byId('unmatchedShow').setAttribute('aria-expanded', String(opening));
    if (opening) renderUnmatched();
    renderJoinGap(window.filterTruth(truth.rows, truthFilters()));
  });
  byId('manifestSize')?.addEventListener('input', () => renderTruth());
  byId('manifestBuild')?.addEventListener('click', downloadManifest);
  byId('manifestExclude')?.addEventListener('change', event => loadManifestExclusions(event.target.files[0]));
  byId('manifestClear')?.addEventListener('click', () => {
    manifestExclusions = []; manifestExcludedFrom = '';
    if (byId('manifestExclude')) byId('manifestExclude').value = '';
    renderTruth();
  });
  byId('manifestBar')?.addEventListener('click', event => {
    const chip = event.target.closest('.size-chip');
    if (!chip) return;
    const size = Number(chip.dataset.size);
    // "All" is stored as an empty box rather than a zero, so the number input
    // never shows a size nobody asked for.
    byId('manifestSize').value = size > 0 ? String(size) : '';
    renderTruth();
  });
  AUDIT_FILTERS.forEach(id => byId(id)?.addEventListener('change', () => { auditPage = 0; renderAudit(); }));
  byId('aSearch')?.addEventListener('input', () => { auditPage = 0; renderAudit(); });
  byId('aReset')?.addEventListener('click', () => {
    [...AUDIT_FILTERS, 'aSearch'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    auditPage = 0; renderAudit();
  });
  byId('auditPrev')?.addEventListener('click', () => { auditPage -= 1; renderAudit(); });
  byId('auditNext')?.addEventListener('click', () => { auditPage += 1; renderAudit(); });
  TRUTH_FILTERS.forEach(id => byId(id)?.addEventListener('change', () => { truthPage = 0; renderTruth(); }));
  byId('tSearch')?.addEventListener('input', () => { truthPage = 0; renderTruth(); });
  byId('tReset')?.addEventListener('click', () => {
    [...TRUTH_FILTERS, 'tSearch'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    truthPage = 0; renderTruth();
  });
  byId('truthPageSize')?.addEventListener('change', () => { truthPage = 0; renderTruth(); });
  byId('truthPrev')?.addEventListener('click', () => { truthPage -= 1; renderTruth(); });
  byId('truthNext')?.addEventListener('click', () => { truthPage += 1; renderTruth(); });
  byId('truthChainClose')?.addEventListener('click', () => {
    openChain = null; byId('truthChainPanel').hidden = true;
    document.querySelectorAll('[data-chain]').forEach(node => node.setAttribute('aria-pressed', 'false'));
  });
  byId('scopeKey')?.addEventListener('click', event => {
    const key = event.target.closest('[data-state]');
    if (!key) return;
    byId('tState').value = byId('tState').value === key.dataset.state ? '' : key.dataset.state;
    truthPage = 0; renderTruth();
  });
  document.addEventListener('click', event => {
    const card = event.target.closest('#truthFigures [data-chain], #truthFlags [data-chain], #truthPartition [data-chain]');
    if (!card) return;
    const label = card.dataset.chain;
    if (openChain === label) {
      openChain = null; byId('truthChainPanel').hidden = true;
      document.querySelectorAll('[data-chain]').forEach(node => node.setAttribute('aria-pressed', 'false'));
      return;
    }
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
  ['cState', 'cOwner'].forEach(id => byId(id)?.addEventListener('change', () => { carriedPage = 0; renderCarried(); }));
  byId('cSearch')?.addEventListener('input', () => { carriedPage = 0; renderCarried(); });
  byId('cReset')?.addEventListener('click', () => {
    ['cState', 'cOwner', 'cSearch', 'cGate', 'cDomain', 'cDuplicate'].forEach(id => { if (byId(id)) byId(id).value = ''; });
    carriedExtra = {day: '', runs: '', finding: '', why: ''};
    carriedPage = 0;
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
  // Delegated so jump buttons rendered later still work.
  document.addEventListener('click', event => {
    const jump = event.target.closest('[data-jump]');
    if (jump) switchView(jump.dataset.jump);
  });
  window.addEventListener('popstate', () => switchView(location.hash.slice(1) || 'command', false));
  const resetPayoutPages = () => { payoutPage = 0; ledgerPage = 0; renderTrainerRows(); };
  byId('personSearch').addEventListener('input', resetPayoutPages);
  byId('payoutPageSize').addEventListener('change', () => { payoutPage = 0; renderTrainerRows(); });
  byId('ledgerPageSize').addEventListener('change', () => { ledgerPage = 0; renderPayoutLedger(); });
  byId('payoutPrevious').addEventListener('click', () => { payoutPage -= 1; renderTrainerRows(); });
  byId('payoutNext').addEventListener('click', () => { payoutPage += 1; renderTrainerRows(); });
  byId('ledgerPrevious').addEventListener('click', () => { ledgerPage -= 1; renderPayoutLedger(); });
  byId('ledgerNext').addEventListener('click', () => { ledgerPage += 1; renderPayoutLedger(); });
  byId('paymentFilter').addEventListener('change', resetPayoutPages);
  byId('benchFilter').addEventListener('change', resetPayoutPages);
  const presets = {'7': 7, '14': 14, '30': 30};
  byId('datePreset').addEventListener('change', event => {
    dateRange.preset = event.target.value;
    setRangeFromPreset(event.target.value);
    syncOverviewSlicer();
    applyRange();
  });
  ['dateStart', 'dateEnd'].forEach(id => byId(id).addEventListener('change', () => {
    dateRange.start = byId('dateStart').value;
    dateRange.end = byId('dateEnd').value;
    dateRange.preset = '';
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
    // Entries may be functions when the text depends on loaded data.
    const entry = infoCopy[button.dataset.info];
    const copy = typeof entry === 'function' ? entry() : entry;
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
  loadDeliveryAudit();
}

init();
