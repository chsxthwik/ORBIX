import { h } from './dom.js';

const GLYPHS = [
  ['01110','11011','11011','11011','11011','11011','01110'],
  ['11110','11011','11011','11110','11100','11010','11011'],
  ['11110','11011','11011','11110','11011','11011','11110'],
  ['11111','00100','00100','00100','00100','00100','11111'],
  ['11011','11011','01110','00100','01110','11011','11011'],
];

// Brand artwork lives in the header, never in a separate tool panel.
// The loop exists only while visible and stops for reduced motion and hidden tabs.
export function asciiStage() {
  const el = h('canvas', { class: 'orbix-identity', 'aria-hidden': 'true' });
  const ctx = el.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false, stopped = false, raf = 0, last = 0, time = 0;
  let mode = 'idle', scene = Math.floor(Math.random()*4), phase = 0;
  let width = 480, height = 168, palette = null, paletteAt = 0;
  let aimX = 0, aimY = 0, px = 0, py = 0;
  const cols = 100, rows = 28, ramp = ' .:+=*#%@';
  function paint(now = performance.now()) {
    if (!ctx || !visible || document.hidden || !width) return;
    if (!palette || now-paletteAt > 800) {
      const css = getComputedStyle(document.documentElement);
      palette = { accent: css.getPropertyValue(mode === 'wait' ? '--warn' : '--accent').trim(), ink: css.getPropertyValue('--fg-3').trim() }; paletteAt = now;
    }
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (el.width !== Math.round(width*dpr) || el.height !== Math.round(height*dpr)) { el.width = Math.round(width*dpr); el.height = Math.round(height*dpr); }
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
    const cw = width/cols, ch = height/rows;
    ctx.font = `${Math.max(5,ch)}px "JetBrains Mono Variable", monospace`; ctx.textBaseline = 'middle';
    const fade = reduced.matches ? 1 : Math.min(1,phase/1.2,(20-phase)/1.2);
    for (let y=0;y<rows;y++) for (let x=0;x<cols;x++) {
      const u=(x-50)/22, v=(y-14)/10;
      let field=0;
      if (scene===0) field=Math.pow(Math.max(0,Math.sin(Math.hypot(u-px,v-py)*9-time*1.4)),8);
      else if(scene===1) field=Math.pow(Math.max(0,Math.cos(v*9+Math.sin(u*2+time)*2-time)),10);
      else if(scene===2) field=Math.pow(Math.max(0,Math.sin(u*6+v*4-time)*Math.cos(v*6-u*2+time*.5)),6);
      else field=Math.pow(Math.max(0,Math.cos(Math.hypot(u*1.2,v)*10-Math.atan2(v,u)*3+time)),8);
      // A stable, readable ORBIX silhouette with a moving character texture.
      const gx=Math.floor((x-21)/2), gy=Math.floor((y-7)/2);
      const letter=Math.floor(gx/6), col=gx%6;
      const brand=gx>=0&&gy>=0&&gy<7&&letter<5&&col<5&&GLYPHS[letter][gy][col]==='1';
      const energy=brand ? .6+.35*(.5+.5*Math.sin(x*.16+y*.22-time*1.7)) : field*.34*fade;
      if(energy<.08) continue;
      ctx.fillStyle=brand ? palette.accent : palette.ink;
      ctx.globalAlpha=brand ? .75+energy*.25 : energy;
      ctx.fillText(ramp[Math.min(8,Math.max(1,Math.floor(energy*8)))],x*cw,y*ch+ch/2);
    }
    ctx.globalAlpha=1;
  }
  function tick(now) {
    raf=0;
    if(stopped||!visible||document.hidden||reduced.matches) return;
    if(now-last>=66) {
      const dt=Math.min(.1,(now-last)/1000||0); last=now;
      time+=dt*(mode==='busy'?1.8:1); phase+=dt;
      if(phase>=20) { scene=(scene+1+Math.floor(Math.random()*3))%4; phase=0; }
      px+=(aimX-px)*.06; py+=(aimY-py)*.06; paint(now);
    }
    raf=requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(raf); raf=0; last=performance.now();
    if(visible&&!document.hidden) { paint(); if(!reduced.matches) raf=requestAnimationFrame(tick); }
  }
  const size=new ResizeObserver(entries=>{ const box=entries[0].contentRect; width=box.width; height=box.height; paint(); });
  const visibility=new IntersectionObserver(entries=>{ visible=entries[0].isIntersecting; sync(); });
  size.observe(el); visibility.observe(el);
  const abort=new AbortController();
  document.addEventListener('visibilitychange',sync,{signal:abort.signal});
  reduced.addEventListener('change',sync);
  el.addEventListener('pointermove',e=>{ const r=el.getBoundingClientRect(); aimX=(e.clientX-r.left)/r.width-.5; aimY=(e.clientY-r.top)/r.height-.5; });
  el.addEventListener('pointerleave',()=>{ aimX=aimY=0; });
  // Home has one lifetime in the app; explicit cleanup is available if it is remounted.
  return { el, setMode(m) { if(mode!==m) {mode=m;palette=null;paint();} }, destroy() { stopped=true;cancelAnimationFrame(raf);size.disconnect();visibility.disconnect();abort.abort();reduced.removeEventListener('change',sync); } };
}
