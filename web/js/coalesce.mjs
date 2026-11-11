// A bounded update queue: bursts share a refresh, continuous streams cannot postpone it.
export function coalesce(fn, { delay=100, schedule=setTimeout, unschedule=clearTimeout } = {}) {
  let pending=null, latest;
  const run=(...args)=>{
    latest=args;
    if(pending!==null)return;
    pending=schedule(()=>{pending=null;const args=latest;latest=null;fn(...args);},delay);
  };
  run.cancel=()=>{if(pending!==null)unschedule(pending);pending=null;latest=null;};
  return run;
}
