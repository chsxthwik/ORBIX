import { h, icon, fmtTokens, fmtCost, copyText } from './dom.js';
import { emit } from './store.js';
import { summarizeRun, filterRunRows } from './run-summary.mjs';

export function runInspector(tab, showChanges) {
  let current = tab, filter = 'all', signature = '';
  const rowCache=new Map();
  const metrics = h('div', { class: 'run-metrics' });
  const usage = h('div', { class: 'run-usage' });
  const rows = h('div', { class: 'run-rows' });
  const files = h('div', { class: 'run-paths' });
  const clearSearch=h('button',{class:'search-clear',type:'button','aria-label':'Clear activity search',hidden:true,onclick:()=>{search.value='';update(current);search.focus();}},icon('x',13));
  const search = h('input',{class:'run-search',type:'search',placeholder:'Search commands, tools, or paths…','aria-label':'Search tool activity',oninput:()=>update(current),onkeydown:e=>{if(e.key==='Escape'){e.stopPropagation();search.value='';update(current);}}});
  const matchCount=h('p',{class:'run-match-count',role:'status'});
  const filters = ['all','running','error'].map(key=>h('button', { type:'button', class:'run-filter', 'aria-pressed':String(key===filter), onclick:()=>{
    filter=key; filters.forEach((b,i)=>b.setAttribute('aria-pressed', String(['all','running','error'][i]===key))); signature='';update(current);
  } }, key==='all'?'All activity':key==='running'?'Running':'Failures'));
  const el = h('section', { class:'run-inspector', 'aria-label':'Run inspector' },
    h('div', { class:'run-heading' }, h('h2',null,'Session activity'), h('button',{class:'link',type:'button',onclick:()=>{
      const s=summarizeRun(current); copyText(s.rows.map(r=>`${r.status}\t${r.name}\t${r.detail}${r.exit != null ? `\texit ${r.exit}`:''}`).join('\n') || 'No tool activity recorded.');
    }},'Copy log')),metrics,usage,
    h('div',{class:'run-section-head'},h('h3',null,'Edited paths'),h('button',{type:'button',class:'link',onclick:showChanges},'Review diffs')),files,
    h('div',{class:'run-search-wrap'},search,clearSearch),h('div',{class:'run-filters',role:'group','aria-label':'Filter tool activity'},filters),matchCount,rows,
    h('p',{class:'run-footnote'},'Tool outcomes are recorded activity. Review diffs and command output before accepting changes.'));
  function update(t) {
    clearSearch.hidden=!search.value;
    current=t;const s=summarizeRun(t), tk=t.stats?.tokens;
    const sig=JSON.stringify([s,tk,t.stats?.cost,filter,search.value,t.streaming]);if(sig===signature)return;signature=sig;
    metrics.replaceChildren(...[[s.rows.length,'Tools'],[s.running,'Running'],[s.errors,'Failures'],[s.edited.length,'Edited paths']].map(([n,l])=>h('div',null,h('b',{class:l==='Failures'&&n?'has-errors':''},n),h('span',null,l))));
    const bits=[];if(tk)bits.push(`${fmtTokens((tk.input||0)+(tk.cacheRead||0)+(tk.cacheWrite||0))} in`,`${fmtTokens(tk.output||0)} out`);
    if(t.stats?.cost!=null)bits.push(fmtCost(t.stats.cost));if(s.tasks.total)bits.push(`${s.tasks.done}/${s.tasks.total} tasks`);
    usage.textContent=bits.join(' · ') || 'Usage appears after the first response.';
    files.replaceChildren(...(s.edited.length?s.edited.map(path=>h('button',{class:'run-path',type:'button',title:path,onclick:()=>emit('run:file',t,path)},icon('file',12),h('span',{class:'ell'},path.replace(/\\/g,'/').split('/').pop()))):[h('p',{class:'run-empty'},'No recorded file edits.')]));
    const matches=filterRunRows(s.rows,filter,search.value),list=matches.slice(0,100);
    matchCount.textContent=`${matches.length} matching tools${matches.length>100?' · showing latest 100':''}`;
    const focusedId=document.activeElement?.closest('.run-row')?.dataset.runId;
    const visibleIds=new Set(list.map(r=>r.id));
    for(const id of rowCache.keys())if(!visibleIds.has(id))rowCache.delete(id);
    const nodes=list.map(r=>{
      const key=JSON.stringify(r),cached=rowCache.get(r.id);
      if(cached?.key===key)return cached.el;
      const node=h('button',{class:`run-row ${r.status}`,type:'button',dataset:{runId:r.id},title:r.detail,onclick:()=>emit('run:reveal',current,r.id)},
      h('span',{class:'run-row-label'},icon(r.status==='error'?'alert':r.status==='running'?'activity':'check',12),h('strong',null,r.name),h('small',null,r.status==='done'?'Completed':r.status)),
      h('span',{class:'run-row-detail'},r.detail),r.duration!=null?h('span',{class:'run-duration'},r.duration<1000?`${r.duration} ms`:`${(r.duration/1000).toFixed(1)} s`):null);
      rowCache.set(r.id,{key,el:node});return node;
    });
    if(nodes.length){
      // Move only rows whose position changed; retain unchanged nodes and their focus.
      nodes.forEach((node,index)=>{if(rows.children[index]!==node)rows.insertBefore(node,rows.children[index]||null);});
      while(rows.children.length>nodes.length)rows.lastElementChild.remove();
    }else rows.replaceChildren(h('p',{class:'run-empty'},search.value?'No matching tool activity.':filter==='all'?'Tool activity will appear here.':`No ${filter==='error'?'failed':'running'} tools.`));
    if(focusedId&&visibleIds.has(focusedId))rowCache.get(focusedId)?.el.focus({preventScroll:true});
  }
  update(tab);return {el,update};
}
