const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const elements = new Map();
const context = vm.createContext({
  window: {}, Intl, console, setInterval() {},
  document: {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {value: '', style: {}, textContent: '', innerHTML: ''});
    return elements.get(id);
  }}
});
for (const name of ['assets/data.js', 'accepted-tasks.js', 'finalisation.js']) {
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
  finalisationRows = [
    {folder:'shared',declared_name:'shared',trainer:data.trainers[0]},
    {folder:'unknown',declared_name:'unknown'}
  ];
  renderHero(); renderDonut(); renderBenchCards(); renderTopPendingCards();
`);
assert.equal(run('commandSnapshot().groups.length'), 3);
assert.equal(run('commandSnapshot().duplicates'), 1);
assert.equal(run('commandSnapshot().unassigned'), 1);
assert.equal(elements.get('metricAccepted').textContent, '3');
assert.equal(elements.get('metricPendingTasks').textContent, '1');
assert.equal(elements.get('metricPaid').textContent, '$300');
run("byId('pipelineMode').value='historical'; renderDonut();");
assert.match(elements.get('pipelineDonut').innerHTML, /<strong>3<\/strong>/);
run("byId('teamFilter').value='Company'; renderHero(); renderBenchCards();");
assert.equal(elements.get('metricAccepted').textContent, '2');
assert.equal(run('commandSnapshot().current.length'), 2);
run('finalisationSource=null; renderHero(); renderTopPendingCards();');
assert.equal(elements.get('metricAccepted').textContent, '-');
assert.equal(elements.get('metricPendingTasks').textContent, '-');
assert.match(elements.get('topPendingCards').innerHTML, /require Pipeline/);
console.log('Command checks passed: deduplication, owner scope, payout source, history independence, missing source.');
