import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSessions } from '../web/js/session-library.mjs';
import { filterRunRows } from '../web/js/run-summary.mjs';
const sessions=[{path:'a',title:'Fix login',preview:'token refresh',cwd:'C:/Project',mtime:30},{path:'b',title:'Build search',preview:'keyboard navigation',cwd:'C:/Other',mtime:10},{path:'c',title:'Review API',preview:'error handling',mtime:20}];
test('library searches every query word across title, project and message',()=>{assert.deepEqual(selectSessions(sessions,{query:'PROJECT token'}).map(s=>s.path),['a']);});
test('open and pinned filters are independent of recency and combine with search',()=>{
  assert.deepEqual(selectSessions(sessions,{filter:'open',openPaths:['b']}).map(s=>s.path),['b']);
  assert.deepEqual(selectSessions(sessions,{filter:'pinned',pinned:['a','c'],query:'API'}).map(s=>s.path),['c']);
});
test('sorting does not mutate saved sessions or pin order',()=>{assert.deepEqual(selectSessions(sessions,{sort:'oldest'}).map(s=>s.path),['b','c','a']);assert.deepEqual(sessions.map(s=>s.path),['a','b','c']);assert.deepEqual(selectSessions(sessions,{sort:'title'}).map(s=>s.path),['b','a','c']);});
test('missing metadata and unmatched queries return a usable empty result',()=>{assert.deepEqual(selectSessions([{}],{query:'missing'}),[]);assert.equal(selectSessions([{}]).length,1);});
test('tool search combines status and multiword queries and keeps source order intact',()=>{
  const rows=[{name:'bash',detail:'npm test',status:'error'},{name:'read',detail:'test.js',status:'done'},{name:'bash',detail:'node test',status:'error'}];
  assert.deepEqual(filterRunRows(rows,'error','BASH test').map(r=>r.detail),['node test','npm test']);assert.equal(rows[0].detail,'npm test');assert.deepEqual(filterRunRows(rows,'running','test'),[]);
});
