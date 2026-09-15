const assert = require('node:assert/strict');
require('../finalisation.js');
const reconcile = require('../accepted-tasks.js');
const trainers = [{email:'a@example.com',name:'A',team:'Company'},{email:'b@example.com',name:'B',team:'Computer A'}];
const audit = reconcile([
  {id:'f1',name:'shared',source:'Finalisation',email:'a@example.com',is_connector:true,domain:null,date:'2026-09-15'},
  {id:'c1',name:'shared',source:'Current pipeline',email:'a@example.com',domain:'Law',date:'2026-09-15'},
  {id:'f2',name:'unowned',source:'Finalisation',domain:'Health',date:''},
  {id:'f3',name:'conflict',source:'Finalisation',email:'a@example.com',is_connector:false},
  {id:'c3',name:'conflict',source:'Current pipeline',email:'b@example.com'}
]);
const select = filters => global.filterFinalisationRecords(audit.rows, {source:'Finalisation',...filters}, trainers);
assert.equal(select({}).rows.length, 3);
assert.equal(select({}).linked, 1); // A missing domain does not imply a missing owner.
assert.equal(select({ownership:'conflict'}).rows.length, 1);
assert.equal(select({emails:['a@example.com']}).rows.length, 1); // Conflicts cannot leak into trainer totals.
assert.equal(select({duplicates:'duplicates'}).rows.length, 0); // No silent inclusion of current records.
assert.equal(select({source:'',duplicates:'duplicates'}).rows.length, 2);
assert.equal(select({source:'',duplicates:'unique'}).rows.length, 3);
assert.equal(select({duplicates:'groups'}).rows.length, 2);
assert.equal(select({type:'Not recorded'}).rows.length, 1);
assert.equal(select({domain:'Not recorded',ownership:'linked'}).rows.length, 1);
assert.equal(select({start:'2026-09-15',end:'2026-09-15'}).rows.length, 1);
assert.equal(select({start:'2026-09-16',end:'2026-09-15'}).invalidDates, true);
assert.equal(select({search:'shared',bench:'company',type:'Connector'}).rows.length, 1);
for (const source of ['Finalisation','Current pipeline','']) {
  for (const duplicates of ['','unique','duplicates','groups']) {
    const result = select({source,duplicates});
    assert.equal(result.duplicates, result.rows.filter(row => row.duplicate).length);
    assert.equal(result.groups,new Set(result.rows.map(row => row.countedId)).size);
    assert.equal(result.linked,result.rows.filter(row => row.resolvedTrainer).length);
  }
}
console.log('Finalisation filter checks passed: source isolation, linked owners, conflicts, duplicates, missing metadata, dates, combinations and summaries.');
