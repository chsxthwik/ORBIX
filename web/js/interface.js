import { h } from './dom.js';

// Shared icon hints. One tooltip element, positioned outside clipped work surfaces.
// `data-tooltip-side="right"` puts the hint beside the control. The sidebar rail's icons carry `data-rail-tip` (label,
// then shortcut) and no title, and show it to their right.
const RAIL='.app.side-rail .sidebar [data-rail-tip]';
export function initInterface() {
  if(document.getElementById('orbix-control-tooltip'))return;
  const tip=h('div',{class:'control-tooltip',id:'orbix-control-tooltip',role:'tooltip',hidden:true});
  document.body.append(tip);
  let target=null,timer=0,previous='';
  const find=(node)=>node?.closest?.(RAIL)||node?.closest?.('[data-tooltip]');
  function hide(){
    clearTimeout(timer);tip.hidden=true;
    if(target){if(previous)target.setAttribute('aria-describedby',previous);else target.removeAttribute('aria-describedby');}
    target=null;previous='';
  }
  function show(el,delay){
    if(target===el)return;hide();target=el;previous=el.getAttribute('aria-describedby')||'';
    timer=setTimeout(()=>{
      if(!el.isConnected||el.disabled)return hide();
      const rail=el.matches(RAIL);
      // "Settings (Ctrl+,)" shows the label and the shortcut as keys.
      const text=rail?el.dataset.railTip:el.getAttribute('title')||el.dataset.tooltip,keys=/^(.+?)\s*\(((?:Ctrl|Shift|Alt|Esc|Enter|Tab)\b[^)]*)\)$/.exec(text);
      tip.replaceChildren(keys?keys[1]:text,...(keys?[h('span',{class:'tip-keys'},...keys[2].split(/\+(?=.)/).map(k=>h('kbd',null,k)))]:[]));
      tip.hidden=false;
      el.setAttribute('aria-describedby',[previous,tip.id].filter(Boolean).join(' '));
      const r=el.getBoundingClientRect(),box=tip.getBoundingClientRect();
      if((rail||el.dataset.tooltipSide==='right')&&r.right+box.width+16<innerWidth){
        tip.dataset.side='right';
        tip.style.left=`${r.right+8}px`;
        tip.style.top=`${Math.max(8,Math.min(innerHeight-box.height-8,r.top+r.height/2-box.height/2))}px`;
        return;
      }
      tip.style.left=`${Math.max(8,Math.min(innerWidth-box.width-8,r.left+r.width/2-box.width/2))}px`;
      const below=r.bottom+box.height+12<innerHeight;tip.dataset.side=below?'bottom':'top';
      tip.style.top=`${below?r.bottom+7:Math.max(8,r.top-box.height-7)}px`;
    },delay);
  }
  document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const el=find(e.target);if(el)show(el,350);});
  document.addEventListener('pointerout',e=>{if(target&&!target.contains(e.relatedTarget))hide();});
  document.addEventListener('focusin',e=>{const el=find(e.target);if(el&&el.matches(':focus-visible'))show(el,100);});
  document.addEventListener('focusout',hide);
  document.addEventListener('pointerdown',hide,true);
  document.addEventListener('scroll',hide,true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();},true);
  addEventListener('resize',hide);addEventListener('blur',hide);
}
