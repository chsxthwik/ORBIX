import { h, rafThrottle } from './dom.js';

// Shared icon hints. One tooltip element, positioned outside clipped work surfaces.
export function initInterface() {
  if(document.getElementById('orbix-control-tooltip'))return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const move=rafThrottle((el,x,y)=>{
    if(!el.isConnected||document.hidden)return;
    const rect=el.getBoundingClientRect();
    el.style.setProperty('--pointer-x',`${x-rect.left}px`);
    el.style.setProperty('--pointer-y',`${y-rect.top}px`);
  });
  document.addEventListener('pointermove',e=>{
    if(reduced.matches||e.pointerType==='touch')return;
    const el=e.target.closest?.('.home-composer,.ws-recipe,.workspace-action');
    if(el)move(el,e.clientX,e.clientY);
  },{passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)move.cancel();});
  const tip=h('div',{class:'control-tooltip',id:'orbix-control-tooltip',role:'tooltip',hidden:true});
  document.body.append(tip);
  let target=null,timer=0,previous='';
  function hide(){
    clearTimeout(timer);tip.hidden=true;
    if(target){if(previous)target.setAttribute('aria-describedby',previous);else target.removeAttribute('aria-describedby');}
    target=null;previous='';
  }
  function show(el,delay){
    if(target===el)return;hide();target=el;previous=el.getAttribute('aria-describedby')||'';
    timer=setTimeout(()=>{
      if(!el.isConnected||el.disabled)return hide();
      tip.textContent=el.getAttribute('title')||el.dataset.tooltip;tip.hidden=false;
      el.setAttribute('aria-describedby',[previous,tip.id].filter(Boolean).join(' '));
      const r=el.getBoundingClientRect(),box=tip.getBoundingClientRect();
      tip.style.left=`${Math.max(8,Math.min(innerWidth-box.width-8,r.left+r.width/2-box.width/2))}px`;
      tip.style.top=`${r.bottom+box.height+12<innerHeight?r.bottom+7:Math.max(8,r.top-box.height-7)}px`;
    },delay);
  }
  document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=e.target.closest?.('[data-tooltip]');if(el)show(el,350);});
  document.addEventListener('pointerout',e=>{if(target&&!target.contains(e.relatedTarget))hide();});
  document.addEventListener('focusin',e=>{const el=e.target.closest?.('[data-tooltip]');if(el&&el.matches(':focus-visible'))show(el,100);});
  document.addEventListener('focusout',hide);
  document.addEventListener('pointerdown',hide,true);
  document.addEventListener('scroll',hide,true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();},true);
  addEventListener('resize',hide);addEventListener('blur',hide);
}
