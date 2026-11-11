import { h, icon, baseName, timeAgo } from './dom.js';
import { S, tabForSession, savePrefs } from './store.js';
import { selectSessions } from './session-library.mjs';
const state={query:'',filter:'all',sort:'recent'};
let mounted=null;

export function sessionLibrary(H) {
  if(mounted){mounted.refresh();return mounted.el;}
  const list=h('div',{class:'library-list'}), count=h('span',{class:'library-count',role:'status'});
  const clearSearch=h('button',{class:'search-clear',type:'button','aria-label':'Clear session search',hidden:!state.query,onclick:()=>{state.query='';search.value='';draw();search.focus();}},icon('x',13));
  const search=h('input',{type:'search',class:'library-search',placeholder:'Search title, project, or message…','aria-label':'Search saved conversations',value:state.query,oninput:e=>{state.query=e.target.value;draw();},onkeydown:e=>{if(e.key==='Escape'){e.stopPropagation();state.query='';search.value='';draw();}}});
  const filters=['all','open','pinned'].map(key=>h('button',{class:'library-filter',type:'button','aria-pressed':String(state.filter===key),onclick:()=>{
    state.filter=key;filters.forEach((b,i)=>b.setAttribute('aria-pressed',String(['all','open','pinned'][i]===key)));draw();
  }},key==='all'?'All sessions':key==='open'?'Open':'Pinned'));
  const sort=h('select',{'aria-label':'Sort conversations',class:'library-sort',onchange:e=>{state.sort=e.target.value;draw();}},
    ...[['recent','Recent first'],['oldest','Oldest first'],['title','Title A–Z']].map(([value,label])=>h('option',{value,selected:state.sort===value},label)));
  const el=h('section',{class:'session-library','aria-label':'Session library'},
    h('div',{class:'library-heading'},h('div',null,h('h2',null,'Your sessions'),h('p',null,'Continue a conversation or keep one close.')),h('button',{class:'link',type:'button',onclick:H.manage},'Manage')),
    h('div',{class:'library-search-wrap'},icon('search',15),search,clearSearch),
    h('div',{class:'library-toolbar'},h('div',{class:'library-filters',role:'group','aria-label':'Filter saved conversations'},filters),sort),list,count);
  function draw(){
    clearSearch.hidden=!state.query;
    const pins=Array.isArray(S.ui.pinned)?S.ui.pinned:[],openPaths=S.sessions.filter(s=>!!tabForSession(s)).map(s=>s.path);
    const matches=selectSessions(S.sessions,{...state,pinned:pins,openPaths});
    count.textContent=`${matches.length} of ${S.sessions.length} sessions`;
    list.replaceChildren(...(matches.length?matches.slice(0,100).map(s=>{
      const tab=tabForSession(s),pin=pins.includes(s.path);
      return h('div',{class:'library-row'},h('button',{class:'library-open',type:'button',title:s.preview||s.title,onclick:()=>H.openSession(s)},
        h('span',{class:'library-avatar'},icon(tab?.streaming?'activity':'message',16)),
        h('span',{class:'library-main'},h('strong',{class:'ell'},s.title||'Untitled session'),h('span',{class:'ell'},baseName(s.cwdDisplay||s.cwd||'Project'), ' · ', timeAgo(s.mtime))),
        tab?h('span',{class:'library-badge'+(tab.streaming?' working':'')},tab.streaming?'Working':'Open'):icon('chevron-right',13)),
        h('button',{class:'library-pin'+(pin?' on':''),type:'button','aria-label':`${pin?'Unpin':'Pin'} ${s.title||'session'}`,'aria-pressed':String(pin),onclick:()=>{
          const current=Array.isArray(S.ui.pinned)?S.ui.pinned:[];
          savePrefs({pinned:current.includes(s.path)?current.filter(p=>p!==s.path):[s.path,...current].slice(0,20)});draw();
        }},icon('bookmark',14)));
    }):[h('div',{class:'library-empty'},icon('search',22),h('strong',null,state.filter==='pinned'?'No pinned sessions':state.filter==='open'?'No open sessions':'No matching sessions'),h('p',null,state.filter==='pinned'?'Pin a conversation to find it here.':'Try another filter or start a new task.'),h('button',{class:'link',type:'button',onclick:()=>{state.query='';state.filter='all';search.value='';filters.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===0)));draw();}},'Reset filters'))]));
    if(matches.length>100)list.append(h('p',{class:'library-limit'},'Showing 100 sessions. Search to narrow the list.'));
  }
  draw();mounted={el,refresh:draw};return el;
}
