(() => {
  "use strict";

  const root = document.documentElement;
  root.classList.remove("no-js");
  root.classList.add("js");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const $ = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const TAU = Math.PI * 2;

  function splitWords(el, wrap) {
    let i = 0;
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            frag.appendChild(wrap(part, i++));
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1 && child.tagName !== "BR") walk(child);
      });
    };
    walk(el);
  }
  $$(".split").forEach((h) => splitWords(h, (word, i) => {
    const w = document.createElement("span");
    w.className = "w";
    const wi = document.createElement("span");
    wi.className = "wi";
    wi.textContent = word;
    wi.style.transitionDelay = i * 55 + "ms";
    w.appendChild(wi);
    return w;
  }));

  const statement = $("[data-scrub]");
  let statementWords = [];
  if (statement) {
    splitWords(statement, (word) => {
      const s = document.createElement("span");
      s.className = "sw" + (/^(never|always\.?)$/i.test(word) ? " hot-word" : "");
      s.textContent = word;
      return s;
    });
    statementWords = $$(".sw", statement);
  }

  const revealables = $$(".section-head > p:not(.kicker), .rules article, .kbd-list li, .cmds, .cmd-say, .dl-card, .steps li, .demo-foot, .scene-n, .seg, .eng-foot");
  if ("IntersectionObserver" in window && !reduced) {
    revealables.forEach((el) => el.classList.add("reveal"));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const sibs = [...e.target.parentElement.children].filter((c) => c.classList.contains("reveal"));
        e.target.style.transitionDelay = Math.min(6, sibs.indexOf(e.target)) * 70 + "ms";
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    revealables.forEach((el) => io.observe(el));
    const ioSplit = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-in");
        ioSplit.unobserve(e.target);
      });
    }, { rootMargin: "0px 0px -12% 0px" });
    $$(".split").forEach((el) => ioSplit.observe(el));
  } else {
    $$(".split").forEach((el) => el.classList.add("is-in"));
  }

  (function buildLog() {
    const log = $("#log");
    if (!log) return;
    const files = ["src/auth/validate.ts", "src/cart/total.ts", "api/routes/orders.ts", "web/nav.tsx", "lib/db/pool.ts", "scripts/deploy.sh", "src/auth/login.ts", "test/cart.test.ts"];
    const out = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 26; i++) {
      const f = files[Math.floor(rnd() * files.length)];
      const r = rnd();
      if (r < .28) out.push(`<div><span class="k">&#9656; read</span> ${f}</div><div>&nbsp;&nbsp;${10 + Math.floor(rnd() * 140)} lines</div>`);
      else if (r < .5) out.push(`<div><span class="k">&#9656; grep</span> "${["EMAIL", "total", "pool", "retry"][Math.floor(rnd() * 4)]}" src/</div><div>&nbsp;&nbsp;${1 + Math.floor(rnd() * 9)} matches</div>`);
      else if (r < .78) out.push(`<div><span class="w">&#9656; edit</span> ${f}</div><div><span class="g">&nbsp;&nbsp;applied</span></div>`);
      else out.push(`<div>$ ${["npm test", "pnpm build", "git status", "tsc --noEmit"][Math.floor(rnd() * 4)]}</div><div>&nbsp;&nbsp;${["14 passed", "built in 2.1s", "3 files changed", "0 errors"][Math.floor(rnd() * 4)]}</div>`);
    }
    log.innerHTML = out.join("") + out.join("");
  })();

  const readyAt = performance.now();
  const hero = { p: 0, visible: true };
  const wm = $("#wm");
  const node = $("#wm-node");
  if (wm && node) {
    let t = Math.PI * .15, last = performance.now();
    const place = (now) => {
      const dt = Math.min(50, now - last);
      last = now;
      const W = wm.offsetWidth, H = wm.offsetHeight;
      const sw = W * 1.18, sh = sw * 170 / 1000;
      const cx = W / 2, cy = H / 2 + sh * .04;
      const rx = sw * .48, ry = sh * (70 / 170) * (1 + hero.p * 1.9);
      const th = (-8 + hero.p * 10) * Math.PI / 180;
      if (!reduced) t += dt * .00065;
      const lx = rx * Math.cos(t), ly = ry * Math.sin(t);
      const x = cx + lx * Math.cos(th) - ly * Math.sin(th);
      const yy = cy + lx * Math.sin(th) + ly * Math.cos(th);
      const front = Math.sin(t) > 0;
      const shown = clamp((now - readyAt - 1900) / 600);
      node.style.transform = `translate(${x}px, ${yy}px) scale(${front ? 1 : .68})`;
      node.style.opacity = String(shown * (front ? 1 : .45));
      node.style.zIndex = front ? "4" : "1";
      if (!reduced) requestAnimationFrame(place);
    };
    requestAnimationFrame(place);
  }

  const nav = $(".nav");
  const bar = $("#progress");
  const heroSection = $("#hero");
  const heroSticky = $("#hero-sticky");
  const winWrap = $("#win-wrap");
  const win = $("#win");
  const track = $("#problem-track");
  const pStage = $("#problem-stage");
  const caps = $$(".cap");
  const capDots = $$(".dots-nav li");
  const map = $("#map");
  const scenes = $$(".scenes li");
  const navLinks = $$(".nav nav a");
  const sections = navLinks.map((a) => $(a.getAttribute("href"))).filter(Boolean);

  function onFrame() {
    const vh = window.innerHeight;
    const y = window.scrollY;
    const docH = root.scrollHeight - vh;
    bar.style.transform = `scaleX(${docH > 0 ? y / docH : 0})`;
    nav.classList.toggle("is-scrolled", y > 10);

    let here = null;
    sections.forEach((s) => { if (s.getBoundingClientRect().top < vh * .4) here = s; });
    navLinks.forEach((a) => a.classList.toggle("is-here", here && a.getAttribute("href") === "#" + here.id));

    if (!reduced) {
      const hr = heroSection.getBoundingClientRect();
      hero.p = clamp(-hr.top / Math.max(1, hr.height - vh));
      hero.visible = hr.bottom > 0;
      heroSticky.style.setProperty("--p", hero.p.toFixed(4));

      // the problem scene
      const tr = track.getBoundingClientRect();
      const p = clamp(-tr.top / Math.max(1, tr.height - vh));
      const fl = seg(p, .27, .33) * (1 - seg(p, .44, .5));
      pStage.style.setProperty("--tm", (1 - seg(p, .46, .56)).toFixed(3));
      pStage.style.setProperty("--fl", fl.toFixed(3));
      pStage.style.setProperty("--ti", ease(seg(p, .5, .62)).toFixed(3));
      pStage.style.setProperty("--ck", ease(seg(p, .76, .9)).toFixed(3));
      caps.forEach((c, i) => {
        const a = i * .25, b = a + .25;
        const inn = seg(p, a + .005, a + .06), out = i === caps.length - 1 ? 0 : seg(p, b - .045, b - .005);
        c.style.opacity = (inn * (1 - out)).toFixed(3);
        c.style.transform = `translate3d(0, ${((1 - inn) * 20 - out * 14).toFixed(1)}px, 0)`;
      });
      const idx = Math.min(3, Math.floor(p * 4));
      capDots.forEach((d, i) => d.classList.toggle("on", i === idx));

      const wr = winWrap.getBoundingClientRect();
      win.style.setProperty("--t", clamp((wr.top - vh * .18) / (vh * .7)).toFixed(4));

      if (statementWords.length) {
        const sr = statement.getBoundingClientRect();
        const s = clamp((vh * .88 - sr.top) / (vh * .55 + sr.height * .3));
        const lit = Math.round(s * statementWords.length);
        statementWords.forEach((w, i) => {
          w.classList.toggle("on", i < lit);
          w.classList.toggle("hot", i < lit && w.classList.contains("hot-word"));
        });
      }
    }

    if (map && scenes.length) {
      let active = scenes[0];
      scenes.forEach((li) => { if (li.getBoundingClientRect().top < vh * .58) active = li; });
      scenes.forEach((li) => li.classList.toggle("is-on", li === active));
      $$(".map-pane", map).forEach((pn) => pn.classList.toggle("is-on", pn.dataset.pane === active.dataset.scene));
    }
  }
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; onFrame(); });
  };
  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  if (reduced) {
    statementWords.forEach((w) => { w.classList.add("on"); if (w.classList.contains("hot-word")) w.classList.add("hot"); });
    caps.forEach((c) => { c.style.opacity = 1; });
  }

  const orbit = $("#orbit");
  const lists = { orbix: $("#orbit-list-orbix"), omp: $("#orbit-list-omp") };
  $$("li", lists.orbix).forEach((li) => { if (/^(Ollama|LM Studio)$/.test(li.textContent)) li.classList.add("is-local"); });
  const factsEl = { orbix: $("#eng-orbix"), omp: $("#eng-omp") };
  const segEl = $("#seg");
  let engine = "orbix", orbitItems = $$("li", lists.orbix), spawnStart = 0, orbitVisible = false, engineTouched = false;

  function setEngine(name, byUser) {
    if (byUser) engineTouched = true;
    if (name === engine) return;
    engine = name;
    segEl.dataset.on = name;
    $$("button", segEl).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.engine === name)));
    Object.entries(factsEl).forEach(([k, el]) => {
      el.classList.remove("is-on");
      el.hidden = k !== name;
    });
    void factsEl[name].offsetWidth;
    factsEl[name].classList.add("is-on");
    Object.entries(lists).forEach(([k, el]) => { el.hidden = k !== name; });
    orbitItems = $$("li", lists[name]);
    spawnStart = performance.now();
  }
  $$("button", segEl).forEach((b) => b.addEventListener("click", () => setEngine(b.dataset.engine, true)));
  segEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { setEngine(engine === "orbix" ? "omp" : "orbix", true); e.preventDefault(); }
  });
  factsEl.orbix.classList.add("is-on");
  if (!reduced) setInterval(() => { if (orbitVisible && !engineTouched && !document.hidden) setEngine(engine === "orbix" ? "omp" : "orbix", false); }, 6500);

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      orbitVisible = entries[0].isIntersecting;
      if (orbitVisible && !spawnStart) spawnStart = performance.now();
    }, { threshold: .2 }).observe(orbit);
  } else { orbitVisible = true; spawnStart = performance.now(); }

  let orbitAngle = 0, orbitSpeed = 1, orbitHover = false;
  orbit.addEventListener("pointerenter", () => { orbitHover = true; });
  orbit.addEventListener("pointerleave", () => { orbitHover = false; });
  const orbitTrack = $("#orbit-track");
  // names sit on two rings, outer and inner, turning in opposite directions
  const ORBIT_RINGS = [
    { tilt: -9, speed: 1, scale: 1 },
    { tilt: 16, speed: -1.3, scale: .6 }
  ];
  function layoutOrbit(now, dt) {
    if (window.innerWidth <= 720) return;
    orbitSpeed = lerp(orbitSpeed, orbitHover ? .25 : 1, .06);
    if (!reduced) orbitAngle += dt * .00014 * orbitSpeed;
    const w = orbit.clientWidth, h = orbit.clientHeight;
    const widest = orbitItems.reduce((m, li) => Math.max(m, li.offsetWidth), 0);
    const rxOut = Math.max(120, Math.min(w * .42, 470, w / 2 - widest / 2 - 10));
    const ryOut = Math.min(h * .36, rxOut * .42);
    const cx = w / 2, cy = h / 2;
    const key = w + "x" + h + "x" + Math.round(rxOut);
    const ellipses = $$("ellipse", orbitTrack);
    if (orbitTrack.dataset.size !== key) {
      orbitTrack.dataset.size = key;
      orbitTrack.setAttribute("viewBox", `0 0 ${w} ${h}`);
      ORBIT_RINGS.forEach((ring, k) => {
        ring.rx = rxOut * ring.scale;
        ring.ry = ryOut * ring.scale;
        const e = ellipses[k];
        e.setAttribute("cx", cx); e.setAttribute("cy", cy);
        e.setAttribute("rx", ring.rx); e.setAttribute("ry", ring.ry);
        e.setAttribute("transform", `rotate(${ring.tilt} ${cx} ${cy})`);
      });
    }
    const counts = [0, 0];
    orbitItems.forEach((_, i) => counts[i % 2]++);
    const since = spawnStart ? now - spawnStart : -1;
    orbitItems.forEach((li, i) => {
      const ring = ORBIT_RINGS[i % 2];
      const k = Math.floor(i / 2);
      // each name leaves the core a moment after the one before it
      const s = reduced ? 1 : since < 0 ? 0 : ease(clamp((since - i * 80) / 1500));
      const phase = (k / counts[i % 2]) * TAU;
      const tt = orbitAngle * ring.speed + phase + (1 - s) * 1.4;
      const lx = ring.rx * s * Math.cos(tt), ly = ring.ry * s * Math.sin(tt);
      const th = ring.tilt * Math.PI / 180;
      const x = cx + lx * Math.cos(th) - ly * Math.sin(th);
      const y = cy + lx * Math.sin(th) + ly * Math.cos(th);
      const depth = (Math.sin(tt) + 1) / 2;
      li.style.transform = `translate(${x - li.offsetWidth / 2}px, ${y - li.offsetHeight / 2}px) scale(${(.8 + depth * .2) * (.4 + s * .6)})`;
      li.style.opacity = String((.4 + depth * .6) * s);
      li.style.zIndex = depth > .5 ? "30" : "10";
      li.classList.toggle("is-front", depth > .7 && s > .9);
    });
  }

  /* one animation loop for everything that moves on its own */
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(64, now - last);
    last = now;
    if (!document.hidden) {
      if (orbitVisible || spawnStart === 0) layoutOrbit(now, dt);
    }
    requestAnimationFrame(loop);
  }

  if (finePointer && !reduced) {
    $$(".btn-magnet").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        b.style.transform = `translate(${(e.clientX - (r.left + r.width / 2)) * .16}px, ${(e.clientY - (r.top + r.height / 2)) * .28}px)`;
      });
      b.addEventListener("pointerleave", () => { b.style.transform = ""; });
    });
  }
  const say = $("#cmd-say");
  const cmdOut = $("#cmd-out");
  $$("#cmds button").forEach((b) => {
    const show = () => {
      $$("#cmds button").forEach((x) => x.classList.toggle("is-on", x === b));
      say.textContent = b.dataset.say;
      cmdOut.textContent = b.dataset.out;
    };
    b.addEventListener("mouseenter", show);
    b.addEventListener("focus", show);
    b.addEventListener("click", show);
  });

  const chat = $("#chat");
  const plan = $("#plan");
  const approve = $("#approve");
  const approveQ = $("#approve-q");
  const approveBtns = $("#approve-btns");
  const sbTokens = $("#sb-tokens"), sbCost = $("#sb-cost"), sbState = $("#sb-state");
  const planFill = $("#plan-fill");
  const composer = $(".composer", win), ctext = $(".composer-text", win), sendBtn = $(".send", win);
  const PLACEHOLDER = ctext.textContent;
  let runId = 0, demoInView = false, pendingKeys = null;

  class Cancelled extends Error {}
  const wait = (ms, id) => new Promise((resolve, reject) => {
    setTimeout(() => (id === runId ? resolve() : reject(new Cancelled())), reduced ? Math.min(ms, 40) : ms);
  });
  const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const setPlan = (step, cls) => {
    const li = $(`[data-step="${step}"]`, plan);
    li.classList.remove("is-doing", "is-done", "is-skip");
    if (cls) li.classList.add(cls);
    planFill.style.width = ($$(".is-done", plan).length / 3 * 100) + "%";
  };
  const STATES = { idle: "idle", busy: "working", ask: "waiting for you", done: "done" };
  const setState = (st) => {
    win.dataset.state = st;
    sbState.textContent = STATES[st];
  };
  let shownTok = 0, shownCost = 0, usageRaf = 0;
  const paintUsage = (tok, cost) => {
    sbTokens.textContent = Math.round(tok).toLocaleString("en-US") + " tokens";
    sbCost.textContent = "$" + cost.toFixed(3);
  };
  const usage = (tokens, cost) => {
    cancelAnimationFrame(usageRaf);
    const a = shownTok, b = shownCost, t0 = performance.now();
    shownTok = tokens; shownCost = cost;
    if (reduced || (tokens === 0 && cost === 0)) { paintUsage(tokens, cost); return; }
    const step = (now) => {
      const k = ease(clamp((now - t0) / 700));
      paintUsage(a + (tokens - a) * k, b + (cost - b) * k);
      if (k < 1) usageRaf = requestAnimationFrame(step);
    };
    usageRaf = requestAnimationFrame(step);
  };
  const turn = () => {
    const t = el("div", "turn");
    const av = el("img", "avatar");
    av.src = "assets/img/logo.svg?v=3";
    av.alt = "ORBIX";
    t.appendChild(av);
    chat.appendChild(t);
    return t;
  };
  async function speak(t, html, id, think = 700) {
    const p = el("p", "say is-thinking", '<span class="dots"><i></i><i></i><i></i></span>');
    t.appendChild(p);
    scrollDown();
    await wait(think, id);
    p.classList.remove("is-thinking");
    if (reduced) { p.innerHTML = html; scrollDown(); return; }
    p.classList.add("is-streaming");
    const parts = html.match(/<[^>]+>|\s+|[^\s<]+/g) || [];
    let out = "";
    for (const part of parts) {
      out += part;
      if (part[0] === "<" || /^\s/.test(part)) continue;
      p.innerHTML = out;
      scrollDown();
      await wait(16 + Math.random() * 26, id);
    }
    p.innerHTML = html;
    p.classList.remove("is-streaming");
    scrollDown();
  }
  function tool(t, name, arg) {
    const card = el("div", "tool is-run");
    card.appendChild(el("div", "tool-head",
      `<span class="tool-name">${name}</span><span class="tool-arg">${arg}</span><span class="tool-state"><span class="spin"></span></span>`));
    t.appendChild(card);
    scrollDown();
    return card;
  }
  const state = (card, cls, text) => {
    card.classList.remove("is-run", "is-ok", "is-ask", "is-no");
    card.classList.add(cls);
    $(".tool-state", card).textContent = text;
  };
  const body = (card, html) => { card.appendChild(el("div", "tool-body", html)); scrollDown(); };

  function askFor(question, choices) {
    return new Promise((resolve) => {
      approveQ.innerHTML = question;
      approveBtns.innerHTML = "";
      setState("ask");
      const finish = (value, btn) => {
        if (btn) btn.classList.add("is-pressed");
        pendingKeys = null;
        approve.classList.add("is-leaving");
        setTimeout(() => {
          approve.hidden = true;
          approve.classList.remove("is-leaving");
          setState("busy");
          resolve(value);
        }, reduced ? 0 : 260);
      };
      const keys = {};
      choices.forEach(([key, label, value, cls]) => {
        const b = el("button", cls, `<kbd>${key}</kbd>${label}`);
        b.type = "button";
        b.addEventListener("click", () => finish(value, b));
        approveBtns.appendChild(b);
        keys[key === "Esc" ? "Escape" : key] = () => finish(value, b);
      });
      pendingKeys = keys;
      approve.hidden = false;
      const myRun = runId;
      setTimeout(() => {
        if (myRun === runId && !approve.hidden && !$(".hint", approveBtns)) approveBtns.appendChild(el("span", "hint", "your call"));
      }, reduced ? 0 : 1800);
    });
  }
  window.addEventListener("keydown", (e) => {
    if (!pendingKeys || !demoInView || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
    const act = pendingKeys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  const OLD = "const EMAIL = /^[a-z0-9._-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i;";
  const NEW = "const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i;";
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  async function run() {
    const id = ++runId;
    chat.innerHTML = "";
    approve.hidden = true;
    pendingKeys = null;
    approve.classList.remove("is-leaving");
    ["find", "fix", "test"].forEach((s) => setPlan(s, null));
    usage(0, 0);
    setState("idle");
    composer.classList.remove("is-typing", "has-text");
    ctext.textContent = PLACEHOLDER;
    try {
      await wait(500, id);
      const task = "users with a + in their email can't log in. fix it";
      composer.classList.add("is-typing", "has-text");
      for (let i = 1; i <= task.length; i++) {
        ctext.textContent = task.slice(0, i);
        await wait(18 + Math.random() * 30, id);
      }
      await wait(320, id);
      sendBtn.classList.add("is-press");
      await wait(170, id);
      sendBtn.classList.remove("is-press");
      composer.classList.remove("is-typing", "has-text");
      ctext.textContent = PLACEHOLDER;
      const bubble = el("div", "msg-user");
      bubble.textContent = task;
      chat.appendChild(bubble);
      scrollDown();
      setState("busy");
      await wait(450, id);

      const t = turn();
      setPlan("find", "is-doing");
      await speak(t, "I'll find where email addresses get checked.", id);
      const grep = tool(t, "grep", "EMAIL.test &middot; src/");
      await wait(900, id);
      state(grep, "is-ok", "3 matches");
      body(grep, `<pre><span class="hl">src/auth/validate.ts:4</span>   const EMAIL = /^[a-z0-9._-]+@&hellip;/i;
<span class="hl">src/auth/login.ts:18</span>     if (!EMAIL.test(email)) return fail("Invalid email");
<span class="hl">src/auth/signup.ts:22</span>    if (!EMAIL.test(email)) return fail("Invalid email");</pre>`);
      usage(1240, .004);
      await wait(500, id);
      const read = tool(t, "read", "src/auth/validate.ts");
      await wait(700, id);
      state(read, "is-ok", "12 lines");
      body(read, `<pre><span class="ln">2</span>// Shared by login and signup.
<span class="ln">3</span>
<span class="ln">4</span><span class="hl">${esc(OLD)}</span>
<span class="ln">5</span>
<span class="ln">6</span>export const isEmail = (s: string) =&gt; EMAIL.test(s.trim());</pre>`);
      usage(3410, .011);
      setPlan("find", "is-done");

      setPlan("fix", "is-doing");
      await speak(t, "Found it. Line 4 has no <code>+</code> in the allowed characters, so <code>ana+news@mail.com</code> is rejected before the password is even checked. One-line fix:", id, 900);
      const edit = tool(t, "edit", "src/auth/validate.ts");
      state(edit, "is-ask", "waiting for you");
      body(edit, `<span class="del">- ${esc(OLD)}</span><span class="add">+ ${esc(NEW)}</span>`);
      const choice = await askFor("ORBIX wants to edit <code>src/auth/validate.ts</code>", [
        ["1", "Allow once", "once", "allow"],
        ["2", "Allow for this session", "session", ""],
        ["Esc", "Deny", "deny", "deny"]
      ]);
      if (id !== runId) return;

      if (choice === "deny") {
        state(edit, "is-no", "denied");
        edit.appendChild(el("div", "undo-row", "You said no. Nothing was changed."));
        setPlan("fix", "is-skip");
        setPlan("test", "is-skip");
        await speak(t, "Understood, I won't touch it. If you'd rather make the change yourself: add <code>%+</code> inside the first <code>[&hellip;]</code> on line 4 of <code>validate.ts</code>.", id);
        usage(4020, .013);
        return;
      }

      state(edit, "is-ok", "applied");
      edit.classList.add("is-applied");
      const undoRow = el("div", "undo-row", "Changed 1 line.");
      const undo = el("button", "", "Undo this change");
      undo.type = "button";
      undo.addEventListener("click", () => {
        state(edit, "is-no", "undone");
        edit.classList.remove("is-applied");
        $(".add", edit).classList.add("is-undone");
        undoRow.textContent = "Undone. The file is back exactly as it was.";
      });
      undoRow.appendChild(undo);
      edit.appendChild(undoRow);
      setPlan("fix", "is-done");
      usage(4880, .015);

      setPlan("test", "is-doing");
      await speak(t, "Now the auth tests, to make sure nothing else broke.", id);
      const bash = tool(t, "bash", "npm test -- auth");
      if (choice === "once") {
        state(bash, "is-ask", "waiting for you");
        const ok = await askFor("ORBIX wants to run <code>npm test -- auth</code>", [
          ["1", "Allow once", "once", "allow"],
          ["2", "Allow for this session", "session", ""],
          ["Esc", "Deny", "deny", "deny"]
        ]);
        if (id !== runId) return;
        if (ok === "deny") {
          state(bash, "is-no", "denied");
          setPlan("test", "is-skip");
          await speak(t, "Skipped the tests. The fix is in; run <code>npm test -- auth</code> whenever you like.", id);
          return;
        }
        bash.classList.remove("is-ask");
        bash.classList.add("is-run");
        $(".tool-state", bash).innerHTML = '<span class="spin"></span>';
      } else {
        $(".tool-state", bash).innerHTML = '<span class="spin"></span> allowed for this session';
      }
      await wait(1500, id);
      state(bash, "is-ok", "14 passed");
      body(bash, `<pre><span class="pass">PASS</span>  src/auth/validate.test.ts
  <span class="pass">&#10003;</span> accepts plus addressing (3 ms)
  <span class="pass">&#10003;</span> rejects a missing domain (1 ms)
  <span class="pass">&#10003;</span> trims surrounding spaces (1 ms)
Tests: <span class="pass">14 passed</span>, 14 total</pre>`);
      setPlan("test", "is-done");
      usage(6790, .021);
      await speak(t, "Fixed. Addresses like <code>ana+news@mail.com</code> can sign in now, and all 14 auth tests pass. One line changed in <code>validate.ts</code>.", id);
      t.appendChild(el("div", "done-row",
        '<span class="pill ok">&#10003; 1 file changed</span><span class="pill ok">&#10003; 14 tests passed</span><span class="pill">$0.021</span>'));
      scrollDown();
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
    } finally {
      if (id === runId) setState("done");
    }
  }
  $("#replay").addEventListener("click", () => run());
  if ("IntersectionObserver" in window) {
    let started = false;
    new IntersectionObserver((entries) => {
      demoInView = entries[0].isIntersecting;
      if (demoInView && entries[0].intersectionRatio >= .3 && !started) { started = true; run(); }
    }, { threshold: [0, .3] }).observe(win);
  } else { demoInView = true; run(); }

  /* checksum copy button */
  const copyBtn = $("#copy-sha");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      let ok = false;
      try { await navigator.clipboard.writeText($("#sha").textContent.trim()); ok = true; } catch (_) { ok = false; }
      copyBtn.textContent = ok ? "Copied" : "Copy failed";
      copyBtn.classList.toggle("is-done", ok);
      setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.classList.remove("is-done"); }, 1600);
    });
  }

  const boot = () => { root.classList.add("is-ready"); onFrame(); if (!reduced) requestAnimationFrame(loop); else { layoutOrbit(performance.now(), 0); } };
  if (document.fonts && document.fonts.load) {
    Promise.race([document.fonts.load('800 64px "Mona Sans"'), new Promise((r) => setTimeout(r, 900))]).then(boot, boot);
  } else boot();
})();
