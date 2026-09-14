const data = window.OPS_REVIEW_DATA;
const filterKeys = {teamFilter: 'team', leaderFilter: 'em', managerFilter: 'managerName', trainerFilter: 'email'};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const infoCopy = {
  dates: 'Filters Pipeline records by the workbook Date column, including both start and end dates. Either date can be left blank for an open-ended range. Undated records are excluded when a date is selected. Status counts and rows use the same filters. Payout calculations are unaffected.',
  bench: 'Company bench includes the Company team. Computer bench includes Computer A and Computer B. Other or missing teams appear under Unassigned bench. This payout-only filter combines with team, leader, manager, trainer, search and payment state. Totals sum the matching person records without changing payment formulas.',
  accepted: 'Accepted tasks: sum of the Trainers tab v2 total accepted column for the selected people. This is separate from historical pipeline acceptance.',
  paid: 'Paid tasks use the larger of the Trainers paid-out count and the matching paid out tab approved count, joined by email. Displayed paid amount = paid tasks x $300. This is the draft payment model, not a bank-confirmed transaction total.',
  pending: 'Estimated pending tasks = max(v2 accepted tasks - paid tasks, 0), calculated separately for each person. Estimated pending amount = pending tasks x $300. Totals sum these person-level values; paid tasks can exceed current v2 accepted tasks.',
  active: 'Count of selected trainer records whose workbook status is Active. The smaller total includes every status.',
  pipeline: 'Records from dump and Sheet9 combined. Historical and current records may overlap; this is a record count, not unique tasks. Filters match trainer email to the Trainers tab. Unmatched records appear only in the unfiltered view.',
  daily: 'Accepted in the last 24 hours as recorded in the workbook snapshot, not a live rolling window.',
  workbook: 'Workbook-wide snapshot. These source summaries do not contain a reliable person-level allocation and do not change with the review filters.'
};

function scopedTrainers(exclude) {
  return data.trainers.filter(row => Object.entries(filterKeys).every(([id,key]) => id === exclude || !byId(id).value || (row[key] || 'Unassigned') === byId(id).value));
}
function scopedTasks() {
  const all = [...data.pipeline.current, ...data.pipeline.historical];
  if (!Object.keys(filterKeys).some(id => byId(id).value)) return all;
  const emails = new Set(scopedTrainers().map(row => row.email.toLowerCase()));
  return all.filter(task => emails.has(task.trainer.toLowerCase()));
}
function refreshScope() {
  populateScopeFilters();
  setText('filterCount', `${fmt(scopedTrainers().length)} of ${fmt(data.trainers.length)} trainers`);
  renderHero(); renderTopPendingCards(); renderDonut(); renderTrainerRows(); renderTeams(); renderPipeline();
}
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
    ...new Set([...data.pipeline.current, ...data.pipeline.historical].map((task) => task.status || "Unknown")),
  ].sort();
  byId("pipelineFilter").innerHTML =
    `<option value="">All statuses</option>` +
    statuses.map((status) => `<option value="${status}">${status}</option>`).join("");
}

function filteredTrainers() {
  const search = byId("personSearch").value.trim().toLowerCase();
  const payment = byId('paymentFilter').value;
  const bench = byId('benchFilter').value;
  return scopedTrainers()
    .filter(row => !bench || (row.team === 'Company' ? 'company' : ['Computer A', 'Computer B'].includes(row.team) ? 'computer' : 'unassigned') === bench)
    .filter(row => !payment || (payment === 'pending' ? row.pendingTasks > 0 : payment === 'paid' ? row.paidTasks > 0 : row.acceptedTasks === 0))
    .filter((trainer) => {
      if (!search) return true;
      return [trainer.name, trainer.email, trainer.team, trainer.managerName, trainer.em]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((a, b) => b.pendingAmount - a.pendingAmount || b.acceptedTasks - a.acceptedTasks);
}

function renderPayoutSummary(rows) {
  const paid = sum(rows, "paidAmount");
  const pending = sum(rows, "pendingAmount");
  byId("payoutSummary").innerHTML = [
    ["People shown", fmt(rows.length)],
    ["Accepted tasks", fmt(sum(rows, "acceptedTasks"))],
    ["Paid amount", money(paid)],
    ["Pending amount", money(pending)],
  ]
    .map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
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

function renderPipeline() {
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
  byId("pipelineRows").innerHTML = rows
    .map(
      (task) => `
        <tr>
          <td>${task.date || "-"}</td>
          <td>${task.task}</td>
          <td>${task.trainer || "-"}</td>
          <td>${task.taskType || "-"}</td>
          <td><span class="pill">${task.status || "Unknown"}</span></td>
        </tr>
      `,
    )
    .join("") || '<tr><td colspan="5" class="empty">No pipeline records match these filters.</td></tr>';
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
}

init();
