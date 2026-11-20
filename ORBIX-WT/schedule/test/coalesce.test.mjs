import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coalesce} from '../web/js/coalesce.mjs';
function clock(){let next=0;const jobs=new Map();return {jobs,schedule:fn=>{jobs.set(++next,fn);return next;},unschedule:id=>jobs.delete(id),flush(){const f=[...jobs.values()];jobs.clear();f.forEach(fn=>fn());}};}
test('bursts share one scheduled update with the latest arguments',()=>{const c=clock(),seen=[];const run=coalesce(x=>seen.push(x),c);run(1);run(2);run(3);assert.equal(c.jobs.size,1);c.flush();assert.deepEqual(seen,[3]);});
test('continuous input produces bounded updates rather than postponing them',()=>{const c=clock(),seen=[];const run=coalesce(x=>seen.push(x),c);for(let i=0;i<6;i++){run(i);if(i%2)c.flush();}assert.deepEqual(seen,[1,3,5]);});
test('cancelled callbacks release their payload and a new burst can run',()=>{const c=clock(),seen=[];const run=coalesce(x=>seen.push(x),c);run('stale');run.cancel();c.flush();assert.deepEqual(seen,[]);run('fresh');c.flush();assert.deepEqual(seen,['fresh']);});
