import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun } from '../web/js/run-summary.mjs';

const fixture = () => ({ messages:[{role:'assistant',content:[
  {type:'toolCall',id:'a',name:'edit',arguments:{path:'src/a.js'}},
  {type:'toolCall',id:'b',name:'bash',arguments:{command:'npm test'}},
  {type:'toolCall',id:'c',name:'read',arguments:{path:'README.md'}},
]}],results:new Map([['a',{details:{path:'src/a.js'}}],['b',{details:{exitCode:1}}]]),tools:new Map(),todos:[] });
test('restored sessions retain tool failures and edited paths without live events',()=>{
  const s=summarizeRun(fixture());assert.equal(s.rows.length,3);assert.equal(s.errors,1);assert.deepEqual(s.edited,['src/a.js']);assert.equal(s.rows[2].status,'interrupted');
});
test('live tool events reconcile with transcript without double counting',()=>{
  const t=fixture();t.tools.set('c',{name:'read',args:{path:'README.md'},status:'running',startedAt:100});
  const s=summarizeRun(t);assert.equal(s.rows.length,3);assert.equal(s.running,1);
});
test('undone edits and failed writes do not count as edited paths',()=>{
  const t=fixture();t.results.set('a',{details:{undone:true,path:'src/a.js'}});assert.deepEqual(summarizeRun(t).edited,[]);
  t.results.set('a',{isError:true,details:{path:'src/a.js'}});assert.deepEqual(summarizeRun(t).edited,[]);
});
test('durations are measured or absent and successful shell commands are only completed activity',()=>{
  const t=fixture();t.results.set('b',{details:{exitCode:0,wallTimeMs:34}});const s=summarizeRun(t);
  assert.equal(s.rows[1].status,'done');assert.equal(s.rows[1].duration,34);assert.equal(s.rows[0].duration,null);assert.equal(s.errors,0);
});
test('plan progress counts completed tasks rather than inferred success',()=>{
  const t=fixture();t.todos=[{tasks:[{status:'completed'},{status:'in_progress'},{status:'pending'}]}];assert.deepEqual(summarizeRun(t).tasks,{total:3,done:1});
});
test('approvals and ended processes are not reported as actively running tools',()=>{
  const t=fixture();t.tools.set('c',{name:'read',status:'running'});t.waitingTool='c';assert.equal(summarizeRun(t).rows[2].status,'waiting');
  t.waitingTool=null;t.dead=true;assert.equal(summarizeRun(t).running,0);
});
