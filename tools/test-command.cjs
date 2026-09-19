const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const elements = new Map();
const context = vm.createContext({
  // The page registers a resize listener and asks about reduced motion at
  // load; with reduced motion on, the animated counters write their final
  // value at once, which is what the assertions below read.
  window: {addEventListener() {}, matchMedia: () => ({matches: true})},
  Intl, console, setInterval() {}, performance,
  requestAnimationFrame: fn => fn(performance.now()),
  // The page reads its palette off the stylesheet at render time. There is no
  // stylesheet here, so this returns nothing and statusColor falls back to its
  // own default - which is what the fallback is for. The test is about counts,
  // not colours.
  getComputedStyle: () => ({getPropertyValue: () => ''}),
  document: {
    documentElement: {},
    hidden: false,
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {value: '', style: {setProperty() {}}, textContent: '', innerHTML: '', dataset: {},
          classList: {toggle() {}, add() {}, remove() {}, contains: () => false}, querySelectorAll: () => []});
      }
      return elements.get(id);
    },
  },
});
for (const name of ['assets/data.js', 'finalisation.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context);
}
vm.runInContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/init\(\);\s*$/, ''), context);
const run = code => vm.runInContext(code, context);
run(`
  data.trainers = [
    {email:'a@example.com',name:'A',team:'Company',status:'Active',acceptedTasks:999,pendingTasks:999,paidAmount:999},
    {email:'b@example.com',name:'B',team:'Computer A',status:'Active'}
  ];
  data.paidOut = [{email:'a@example.com',approvedTasks:1,paidAmount:300}];
  gcsPipeline = {generatedAt:'2026-09-15',current:[
    {id:'1',task:'shared',trainer:'a@example.com',status:'Accepted'},
    {id:'2',task:'new',trainer:'a@example.com',status:'Accepted'},
    {id:'3',task:'waiting',trainer:'b@example.com',status:'Running'}
  ],historical:[{status:'Done'}]};
  finalisationSource = {generated_at:'2026-09-15'};
  // As prepareFinalisation emits them: a task is keyed by 'name', and the same
  // task finalised into two cohorts is two folders with one name. That is what
  // the duplicate count is counting.
  finalisationRows = [
    {folder:'shared-v2',name:'shared',displayName:'shared',trainer:data.trainers[0],date:'2026-09-15'},
    {folder:'shared',name:'shared',displayName:'shared',trainer:data.trainers[0],date:'2026-09-14'},
    {folder:'unknown',name:'unknown',displayName:'unknown',trainer:null,date:'2026-09-15'}
  ];
  renderHero(); renderDonut(); renderBenchCards(); renderTopPendingCards();
`);
// Three folders, two distinct task names: the accepted figure counts tasks, so
// the repeat cohort is one duplicate rather than a second accepted task.
assert.equal(run('commandSnapshot().folders.length'), 3);
assert.equal(run('commandSnapshot().tasks.size'), 2);
assert.equal(run('commandSnapshot().duplicates'), 1);
assert.equal(run('commandSnapshot().unassigned'), 1);
// Two distinct tasks across three folders. This is the figure the redesign
// changed: it counts task names, so a task finalised twice is not two.
assert.equal(elements.get('metricAccepted').textContent, '2');
// 999 accepted in the trainer record minus 1 approved in Paid Out. The 999 is
// a sentinel: it appears nowhere in the bucket fixture, so a pending figure
// derived from it proves the payout side reads the workbook and not GCS.
assert.equal(elements.get('metricPendingTasks').textContent, '998');
assert.equal(elements.get('metricPaid').textContent, '$300');
// The status panel ranks the current population; the historical toggle went
// with the redesign, so the total and the leading row are what is checked.
assert.match(elements.get('pipelineDonut').innerHTML, /data-key="rank:total">3</);
assert.match(elements.get('pipelineDonut').innerHTML, /data-key="rank:Accepted">2</);
// The Overview's own team filter was removed in the 15 Sept redesign; the date
// range is what scopes this page now, so that is what is checked.
assert.equal(run('commandSnapshot().current.length'), 3);
run("dateRange.start='2026-09-15'; dateRange.end='2026-09-15'; renderHero();");
assert.equal(run('commandSnapshot().folders.length'), 2,
  'the date range must scope the finalisation folders');
run("dateRange.start=null; dateRange.end=null; renderHero();");
assert.equal(run('commandSnapshot().folders.length'), 3, 'and clearing it must restore them');
// With no bucket data the page must show a dash, not a number built from half
// its sources. The snapshot is ready only when both the finalisation rows and
// the pipeline are loaded, so emptying the rows is what stands for a missing
// source now.
run('finalisationSource=null; finalisationRows=[]; renderHero(); renderTopPendingCards();');
assert.equal(run('commandSnapshot().ready'), false);
assert.equal(elements.get('metricAccepted').textContent, '-');
assert.equal(elements.get('metricPendingTasks').textContent, '-');
assert.match(elements.get('topPendingCards').innerHTML, /Waiting for pipeline and finalisation data/);
console.log('Command checks passed: deduplication, date scope, payout source, history independence, missing source.');
