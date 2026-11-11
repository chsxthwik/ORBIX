export function selectSessions(sessions, { query='', filter='all', sort='recent', pinned=[], openPaths=[] } = {}) {
  const pins=new Set(pinned), open=new Set(openPaths), words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter(s=>{
    if(filter==='pinned'&&!pins.has(s.path))return false;
    if(filter==='open'&&!open.has(s.path))return false;
    const text=`${s.title||''} ${s.preview||''} ${s.cwdDisplay||s.cwd||''}`.toLocaleLowerCase();
    return words.every(w=>text.includes(w));
  }).slice().sort((a,b)=>sort==='title'?String(a.title||'').localeCompare(String(b.title||'')):sort==='oldest'?(a.mtime||0)-(b.mtime||0):(b.mtime||0)-(a.mtime||0));
}
