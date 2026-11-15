/* ===================================================================
   voice.js — Live voice assistant for JAS Billing
   -------------------------------------------------------------------
   Speak → Gemini Live (WebSocket) → spoken answer, and it can also
   drive the app UI (New Bill, Previous Bills and Reminders)
   through function calls. It only clicks / fills the same controls a
   person would use. It never talks to the database directly.
   The assistant is also sent live details of the tab you are on.

   Loaded lazily by loadAi() in index.html when CONFIG.ai.enabled.
   Reuses existing index.html billing, previous-bill and reminder handlers.

   config.json → "ai": {
     "enabled": true,
     "apiKey": "YOUR_GEMINI_KEY",            <-- required
     "primaryModel": "gemini-3.8-live-extended-thinking",
     "fallbackModel": "gemini-3.8-live",
     "thinkingLevel": "MEDIUM",              (LOW | MEDIUM | HIGH)
     "voiceName": "Puck"                     (optional)
   }
   =================================================================== */
(function () {
  'use strict';
  const VERSION = 'v8-reference-orb';
  if (window.__jasVoiceLoaded) return;
  window.__jasVoiceLoaded = true;
  console.info('[voice] ' + VERSION + ' loaded');

  /* ---------------- config helpers ---------------- */
  const cfg = () => (typeof CONFIG !== 'undefined' && CONFIG) ? CONFIG : {};
  const aiCfg = () => cfg().ai || {};
  const getKey = () => {
    const a = aiCfg(), c = cfg();
    return a.apiKey || a.geminiApiKey || a.key || c.geminiApiKey || c.apiKey || '';
  };
  const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=';
  const LOG = [];
  function dbg(m) {
    const line = new Date().toTimeString().slice(0, 8) + ' ' + m;
    LOG.push(line); if (LOG.length > 200) LOG.shift();
    console.debug('[voice]', m);
    if (typeof ui !== 'undefined' && ui && ui.log) { ui.log.textContent = LOG.slice(-60).join('\n'); ui.log.scrollTop = ui.log.scrollHeight; }
  }
  const toast = (m, t) => { try { showToast(m, t || 'info'); } catch (e) { console.log('[voice]', m); } };

  /* ---------------- runtime state ---------------- */
  let ws = null, activeModel = '', ready = false, thinkingModel = false;
  let micStream = null, inCtx = null, micNode = null, micSink = null, outCtx = null;
  let muted = false, active = false, starting = false;
  let greetingPending = false, greetingTimer = null;
  let nextPlayTime = 0, turnDone = true;
  const sources = new Set();
  let uText = '', aText = '', newUserTurn = true;
  let toolCallCount = 0, switching = false;
  let ui = {};
  let lastActivity = Date.now(), idleMonitor = null, visualFrame = 0;
  let micEnergy = 0, speakerEnergy = 0;
  const IDLE_MS = 60000;
  const activity = () => { lastActivity = Date.now(); };
  function startIdleMonitor(){
    clearInterval(idleMonitor); activity();
    idleMonitor=setInterval(()=>{
      if(!active && !starting) return;
      // Allow the model time to answer; only time out genuinely idle listening.
      if(curStatus()==='listening' && Date.now()-lastActivity>IDLE_MS) stopSession('idle');
    },3000);
  }
  function animateOrb(){
    if(!ui.sheet)return;
    const level=curStatus()==='listening'?micEnergy:curStatus()==='speaking'?speakerEnergy:0;
    ui.sheet.style.setProperty('--jv-level', String(Math.min(1,level*4)));
    micEnergy*=.82;speakerEnergy*=.86;
    visualFrame=requestAnimationFrame(animateOrb);
  }


  /* One compact control row. Only the orb has mode-specific animation. */
  const STATUS_TEXT = {idle:'',connecting:'Connecting...',listening:'Listening...',thinking:'Thinking...',speaking:'Speaking...',muted:'Muted...',ended:'',error:'Error'};
  function buildUi(){
    if(document.querySelector('.jv-wrap'))return;
    const style=document.createElement('style');style.textContent=`
.jv-wrap{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:99;display:flex;align-items:center;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .26s ease,visibility .26s ease,transform .26s cubic-bezier(.2,.8,.2,1);font-family:system-ui,sans-serif}
.jv-wrap.show{opacity:1;visibility:visible;pointer-events:auto}
.jv-wrap:not(.show){transform:translateY(-50%) translateX(16px) scale(.72)}
.jv-orb,.jv-mute,.jv-end{display:grid;place-items:center;flex:none;border-radius:50%;cursor:pointer;-webkit-tap-highlight-color:transparent;color:#fff}
.jv-orb{width:52px;height:52px;position:relative;border:1.5px solid #ffffff48;background:radial-gradient(circle at 32% 28%,#4f7bff,#012587 62%,#001242);box-shadow:0 8px 24px #01258761,inset 0 2px 6px #ffffff59;transition:background .35s,box-shadow .35s,filter .3s}
.jv-orb i{font-size:21px;position:relative;z-index:2;pointer-events:none}
.jv-orb:before,.jv-orb:after{content:'';position:absolute;inset:-4px;border:2px solid #60a5fa;border-radius:50%;opacity:0;pointer-events:none;z-index:-1}
.jv-mute,.jv-end{display:none;width:38px;height:38px;font-size:16px;box-shadow:0 4px 13px #0002}
.jv-mute{border:1px solid var(--line,#cbd5e1);background:var(--surface,#334155);color:var(--text,#fff)}
.jv-mute[aria-pressed="true"]{background:#64748b;color:#fff;border-color:#94a3b8}
.jv-end{border:1px solid #fecaca;background:linear-gradient(145deg,#ef4444,#b91c1c);box-shadow:0 4px 13px #dc26264d}
.jv-wrap.jv-active{left:50%;right:auto;top:auto;bottom:calc(84px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);gap:30px}
.jv-wrap.jv-active:not(.show){transform:translateX(-50%) translateY(12px) scale(.72)}
.jv-wrap.jv-active .jv-orb{width:62px;height:62px}
.jv-wrap.jv-active .jv-mute,.jv-wrap.jv-active .jv-end{display:grid}
.jv-wrap[data-s="connecting"] .jv-orb{background:radial-gradient(circle at 30% 25%,#cffafe,#06b6d4 55%,#155e75);animation:jvBreathe 1.4s ease-in-out infinite}
.jv-wrap[data-s="connecting"] .jv-orb:before{opacity:1;border-color:#22d3ee;border-style:dashed;animation:jvSpin 3s linear infinite}
.jv-wrap[data-s="listening"] .jv-orb{background:radial-gradient(circle at 35% 25%,#a7f3d0,#10b981 48%,#065f46 95%);box-shadow:0 0 24px #10b9818c,inset 0 3px 10px #ffffff80;animation:jvListen 1.8s ease-in-out infinite}
.jv-wrap[data-s="listening"] .jv-orb:before{border-color:#34d399;animation:jvRipple 2s cubic-bezier(.16,1,.3,1) infinite}
.jv-wrap[data-s="listening"] .jv-orb:after{border-color:#34d399;animation:jvRipple 2s cubic-bezier(.16,1,.3,1) .7s infinite}
.jv-wrap[data-s="thinking"] .jv-orb{background:radial-gradient(circle at 35% 25%,#c084fc,#7c3aed 50%,#311068 95%);box-shadow:0 0 26px #8b5cf6a6;animation:jvMorph 1.3s ease-in-out infinite}
.jv-wrap[data-s="thinking"] .jv-orb:before{opacity:.9;border-color:#a855f7;border-top-color:transparent;border-bottom-color:transparent;animation:jvSpin 1.1s linear infinite}
.jv-wrap[data-s="transition"] .jv-orb{background:radial-gradient(circle at 35% 25%,#f5d0fe,#a855f7 48%,#581c87 95%);box-shadow:0 0 26px #a855f7a6;animation:jvMorph .5s ease-in-out both}
.jv-wrap[data-s="transition"] .jv-orb:before{opacity:.95;border-color:#e879f9;border-top-color:transparent;border-bottom-color:transparent;animation:jvSpin .5s linear infinite}
.jv-wrap[data-s="speaking"] .jv-orb{background:radial-gradient(circle at 30% 25%,#93c5fd,#3b82f6 48%,#1e3a8a 95%);box-shadow:0 0 28px #3b82f6a6;animation:jvSpeak .55s ease-in-out infinite alternate}
.jv-wrap[data-s="speaking"] .jv-orb:before{border-color:#3b82f680;animation:jvRipple 1.2s ease-out infinite}
.jv-wrap[data-s="speaking"] .jv-orb:after{border-color:#3b82f659;animation:jvRipple 1.2s ease-out .4s infinite}
.jv-wrap[data-s="muted"] .jv-orb{background:radial-gradient(circle at 30% 25%,#d1d5db,#64748b 60%,#334155);box-shadow:0 4px 13px #0003;animation:none}
.jv-wrap[data-s="error"] .jv-orb{background:radial-gradient(circle at 30% 25%,#fca5a5,#ef4444 55%,#7f1d1d)}
@keyframes jvBreathe{0%,100%{transform:scale(.92);opacity:.85}50%{transform:scale(1.04);opacity:1}}
@keyframes jvListen{0%,100%{transform:scale(1)}50%{transform:scale(calc(1.06 + var(--jv-level,0)*.07))}}
@keyframes jvMorph{0%,100%{transform:scale(.95) rotate(0);border-radius:50%}33%{transform:scale(1.06) rotate(120deg);border-radius:44% 56% 48% 52%}66%{transform:scale(.98) rotate(240deg);border-radius:54% 46% 55% 45%}}
@keyframes jvSpeak{from{transform:scale(.96)}to{transform:scale(calc(1.1 + var(--jv-level,0)*.06))}}
@keyframes jvRipple{0%{transform:scale(.85);opacity:.75}100%{transform:scale(1.55);opacity:0}}
@keyframes jvSpin{to{transform:rotate(360deg)}}
@media(max-width:640px){.jv-wrap:not(.jv-active) .jv-orb{width:44px;height:44px}.jv-wrap:not(.jv-active) .jv-orb i{font-size:18px}}
@media(min-width:641px){.jv-wrap.jv-active{bottom:92px}}
@media(prefers-reduced-motion:reduce){.jv-orb,.jv-orb:before,.jv-orb:after{animation:none!important}}
`;
    document.head.appendChild(style);
    const wrap=document.createElement('div');wrap.className='jv-wrap';wrap.dataset.s='idle';
    wrap.innerHTML='<button type="button" class="jv-mute" aria-label="Mute microphone" aria-pressed="false" title="Mute microphone"><i class="fa-solid fa-microphone" aria-hidden="true"></i></button><button type="button" class="jv-orb" aria-label="Start voice assistant"><i class="fa-solid fa-robot" aria-hidden="true"></i></button><button type="button" class="jv-end" aria-label="End voice conversation" title="End conversation"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>';
    document.body.appendChild(wrap);
    ui={sheet:wrap,fab:wrap,orb:wrap.querySelector('.jv-orb'),orbIcon:wrap.querySelector('.jv-orb i'),status:{textContent:''},mute:wrap.querySelector('.jv-mute'),end:wrap.querySelector('.jv-end'),model:{textContent:''},act:null,log:null};
    ui.orb.addEventListener('click',()=>{if(!active&&!starting)openSheet();});
    ui.mute.addEventListener('click',toggleMute);
    ui.end.addEventListener('click',()=>stopSession('idle'));
    window.addEventListener('pagehide',()=>stopSession('idle'));
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&(active||starting))stopSession('idle');});
    animateOrb();
    const app=document.getElementById('appScreen');
    const nav=document.querySelector('.nav-tabs')||document.getElementById('navAdminTab')?.parentElement;
    const sync=()=>{
      const visible=(!app||!app.classList.contains('hide'))&&currentTab()!=='admin';
      wrap.classList.toggle('show',visible);
      if(!visible&&(active||starting))stopSession('idle');
    };
    sync();
    if(app)new MutationObserver(sync).observe(app,{attributes:true,attributeFilter:['class']});
    if(nav)new MutationObserver(sync).observe(nav,{subtree:true,attributes:true,attributeFilter:['class']});
    document.addEventListener('click',e=>{if(e.target.closest('.nav-tab'))queueMicrotask(sync);},true);
    setStatus('idle');
  }
  let lastUnmutedStatus='listening';
  function toggleMute(){
    if(!active&&!starting)return;
    muted=!muted;
    if(muted){lastUnmutedStatus=curStatus();setStatus('muted');}
    else{activity();setStatus(lastUnmutedStatus==='speaking'&&sources.size?'speaking':'listening');}
  }
  let transitionTimer=null;
  let settledVoiceState='idle';
  let pendingVoiceState=null;
  function setStatus(s){
    if(!ui.sheet)return;
    if(muted && s!=='idle'&&s!=='ended'&&s!=='error')s='muted';
    // Purple is a brief 500ms bridge, never the persistent listening state.
    if(s==='listening'||s==='speaking'){
      if(pendingVoiceState===s)return; // Repeated PCM packets must not restart the bridge.
      if(pendingVoiceState!==null){
        pendingVoiceState=s;
        if(s===settledVoiceState){clearTimeout(transitionTimer);transitionTimer=null;pendingVoiceState=null;}
        else return;
      }else if((settledVoiceState==='listening'&&s==='speaking')||
               (settledVoiceState==='speaking'&&s==='listening')){
        pendingVoiceState=s;
        ui.sheet.dataset.s='transition';
        transitionTimer=setTimeout(()=>{
          transitionTimer=null;
          const target=pendingVoiceState;pendingVoiceState=null;
          if(!target||!ui.sheet)return;
          settledVoiceState=target;
          ui.sheet.dataset.s=target;
        },500);
      }
      if(pendingVoiceState===null){settledVoiceState=s;ui.sheet.dataset.s=s;}
    }else{
      clearTimeout(transitionTimer);transitionTimer=null;pendingVoiceState=null;
      settledVoiceState=s;
      ui.sheet.dataset.s=s;
    }
    ui.status.textContent=STATUS_TEXT[s]||s;
    ui.sheet.classList.toggle('jv-active',!!(active||starting));
    ui.orbIcon.className='fa-solid fa-robot';
    ui.mute.querySelector('i').className='fa-solid '+(muted?'fa-microphone-slash':'fa-microphone');
    ui.mute.setAttribute('aria-pressed',String(muted));
    ui.mute.setAttribute('aria-label',muted?'Unmute microphone':'Mute microphone');
    ui.mute.title=muted?'Unmute microphone':'Mute microphone';
    ui.orb.setAttribute('aria-label',active||starting?'Voice assistant animation':'Start voice conversation');
    ui.orb.title=active||starting?'Voice assistant':'Start voice assistant';
  }
  const curStatus=()=>ui.sheet.dataset.s;
  function renderText(){}
  function openSheet(){if(currentTab()==='admin')return;if(!active&&!starting)startSession();}
  function closeSheet(){farewellAndClose();}

  let farewellInProgress=false, farewellTimer=null, farewellTurnComplete=false;
  function finishFarewell(){
    if(!farewellInProgress||!farewellTurnComplete||sources.size)return;
    stopSession('idle');
  }
  function farewellAndClose(){
    if(farewellInProgress)return;
    if(!active||!ready||!ws){stopSession('idle');return;}
    farewellInProgress=true;farewellTurnComplete=false;
    greetingPending=false;clearTimeout(greetingTimer);greetingTimer=null;
    // The model speaks the goodbye; no browser text-to-speech.
    // A timeout ensures the session cannot remain open if Gemini fails.
    clearTimeout(farewellTimer);
    farewellTimer=setTimeout(()=>stopSession('idle'),10000);
    turnDone=false;
    setStatus('thinking');
  }

  /* ===================================================================
     Audio helpers
     =================================================================== */
  const b64FromBuffer = (buf) => {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };

  function downsampleTo16k(f32, inRate) {
    if (inRate === 16000) return f32;
    const ratio = inRate / 16000;
    const n = Math.floor(f32.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, f32.length - 1);
      const frac = pos - i0;
      out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
    }
    return out;
  }

  function onMicChunk(f32) {
    if (!ws || ws.readyState !== 1 || !ready || muted || greetingPending) return;
    // Treat actual speech-level input as activity; background noise should not keep the session open.
    let sum=0;for(let i=0;i<f32.length;i+=8)sum+=f32[i]*f32[i];
    const rms=Math.sqrt(sum/Math.ceil(f32.length/8));
    micEnergy=Math.max(micEnergy,rms);
    if(rms>.025)activity();
    const down = downsampleTo16k(f32, inCtx.sampleRate);
    const pcm = new Int16Array(down.length);
    for (let i = 0; i < down.length; i++) {
      const v = Math.max(-1, Math.min(1, down[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBuffer(pcm.buffer), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  async function startMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    inCtx = new AC();
    if (inCtx.state === 'suspended') await inCtx.resume();
    const src = inCtx.createMediaStreamSource(micStream);
    micSink = inCtx.createGain();
    micSink.gain.value = 0; // keeps the graph running without echoing the mic
    micSink.connect(inCtx.destination);

    let usedWorklet = false;
    if (inCtx.audioWorklet && window.AudioWorkletNode) {
      try {
        const code = `class Cap extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}
process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];
if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0}}return true}}registerProcessor('jv-cap',Cap);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await inCtx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        micNode = new AudioWorkletNode(inCtx, 'jv-cap');
        micNode.port.onmessage = (e) => onMicChunk(e.data);
        usedWorklet = true;
      } catch (err) {
        console.warn('[voice] AudioWorklet unavailable, using fallback', err);
      }
    }
    if (!usedWorklet) {
      micNode = inCtx.createScriptProcessor(4096, 1, 1);
      micNode.onaudioprocess = (e) => onMicChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    src.connect(micNode);
    micNode.connect(micSink);
  }

  function playPcm(b64) {
    if (!outCtx) return;
    const bin = atob(b64);
    const n = bin.length >> 1;
    if (!n) return;
    const buf = outCtx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 32768; speakerEnergy=Math.max(speakerEnergy,Math.abs(ch[i]));
    }
    const s = outCtx.createBufferSource();
    s.buffer = buf;
    s.connect(outCtx.destination);
    const t = Math.max(outCtx.currentTime + 0.03, nextPlayTime);
    s.start(t);
    nextPlayTime = t + buf.duration;
    sources.add(s);
    s.onended = () => { sources.delete(s); if(farewellInProgress)finishFarewell();else maybeIdle(); };
  }

  function stopPlayback() {
    sources.forEach((s) => { try { s.onended = null; s.stop(); } catch (e) { /* already stopped */ } });
    sources.clear();
    nextPlayTime = 0;
  }

  // Back to "listening" only when the model is done AND the audio queue is empty.
  function maybeIdle() {
    if(farewellInProgress){finishFarewell();return;}
    if (active && turnDone && sources.size === 0) {
      if (greetingPending) { greetingPending = false; clearTimeout(greetingTimer); greetingTimer = null; }
      setStatus('listening');
    }
  }

  /* ===================================================================
     App helpers
     =================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };
  const autosave = () => { try { if (typeof currentSession !== 'undefined' && currentSession) saveBillStateToLocalStorage(); } catch (e) { /* ignore */ } };
  const refresh = () => { renderProducts(); updateSummary(); autosave(); };
  const viewingSaved = () => { try { return typeof isViewingPreviousBill === 'function' && isViewingPreviousBill(); } catch (e) { return false; } };
  const draftIsEmpty = () => !(state.products.length || state.customer.name || state.customer.mobile || state.customer.address);
  const currentTab = () => { const t = document.querySelector('.nav-tab.active'); return t ? t.dataset.view : 'newBill'; };

  async function waitFor(fn, ms) {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) { try { if (fn()) return true; } catch (e) { /* ignore */ } await sleep(120); }
    return false;
  }
  const billsLoaded = () => { const l = $('billsLoading'); return !l || l.classList.contains('hide'); };

  function totals() {
    try {
      const t = calculateTotals(state.products, getActiveServiceCharge());
      return { total_items: t.totalItems, total_quantity: t.totalQty, service_charge: t.serviceCharge, grand_total: t.grandTotal };
    } catch (e) { return {}; }
  }
  function productRow(p, i) {
    let amount = 0;
    try { amount = InvoiceEngine.lineAmount(p); } catch (e) { amount = (num(p.qty) || 0) * (num(p.rate) || 0); }
    return { item_number: i + 1, name: p.name, qty: p.qty, rate: p.rate, amount, description: p.description || '', serial: p.serial || '' };
  }
  const openDialogs = () => [...document.querySelectorAll('.modal-overlay:not(.hide)')].map((o) => o.id.replace(/Overlay$/, ''));

  /* ---------- details of the tab the user is on (sent to the AI) ---------- */
  function tabContext() {
    if (typeof state === 'undefined') return { screen: 'loading' };
    const tab = currentTab();
    const ctx = { current_tab: tab === 'admin' ? 'restricted' : tab, open_dialogs: tab === 'admin' ? [] : openDialogs().filter(x=>!/admin|userInfo/i.test(x)) };
    try {
      if (tab === 'newBill') {
        ctx.tab_name = 'New Bill';
        ctx.showing_saved_bill_readonly = viewingSaved();
        ctx.customer = { name: state.customer.name, address: state.customer.address, mobile: state.customer.mobile };
        ctx.items = state.products.map(productRow);
        ctx.service_charge = { enabled_in_app: cfg().display?.showServiceCharge === true, on: !!(typeof getActiveServiceCharge === 'function' && getActiveServiceCharge() !== null), amount: getActiveServiceCharge() };
        ctx.notes = state.notes || '';
        ctx.pdf_options = { watermark: !!state.showWatermark, qr: !!state.showQr, signature: !!state.showSignature, notes: !!state.includeNotesOnPdf };
        ctx.totals = totals();
        ctx.invoice_date = state.dateStr || '';
        ctx.qr_dialog_open = openDialogs().includes('invoiceQrModal');
      } else if (tab === 'previousBills') {
        ctx.tab_name = 'Previous Bills';
        const page = billsPage, size = BILLS_PAGE_SIZE, total = billsTotalCount;
        ctx.search_text = (el.billSearchInput && el.billSearchInput.value) || '';
        ctx.sort = el.sortFilterLabel ? el.sortFilterLabel.textContent : '';
        ctx.date_filter = el.dateFilterLabel ? el.dateFilterLabel.textContent : '';
        ctx.showing_deleted_bills = typeof isRestoreBillsMode !== 'undefined' ? !!isRestoreBillsMode : false;
        ctx.loading = !billsLoaded();
        ctx.page = page; ctx.total_pages = Math.max(1, Math.ceil(total / size)); ctx.total_bills = total;
        ctx.bills_on_this_page = (billsCache || []).map((b, i) => ({
          position: i + 1, invoice_no: b.invoice_no, customer: b.customer_name || 'Walk-in customer',
          phone: b.customer_phone || '', date: b.bill_date || '', total: b.total
        }));
      } else if (tab === 'reminders') {
        ctx.tab_name = 'Reminders';
        ctx.loading = !remindersLoaded;
        ctx.reminders = (reminders || []).map((r, i) => ({ position:i+1, title:r.title, description:r.description||'', date:r.remember_date, status:r.status, repeat:r.repeater||'none' }));
        ctx.reminder_limit=typeof REMINDER_LIMIT!=='undefined'?REMINDER_LIMIT:10;
        ctx.reminder_count=(reminders||[]).length;
        ctx.reminder_slots_left=Math.max(0,ctx.reminder_limit-ctx.reminder_count);
        ctx.reminder_counts={active:(reminders||[]).filter(r=>r.status==='active').length,paused:(reminders||[]).filter(r=>r.status==='paused').length,completed:(reminders||[]).filter(r=>r.status==='completed').length};
      } else {
        ctx.tab_name = 'Admin';
        ctx.note = 'Admin panel. The assistant has NO access here and must not act on it.';
      }
      // Do not expose unrelated or administrative state.
    } catch (e) { console.warn('[voice] context error', e); }
    return ctx;
  }

  let lastCtx = '';
  // The screen snapshot goes in the system prompt at session start, and every tool result carries the latest screen.
  function pushContext() { lastCtx = ''; }
  let watchersOn = false;
  function watchApp() {
    if (watchersOn) return;
    watchersOn = true;
    const trigger = () => pushContext(false);
    const nav = document.querySelector('.nav-tabs');
    if (nav) new MutationObserver(trigger).observe(nav, { attributes: true, subtree: true, attributeFilter: ['class'] });
    const list = $('billsTableBody');
    if (list) new MutationObserver(trigger).observe(list, { childList: true });
    const pag = $('billsPaginationInfo');
    if (pag) new MutationObserver(trigger).observe(pag, { childList: true, characterData: true, subtree: true });
    document.querySelectorAll('.modal-overlay').forEach((o) => new MutationObserver(trigger).observe(o, { attributes: true, attributeFilter: ['class'] }));
    const rem = $('remGroups');
    if (rem) new MutationObserver(trigger).observe(rem, { childList: true });
  }

  /* ===================================================================
     Tools (UI control only: each one clicks or fills what a person would)
     =================================================================== */
  function guardEdit() {
    if (typeof state === 'undefined') return 'The billing screen is not ready yet.';
    if (currentTab() === 'admin') return 'The assistant has no access to the Admin panel.';
    if (viewingSaved()) return 'A saved bill is open in read-only mode. Say "new bill" or "copy to new bill" to edit.';
    if (openDialogs().includes('previewModal')) { const close=$('btnClosePreviewModal'); if(close) close.click(); }
    try { if (currentTab() !== 'newBill') switchView('newBill'); } catch (e) { /* ignore */ }
    return '';
  }
  function findProduct(a) {
    const list = state.products || [];
    if (a.item_number != null && list[num(a.item_number) - 1]) return list[num(a.item_number) - 1];
    const q = String(a.name_match || a.name || '').trim().toLowerCase();
    if (q) return list.find((p) => (p.name || '').toLowerCase() === q) || list.find((p) => (p.name || '').toLowerCase().includes(q));
    return null;
  }
  function findBill(a) {
    const list = billsCache || [];
    if (a.invoice_no) { const q = String(a.invoice_no).replace(/\D/g, ''); const hit = list.find((b) => String(b.invoice_no).replace(/\D/g, '').endsWith(q) && q); if (hit) return hit; }
    if (a.position != null && list[num(a.position) - 1]) return list[num(a.position) - 1];
    const c = String(a.customer || '').trim().toLowerCase();
    if (c) return list.find((b) => (b.customer_name || '').toLowerCase().includes(c));
    return null;
  }
  async function ensureBillsTab() {
    if (currentTab() !== 'previousBills') { switchView('previousBills'); await sleep(400); }
    await waitFor(billsLoaded, 6000);
  }
  const needConfirm = (msg) => ({ ok: false, needs_confirmation: true, message: msg });

  function resolveReminder(a){
    const list=typeof reminders!=='undefined'?reminders:[];
    if(a.position!=null)return list[Number(a.position)-1]||null;
    const q=String(a.match_title||'').trim().toLowerCase();
    if(!q)return null;
    return list.find(r=>r.title.toLowerCase()===q)||list.find(r=>r.title.toLowerCase().includes(q))||null;
  }
  const TOOLS = {
    get_app_state() { return { ok: true, screen: tabContext() }; },

    go_to_tab(a) {
      const map = { new_bill: 'newBill', previous_bills: 'previousBills', reminders: 'reminders' };
      const v = map[a.tab];
      if (!v) return { ok: false, error: 'You can only open New Bill, Previous Bills or Reminders.' };
      switchView(v);
      return { ok: true };
    },

    /* ---------- New Bill ---------- */
    async start_new_bill(a) {
      if (currentTab() === 'admin') switchView('newBill');
      if (viewingSaved()) {
        const close = $('btnClosePreviewModal');
        if (close) close.click();
        await sleep(400);
      }
      if (!draftIsEmpty() && !a.confirmed) {
        return needConfirm('The current bill has data that will be cleared. Ask the user to confirm, then call again with confirmed true.');
      }
      if (viewingSaved() || !draftIsEmpty()) resetInvoice(false);
      switchView('newBill');
      return { ok: true, note: 'Fresh New Bill is ready.', screen: tabContext() };
    },
    set_invoice_date(a){
      const bad=guardEdit();if(bad)return {ok:false,error:bad};
      if(!isValidIsoDateStr(a.date))return {ok:false,error:'Please give the date as YYYY-MM-DD.'};
      applyRestoredInvoiceDate(a.date);
      el.invoiceDate.dispatchEvent(new Event('change',{bubbles:true}));autosave();
      return {ok:true,invoice_date:el.invoiceDate.value};
    },
    set_customer(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const c = state.customer;
      if (a.name != null) c.name = String(a.name).trim().slice(0, 60);
      if (a.address != null) c.address = String(a.address).trim().slice(0, 150);
      if (a.mobile != null) c.mobile = String(a.mobile).replace(/\D/g, '').slice(-10);
      syncCustomerFieldsFromState();
      autosave();
      return { ok: true, customer: { name: c.name, address: c.address, mobile: c.mobile } };
    },
    add_product(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const name = String(a.name || '').trim();
      const rate = num(a.rate);
      if (!name) return { ok: false, error: 'Product name is missing. Ask the user.' };
      if (!Number.isFinite(rate) || rate < 0) return { ok: false, error: 'Rate is missing. Ask the user for the rate.' };
      const p = {
        id: state.nextId++, name: name.slice(0, 100),
        description: String(a.description || '').trim().slice(0, 500),
        serial: String(a.serial || '').trim().slice(0, 50),
        qty: String(a.quantity ?? '1').trim().slice(0, 30) || '1', rate
      };
      state.products.push(p);
      refresh();
      return { ok: true, added: productRow(p, state.products.length - 1), totals: totals() };
    },
    update_product(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const p = findProduct(a);
      if (!p) return { ok: false, error: 'No matching item. Check item numbers in the screen details.' };
      if (a.new_name != null) p.name = String(a.new_name).trim().slice(0, 100) || p.name;
      if (a.quantity != null) p.qty = String(a.quantity).trim().slice(0, 30);
      if (a.rate != null) { const r = num(a.rate); if (Number.isFinite(r) && r >= 0) p.rate = r; }
      if (a.description != null) p.description = String(a.description).trim().slice(0, 500);
      if (a.serial != null) p.serial = String(a.serial).trim().slice(0, 50);
      refresh();
      return { ok: true, updated: productRow(p, state.products.indexOf(p)), totals: totals() };
    },
    remove_product(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const p = findProduct(a);
      if (!p) return { ok: false, error: 'No matching item.' };
      state.products = state.products.filter((x) => x !== p);
      refresh();
      return { ok: true, removed: p.name, totals: totals() };
    },
    set_service_charge(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      if (cfg().display?.showServiceCharge !== true) return { ok: false, error: 'Service charge is turned off in this app.' };
      const cb = $('toggleServiceCharge'), inp = $('serviceChargeInput');
      if (!cb || !inp) return { ok: false, error: 'Service charge controls not found.' };
      if (a.enabled === false) { if (cb.checked) cb.click(); }
      else {
        if (!cb.checked) cb.click();
        if (a.amount != null) {
          const amt = num(a.amount);
          if (!Number.isFinite(amt) || amt < 0) return { ok: false, error: 'Invalid amount.' };
          inp.value = String(amt);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      autosave();
      return { ok: true, totals: totals() };
    },
    set_notes(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const t = String(a.notes ?? '').slice(0, 800);
      state.notes = t;
      if (el.invoiceNotes) { el.invoiceNotes.value = t; el.invoiceNotes.dispatchEvent(new Event('input', { bubbles: true })); }
      autosave();
      return { ok: true };
    },
    set_pdf_options(a) {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      const map = { watermark: 'toggleWatermark', qr: 'toggleQrVisibility', signature: 'toggleSignatureVisibility', notes: 'toggleNotesVisibility' };
      const skipped = [];
      Object.keys(map).forEach((k) => {
        if (typeof a[k] !== 'boolean') return;
        const cb = $(map[k]);
        if (!cb || cb.disabled) { skipped.push(k); return; }
        if (cb.checked !== a[k]) cb.click();
      });
      autosave();
      return { ok: true, not_available: skipped, pdf_options: tabContext().pdf_options };
    },
    preview_invoice() {
      const bad = guardEdit(); if (bad) return { ok: false, error: bad };
      if (!state.products.length) return { ok: false, error: 'No items yet. Add at least one item first.' };
      openPreviewModal();
      return { ok: true };
    },
    async close_preview() {
      const b = $('btnClosePreviewModal');
      if (b) b.click();
      await sleep(300);
      return { ok: true };
    },
    // Opens the same Generate flow as the buttons. save=true/false answers the "save this bill?" question.
    async generate_pdf(a) {
      if (currentTab() === 'admin') return { ok: false, error: 'No access to the Admin panel.' };
      if (viewingSaved()) {
        const b = $('btnDownloadFromPreview');
        if (!b) return { ok: false, error: 'Open the saved bill preview first.' };
        b.click();
        await sleep(900);
        return { ok: true, screen: tabContext() };
      }
      if (currentTab() !== 'newBill') switchView('newBill');
      if (!state.customer.name || !state.products.length) return { ok: false, error: 'Customer name and at least one item are required first.' };
      if (el.btnDownload) el.btnDownload.click();
      await sleep(500);
      if (!openDialogs().includes('saveChoiceModal')) return { ok: false, error: 'The generate screen did not open. Check the on-screen message.', screen: tabContext() };
      if (typeof a.save === 'boolean') {
        (a.save ? el.btnSaveChoiceYes : el.btnSaveChoiceNo).click();
        await waitFor(() => openDialogs().includes('pdfActionModal'), 15000);
        return { ok: true, saved_to_records: a.save, note: 'PDF is ready. Ask whether to download it.', screen: tabContext() };
      }
      return { ok: true, note: 'The save question is on screen. Ask the user: save this bill to records, yes or no? Then call generate_pdf again with save true or false.' };
    },
    async pdf_action(a) {
      if(a.action==='close_qr'||a.action==='qr_done'){
        if(!openDialogs().includes('invoiceQrModal'))return {ok:false,error:'QR dialog is not open.'};
        const b=$(a.action==='qr_done'?'btnInvoiceQrDone':'btnInvoiceQrClose');
        if(!b)return {ok:false,error:'QR close button unavailable.'};
        b.click();await sleep(200);
        return {ok:!openDialogs().includes('invoiceQrModal'),screen:tabContext()};
      }
      const map = { download: 'btnPdfDownload', qr: 'btnPdfQr', close: 'btnPdfActionCancel' };
      if (a.action === 'share') return { ok: false, error: 'Sharing needs a real tap. Ask the user to tap Share PDF.' };
      const b = $(map[a.action]);
      if (!b || !openDialogs().includes('pdfActionModal')) return { ok: false, error: 'The PDF options screen is not open.' };
      b.click();
      await sleep(400);
      return { ok: true };
    },

    /* ---------- Previous Bills ---------- */
    async bills_search(a) {
      if (currentTab() === 'admin' || !el.billSearchInput) return { ok: false, error: 'Not available here.' };
      await ensureBillsTab();
      el.billSearchInput.value = String(a.query || '').slice(0, 80);
      el.billSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(900);
      await waitFor(billsLoaded, 8000);
      return { ok: true, screen: tabContext() };
    },
    async bills_sort(a) {
      const map = {
        newest: ['created_at', 'desc'], oldest: ['created_at', 'asc'],
        amount_high: ['total', 'desc'], amount_low: ['total', 'asc'],
        name_az: ['customer_name', 'asc'], name_za: ['customer_name', 'desc']
      };
      const m = map[a.sort];
      if (!m) return { ok: false, error: 'Unknown sort.' };
      await ensureBillsTab();
      if (el.billsFilterRow) el.billsFilterRow.classList.remove('hide');
      const item = el.sortDropdown.querySelector('[data-sort="' + m[0] + '"][data-dir="' + m[1] + '"]');
      if (!item) return { ok: false, error: 'Sort option not found.' };
      item.click();
      await sleep(500);
      await waitFor(billsLoaded, 8000);
      return { ok: true, screen: tabContext() };
    },
    async bills_date_filter(a) {
      const ok = ['any', 'today', 'yesterday', '7days', 'month', 'lastmonth'];
      if (!ok.includes(a.range)) return { ok: false, error: 'Unknown date range.' };
      await ensureBillsTab();
      if (el.billsFilterRow) el.billsFilterRow.classList.remove('hide');
      const item = el.dateDropdown.querySelector('[data-range="' + a.range + '"]');
      if (!item) return { ok: false, error: 'Date option not found.' };
      item.click();
      await sleep(500);
      await waitFor(billsLoaded, 8000);
      return { ok: true, screen: tabContext() };
    },
    async bills_clear_filters() {
      await ensureBillsTab();
      const t = el.btnBillsFilterToggle;
      if (t && t.classList.contains('is-clear')) t.click();
      await sleep(500);
      await waitFor(billsLoaded, 8000);
      return { ok: true, screen: tabContext() };
    },
    async bills_page(a) {
      await ensureBillsTab();
      const dir = a.direction === 'previous' ? 'prev' : 'next';
      const b = el.billsPaginationControls.querySelector('button[data-page="' + dir + '"]');
      if (!b || b.disabled) return { ok: false, error: dir === 'next' ? 'Already on the last page.' : 'Already on the first page.' };
      b.click();
      await sleep(500);
      await waitFor(billsLoaded, 8000);
      return { ok: true, screen: tabContext() };
    },
    async copy_bill_to_new(a) {
      await ensureBillsTab();
      const bill = findBill(a);
      if (!bill) return { ok: false, error: 'Could not find that bill on this page. Check the list in the screen details.' };
      if (!draftIsEmpty() && !a.confirmed) return needConfirm('Copying will replace the unfinished bill on the New Bill tab. Ask the user to confirm, then call again with confirmed true.');
      await copyBillToNew(bill.invoice_no);
      await sleep(300);
      return { ok: true, copied: bill.invoice_no, screen: tabContext() };
    },
    async reprint_bill(a) {
      await ensureBillsTab();
      const bill = findBill(a);
      if (!bill) return { ok: false, error: 'Could not find that bill on this page.' };
      await reprintBill(bill.invoice_no);
      await sleep(500);
      return { ok: true, opened: bill.invoice_no, note: 'Preview of the saved bill is open. To generate the PDF again call generate_pdf.', screen: tabContext() };
    },

    /* ---------- Reminders: use the app's existing handlers ---------- */
    async reminder_prepare(){
      if(currentTab()!=='reminders')switchView('reminders');
      await waitFor(()=>remindersLoaded,8000);
      const count=reminders.length;
      if(count>=REMINDER_LIMIT)return {ok:false,error:'Maximum '+REMINDER_LIMIT+' reminders reached. Delete an existing reminder before creating another.',screen:tabContext()};
      openReminderModal(null);
      return {ok:openDialogs().includes('reminderModal'),slots_left:REMINDER_LIMIT-count,screen:tabContext()};
    },
    async reminder_list(){
      if(currentTab()!=='reminders')switchView('reminders');
      await waitFor(()=>remindersLoaded,8000);
      return {ok:true,screen:tabContext()};
    },
    async reminder_save(a){
      if(currentTab()!=='reminders')switchView('reminders');
      await waitFor(()=>remindersLoaded,8000);
      const existing=resolveReminder(a);
      if(a.match_title||a.position){if(!existing)return {ok:false,error:'Could not find that reminder.'};}
      const title=a.title!=null?String(a.title).trim():(existing?existing.title:'');
      const date=a.date!=null?String(a.date):existing?.remember_date;
      if(!title||!date)return {ok:false,error:'A title and date are required. Ask the user for missing information.'};
      if(!isValidIsoDateStr(date))return {ok:false,error:'Use a valid YYYY-MM-DD date.'};
      const repeat=a.repeat==null?(existing?.repeater||'off'):String(a.repeat).toLowerCase();
      if(!['off','daily','weekly','monthly','yearly'].includes(repeat)&&!(/^\d+$/.test(repeat)&&+repeat>=1&&+repeat<=365))return {ok:false,error:'Invalid repeat setting.'};
      if(!existing&&reminders.length>=REMINDER_LIMIT)return {ok:false,error:'Maximum reminder limit reached.'};
      if(!a.confirmed)return needConfirm('Confirm '+(existing?'updating':'creating')+' reminder '+title+' for '+date+' with repeat '+repeat+'.');
      openReminderModal(existing||null);
      el.remTitle.value=title;
      el.remDesc.value=a.description!=null?String(a.description).slice(0,500):(existing?.description||'');
      reminderDatePicker.setValue(date,false);
      if(/^\d+$/.test(repeat)){setReminderRepeat('custom');el.remCustomDays.value=repeat;}
      else setReminderRepeat(repeat==='off'?'':repeat);
      const before=existing?JSON.stringify(existing):reminders.length;
      await saveReminder();
      const after=existing?reminders.find(r=>r.id===existing.id):null;
      const success=existing?JSON.stringify(after)!==before:reminders.length>before;
      return success?{ok:true,screen:tabContext()}:{ok:false,error:'Reminder was not saved. Check the app validation message.',screen:tabContext()};
    },
    set_theme(a){
      const mode=String(a.mode||'').toLowerCase();
      if(!['light','dark','system'].includes(mode))return {ok:false,error:'Choose light, dark or system.'};
      switchTheme(mode);return {ok:true,theme:getThemeMode()};
    },
    end_conversation(){farewellAndClose();return {ok:true,message:'Now say exactly: Have a great day. Goodbye! Speak this farewell aloud in your Gemini voice, then end your turn. Do not call any more tools.'};},
    async reminder_action(a){
      if(currentTab()!=='reminders')switchView('reminders');
      await waitFor(()=>remindersLoaded,8000);
      const r=resolveReminder(a);if(!r)return {ok:false,error:'Reminder not found.'};
      const action=String(a.action||'').toLowerCase();
      if(!['pause','resume','complete','done','delete'].includes(action))return {ok:false,error:'Unknown reminder action.'};
      if(['done','delete'].includes(action)&&!a.confirmed)return needConfirm('Confirm '+action+' for reminder '+r.title+'.');
      if(action==='done'){
        openReminderDone(r);await confirmDoneReminder();
        return reminders.find(x=>x.id===r.id)?.status==='completed'?{ok:true,screen:tabContext()}:{ok:false,error:'Could not mark reminder as done.'};
      }
      if(action==='delete'){
        openReminderDelete(r);await confirmDeleteReminder();
        return reminders.some(x=>x.id===r.id)?{ok:false,error:'Reminder was not deleted.'}:{ok:true,screen:tabContext()};
      }
      const before=JSON.stringify(r);await runReminderAction(action,r.id,null);
      return JSON.stringify(reminders.find(x=>x.id===r.id))!==before?{ok:true,screen:tabContext()}:{ok:false,error:'Action was not completed; check whether it is allowed.'};
    }

  };

  const S = (d) => ({ type: 'STRING', description: d });
  const N = (d) => ({ type: 'NUMBER', description: d });
  const B = (d) => ({ type: 'BOOLEAN', description: d });
  const O = (props, req) => ({ type: 'OBJECT', properties: props || {}, ...(req ? { required: req } : {}) });
  const BILL_REF = { invoice_no: S('Invoice number or its last digits'), position: N('1-based position on the current page'), customer: S('Part of the customer name') };

  function declarations(nonBlocking) {
    const d = [
      { name: 'get_app_state', description: 'Read the current tab and everything visible on it. Use when unsure what is on screen.', parameters: O() },
      { name: 'go_to_tab', description: 'Open a tab.', parameters: O({ tab: { type: 'STRING', enum: ['new_bill', 'previous_bills', 'reminders'] } }, ['tab']) },
      { name: 'start_new_bill', description: 'Start a fresh blank New Bill. If the current bill has data, ask the user first and pass confirmed true.', parameters: O({ confirmed: B('User agreed to clear the current bill') }) },
      { name: 'set_invoice_date', description: 'Set the date on the New Bill using YYYY-MM-DD.', parameters: O({date:S('YYYY-MM-DD date')},['date']) },
      { name: 'set_customer', description: 'Set the customer name, address and/or mobile on the New Bill. Only pass what the user said.', parameters: O({ name: S('Customer name'), address: S('Address'), mobile: S('10 digit mobile number') }) },
      { name: 'add_product', description: 'Add one item to the New Bill. Rate is required: ask if missing. You may write a short professional description if the user asks you to suggest or generate one.', parameters: O({ name: S('Product or service name'), quantity: S('Quantity as spoken, e.g. "2" or "5 liters". Default "1"'), rate: N('Price per unit in rupees'), description: S('Optional description'), serial: S('Optional serial number') }, ['name', 'rate']) },
      { name: 'update_product', description: 'Change an item. Identify it by item_number (1-based) or name_match. Also use it to add or change a description.', parameters: O({ item_number: N('1-based position'), name_match: S('Part of the item name'), new_name: S('New name'), quantity: S('New quantity'), rate: N('New rate'), description: S('New description'), serial: S('New serial') }) },
      { name: 'remove_product', description: 'Remove an item by item_number (1-based) or name_match.', parameters: O({ item_number: N('1-based position'), name_match: S('Part of the item name') }) },
      { name: 'set_service_charge', description: 'Turn service charge on (with amount) or off.', parameters: O({ enabled: B('false to turn off'), amount: N('Amount in rupees') }) },
      { name: 'set_notes', description: 'Replace the invoice notes text.', parameters: O({ notes: S('Notes text') }, ['notes']) },
      { name: 'set_pdf_options', description: 'Turn PDF extras on or off. Only pass the ones the user mentioned.', parameters: O({ watermark: B('Watermark'), qr: B('Payment QR'), signature: B('Signature'), notes: B('Notes on PDF') }) },
      { name: 'preview_invoice', description: 'Open the invoice preview.', parameters: O() },
      { name: 'close_preview', description: 'Close the preview.', parameters: O() },
      { name: 'generate_pdf', description: 'Generate the invoice PDF. First call without save: the app asks whether to save the bill to records. Ask the user, then call again with save true or false. On a saved bill preview it just regenerates the PDF.', parameters: O({ save: B('true = save to records and make PDF, false = PDF only') }) },
      { name: 'pdf_action', description: 'After the PDF is ready: download it, show the QR, or close the box.', parameters: O({ action: { type: 'STRING', enum: ['download', 'qr', 'close', 'close_qr', 'qr_done', 'share'] } }, ['action']) },
      { name: 'bills_search', description: 'Search Previous Bills by invoice number, customer name or phone. Empty query clears the search.', parameters: O({ query: S('Search text') }, ['query']) },
      { name: 'bills_sort', description: 'Sort Previous Bills.', parameters: O({ sort: { type: 'STRING', enum: ['newest', 'oldest', 'amount_high', 'amount_low', 'name_az', 'name_za'] } }, ['sort']) },
      { name: 'bills_date_filter', description: 'Filter Previous Bills by date range.', parameters: O({ range: { type: 'STRING', enum: ['any', 'today', 'yesterday', '7days', 'month', 'lastmonth'] } }, ['range']) },
      { name: 'bills_clear_filters', description: 'Clear search, sort and date filters on Previous Bills.', parameters: O() },
      { name: 'bills_page', description: 'Go to the next or previous page of Previous Bills.', parameters: O({ direction: { type: 'STRING', enum: ['next', 'previous'] } }, ['direction']) },
      { name: 'copy_bill_to_new', description: 'Copy a saved bill into a fresh New Bill so it can be edited and generated again. Identify the bill by invoice_no, position or customer. If the New Bill already has data ask the user first and pass confirmed true.', parameters: O({ ...BILL_REF, confirmed: B('User agreed to replace the current New Bill') }) },
      { name: 'reprint_bill', description: 'Open a saved bill preview to generate its PDF again. Identify by invoice_no, position or customer.', parameters: O(BILL_REF) },
      { name: 'reminder_prepare', description: 'Open the create reminder modal ONLY after checking remaining slots. If all 10 slots are used, tell the user immediately; do not collect details.', parameters: O() },
      { name: 'reminder_list', description: 'Open and read the reminders list.', parameters: O() },
      { name: 'reminder_save', description: 'Create or edit a reminder. Ask for title, date and repeat preference. For edits identify by match_title or position. ALWAYS ask the user to confirm first, then pass confirmed true.', parameters: O({match_title:S('Existing reminder title to edit'),position:N('Existing reminder position'),title:S('Reminder title'),description:S('Description'),date:S('YYYY-MM-DD, tomorrow or later for a new date'),repeat:S('off, daily, weekly, monthly, yearly, or 1-365 days'),confirmed:B('User confirmed the exact details')}) },
      { name: 'reminder_action', description: 'Pause, resume, complete due reminder, mark done, or delete reminder. For done and delete ask for confirmation first.', parameters: O({match_title:S('Reminder title'),position:N('Reminder position'),action:{type:'STRING',enum:['pause','resume','complete','done','delete']},confirmed:B('User confirmed irreversible action')},['action']) },
      { name:'set_theme',description:'Set the app appearance to light, dark, or system device default.',parameters:O({mode:{type:'STRING',enum:['light','dark','system']}},['mode']) },
      { name:'end_conversation',description:'End the voice chat when user says goodbye, bye, bye-bye, end chat, stop listening, or close assistant.',parameters:O() }
    ];
    d.forEach((f) => { if (f.parameters && f.parameters.properties && !Object.keys(f.parameters.properties).length) delete f.parameters; });
    if (nonBlocking) d.forEach((f) => { f.behavior = 'NON_BLOCKING'; });
    return d;
  }

  function systemPrompt(){
    const co=cfg().company?.name||'JAS Tech';
    return [
      `You are the voice-only assistant inside ${co} Billing. Speak naturally in English, Hindi, Telugu or the language of the user, with short clear replies.`,
      'You may operate ONLY New Bill, Previous Bills and Reminders. Admin, user management, permissions and administrative operations are prohibited. Never open Admin or perform admin tasks.',
      'Use available function calls for every app action. Do not claim an operation happened without an ok:true tool response.',
      'New Bill: gather customer information, invoice date, products, prices, quantity, notes and PDF preferences; edit or remove items; preview, generate and optionally save the bill using the existing workflow.',
      'Previous Bills: when asked for yesterday bills, filter by yesterday then read the displayed records. When asked for a particular customer or invoice, search and inspect the list before copying or opening. Never invent a saved bill. Use copy_bill_to_new to reuse the existing Copy action. Never edit the saved record directly.',
      'Preview: when user asks to change invoice fields or PDF preferences while preview is open, close_preview first, make the change, and LEAVE preview closed. Only reopen for an explicit preview request or required generate flow.',
      'PDF: when user says close QR or QR done, use pdf_action close_qr or qr_done; these differ from closing the PDF options box.',
      'Theme: use set_theme for dark, light, or system default.',
      'When user says goodbye, bye, bye-bye, end chat, stop listening, or close assistant, call end_conversation, then say aloud exactly: Have a great day. Goodbye! in your own Gemini voice. Do not call other tools after that. Do not confuse this with closing a modal.',
      'Reminders: call reminder_prepare before collecting details for a NEW reminder to check the 10-reminder limit and show the form. Use reminder_list to answer active reminder counts or find a title. List, create, edit, pause, resume, complete, mark done or delete using the existing app handlers. New or changed reminder dates must be from tomorrow through 365 days ahead. Repeats: off, daily, weekly, monthly, yearly, or custom 1-365 days.',
      'Ask concise questions for missing essential information. Always confirm clearing an existing draft, reminder creation or edit, reminder done/delete and saving a bill. If user says no, do not perform the action.',
      'At the start of a new voice conversation, greet once: Welcome to [company name] Billing. You are currently on [current tab]. How can I help you? Keep it short. Do not repeat this greeting on model fallback.',
      'When the user interrupts, listen and adapt. Do not invent names, amounts, dates, invoice numbers, or successful results. Money is INR.',
      'When unsure about the current screen, call get_app_state. The initial screen is '+JSON.stringify(tabContext())
    ].join(' ');
  }


  function showAct(text, bad) {
    if (!ui.act) return;
    ui.act.textContent = text;
    ui.act.classList.toggle('bad', !!bad);
  }

  async function runTool(call) {
    const fn = TOOLS[call.name];
    let output;
    showAct('Working: ' + (call.name || '').replace(/_/g, ' ') + '…');
    try { output = currentTab() === 'admin' ? {ok:false,error:'Admin is not available to the voice assistant.'} : (fn ? await fn(call.args || {}) : { ok: false, error: 'Unknown tool.' }); }
    catch (e) { console.error('[voice] tool error', call.name, e); output = { ok: false, error: String(e && e.message || e) }; }
    console.debug('[voice] tool result', call.name, !!(output && output.ok));
    showAct((output && output.ok ? 'Done: ' : 'Not done: ') + call.name.replace(/_/g, ' ') + (output && output.error ? ' (' + output.error + ')' : ''), !(output && output.ok));
    if (output && output.ok === false && output.error && !output.needs_confirmation) toast(output.error, 'warning');
    if (output && output.ok && !output.screen && call.name !== 'get_app_state') {
      try { output.screen = tabContext(); } catch (e) { /* ignore */ }
    }
    const response = { output };
    // Extended Thinking: NON_BLOCKING tool responses must not include scheduling.
    return { id: call.id, name: call.name, response };
  }

  /* ===================================================================
     Gemini Live session
     =================================================================== */
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function openSession(model) {
    return new Promise((resolve, reject) => {
      let settled = false;
      thinkingModel = /thinking/i.test(model);
      const sock = new WebSocket(WS_URL + encodeURIComponent(getKey()));
      ws = sock;
      ready = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { sock.close(); } catch (e) { /* ignore */ } reject(new Error('timeout')); } }, 12000);

      sock.onopen = () => {
        dbg('socket open, model=' + model + ', thinking=' + thinkingModel);
        const gen = {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: aiCfg().voiceName || 'Puck' } } }
        };
        if (thinkingModel) gen.thinkingConfig = { thinkingLevel: String(aiCfg().thinkingLevel || 'MEDIUM').toUpperCase() };
        sock.send(JSON.stringify({
          setup: {
            model: 'models/' + model,
            generationConfig: gen,
            systemInstruction: { parts: [{ text: systemPrompt() }] },
            tools: [{ functionDeclarations: declarations(thinkingModel) }],
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        }));
      };
      sock.onmessage = async (ev) => {
        let raw = ev.data;
        if (raw instanceof Blob) raw = await raw.text();
        let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
        if (msg.setupComplete) dbg('setupComplete');
        if (msg.error) dbg('SERVER ERROR: ' + JSON.stringify(msg.error).slice(0, 200));
        if (msg.setupComplete && !settled) { settled = true; clearTimeout(timer); ready = true; resolve(); return; }
        handleServer(msg);
      };
      sock.onerror = () => {
        dbg('socket error'); if (!settled) { settled = true; clearTimeout(timer); reject(new Error('socket error')); } };
      sock.onclose = (ev) => {
        dbg('socket closed code=' + ev.code + ' reason=' + (ev.reason || '-'));
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error('closed ' + ev.code + ' ' + (ev.reason || ''))); return; }
        if (ws === sock && active) {
          console.warn('[voice] closed', ev.code, ev.reason);
          stopSession('ended');
          if (ev.reason) toast('Voice: ' + ev.reason.slice(0, 120), 'warning');
        }
      };
    });
  }

  function dispatchCalls(calls) {
    if (!calls || !calls.length) return;
    if (thinkingModel && sources.size === 0 && !greetingPending) setStatus('listening');
    toolCallCount += calls.length;activity();
    dbg('running tools: ' + calls.map((c) => c.name).join(', '));
    Promise.all(calls.map(runTool)).then((functionResponses) => {
      send({ toolResponse: { functionResponses } });
      dbg('tool response sent');
    });
  }

  function handleServer(msg) {
    try {
      const k = Object.keys(msg).filter((x) => x !== 'usageMetadata');
      const sc1 = msg.serverContent;
      const bits = [];
      if (sc1) {
        if (sc1.interrupted) bits.push('interrupted');
        if (sc1.turnComplete) bits.push('turnComplete');
        if (sc1.modelTurn && sc1.modelTurn.parts) bits.push('parts:' + sc1.modelTurn.parts.map((p) => p.inlineData ? 'audio' : p.functionCall ? 'functionCall' : p.text ? 'text' : 'other').join('+'));
        if (sc1.inputTranscription && sc1.inputTranscription.text) bits.push('heard="' + sc1.inputTranscription.text.trim().slice(0, 40) + '"');
      }
      if (msg.toolCall) bits.push('TOOLCALL ' + (msg.toolCall.functionCalls || []).map((c) => c.name).join(','));
      const only = k.length === 1 && k[0] === 'serverContent' && sc1 && sc1.modelTurn && !bits.some((b) => b !== 'parts:audio');
      if (!only) dbg('server: ' + k.join(',') + (bits.length ? ' [' + bits.join(' ') + ']' : '') + (msg.interactionStatus ? ' status=' + msg.interactionStatus : ''));
    } catch (e) { /* logging must never break handling */ }
    // 1) Tool calls first, so a UI hiccup below can never block an action.
    try {
      const sc0 = msg.serverContent;
      let calls = (msg.toolCall && msg.toolCall.functionCalls) || (sc0 && sc0.toolCall && sc0.toolCall.functionCalls) || [];
      const parts0 = sc0 && sc0.modelTurn && sc0.modelTurn.parts;
      if (!calls.length && parts0) {
        calls = parts0.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args }));
      }
      if(farewellInProgress)calls=calls.filter(c=>c.name==='end_conversation');
      dispatchCalls(calls);
    } catch (e) { console.error('[voice] tool dispatch error', e); }

    // 2) Audio, transcripts and status.
    try {
      const sc = msg.serverContent;
      const status = msg.interactionStatus || (sc && sc.interactionStatus);
      if (sc) {
        if (sc.interrupted && !farewellInProgress) { stopPlayback(); turnDone = true; }
        if (sc.inputTranscription && sc.inputTranscription.text) { activity();
          if (newUserTurn) { uText = ''; aText = ''; newUserTurn = false; }
          uText += sc.inputTranscription.text;
          renderText();
        }
        if (sc.outputTranscription && sc.outputTranscription.text) { activity();
          aText += sc.outputTranscription.text;
          renderText();
        }
        const parts = sc.modelTurn && sc.modelTurn.parts;
        if (parts) {
          for (const p of parts) {
            if (p.inlineData && p.inlineData.data) { activity();
              turnDone = false;
              if (outCtx && outCtx.state === 'suspended') outCtx.resume();
              playPcm(p.inlineData.data);
              setStatus('speaking');
            }
          }
        }
        if (sc.turnComplete) {
          if(farewellInProgress){farewellTurnComplete=true;finishFarewell();return;}
          if (greetingPending) { greetingPending = false; clearTimeout(greetingTimer); greetingTimer = null; }
          dbg('you said: "' + uText.slice(0, 80) + '" | assistant said: "' + aText.slice(-160) + '" | tool calls so far: ' + toolCallCount);
          if (thinkingModel && toolCallCount === 0 && /system error|something went wrong|error occurred/i.test(aText)) switchToFallback();
          newUserTurn = true;
          if (!thinkingModel) { turnDone = true; maybeIdle(); }
        }
      }
      if(farewellInProgress && status==='IDLE'){farewellTurnComplete=true;finishFarewell();}
      if (!farewellInProgress && thinkingModel && status) {
        if (status === 'IN_PROGRESS') { if (sources.size === 0 && !greetingPending) setStatus('listening'); }
        else if (status === 'IDLE') { turnDone = true; maybeIdle(); }
      }
      if (msg.goAway) toast('Voice session will end soon. Tap the mic to restart.', 'info');
    } catch (e) { console.error('[voice] message handling error', e); }
  }

  // The thinking model reported a system error and never called a tool: move to the plain Live model.
  async function switchToFallback() {
    if (switching) return;
    const a = aiCfg();
    const fb = (a.fallbackModel && a.fallbackModel !== activeModel) ? a.fallbackModel : 'gemini-3.8-live';
    if (fb === activeModel) return;
    switching = true;
    dbg('Thinking model failed to run tools. Switching to ' + fb);
    const old = ws;
    ws = null; ready = false;
    if (old) { old.onclose = null; old.onerror = null; old.onmessage = null; try { old.close(1000); } catch (e) { /* ignore */ } }
    stopPlayback();
    setStatus('connecting');
    try {
      await openSession(fb);
      activeModel = fb;
      ui.model.textContent = fb;
      toolCallCount = 0; uText = ''; aText = ''; newUserTurn = true; turnDone = true;
      setStatus('listening');
      showAct('Switched voice engine. Please say your command again.');
      toast('Switched voice engine. Please say it again.', 'info');
      dbg('USING MODEL: ' + fb);
    } catch (e) {
      dbg('Switch failed: ' + (e && e.message));
      stopSession('error');
    }
    switching = false;
  }

  async function startSession() {
    if (active || starting) return;
    const key = getKey();
    if (!key) {
      setStatus('error');
      ui.status.textContent = 'Missing API key: add ai.apiKey in config.json';
      toast('Voice AI: API key not found in config.json (ai.apiKey).', 'error');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      setStatus('error');
      ui.status.textContent = 'Microphone needs HTTPS';
      toast('Microphone works only on HTTPS or localhost.', 'error');
      return;
    }
    starting = true;
    muted = false;
    uText = aText = ''; newUserTurn = true; turnDone = true;
    showAct('');
    setStatus('connecting');

    try {
      // Everything audio-related starts inside the user's tap so browsers allow it.
      const AC = window.AudioContext || window.webkitAudioContext;
      outCtx = new AC();
      if (outCtx.state === 'suspended') outCtx.resume();
      await startMic();
    } catch (e) {
      console.error('[voice] mic error', e);
      cleanupAudio();
      starting = false;
      setStatus('error');
      ui.status.textContent = (e && e.name === 'NotAllowedError') ? 'Mic access denied. Enable it in permission settings.' : 'Could not open the microphone';
      toast(ui.status.textContent, 'error');
      return;
    }

    const a = aiCfg();
    const models = [a.primaryModel || 'gemini-3.8-live-extended-thinking', (a.fallbackModel || 'gemini-3.8-live')].filter((m, i, arr) => m && arr.indexOf(m) === i);
    let lastErr = null;
    for (const m of models) {
      try {
        await openSession(m);
        activeModel = m;
        ui.model.textContent = m;
        dbg('USING MODEL: ' + m + ' (tools declared: ' + declarations(thinkingModel).length + ')');
        active = true;
        starting = false;
        startIdleMonitor();
        toolCallCount = 0;
        // Trigger the greeting immediately after Gemini setup, before accepting microphone audio.
        greetingPending = true;
        setStatus('thinking');
        const companyName = cfg().company?.name || 'JAS Tech';
        const tabName = ({newBill:'New Bill',previousBills:'Bills',reminders:'Reminders'})[currentTab()] || 'New Bill';
        send({clientContent:{turns:[{role:'user',parts:[{text:'Start this new voice session now. Greet me aloud exactly once: Welcome to '+companyName+' Billing application. You are currently on '+tabName+'. How can I help you? Do not wait for microphone speech.'}]}],turnComplete:true}});
        greetingTimer = setTimeout(()=>{ greetingPending=false; greetingTimer=null; if(active && !sources.size) setStatus('listening'); },12000);
        showAct('');
        watchApp();
        lastCtx = '';
        pushContext(true);
        return;
      } catch (e) {
        lastErr = e;
        console.warn('[voice] model failed:', m, e && e.message);
        dbg('model failed: ' + m + ' -> ' + (e && e.message));
        try { if (ws) ws.close(); } catch (x) { /* ignore */ }
      }
    }
    starting = false;
    cleanupAudio();
    setStatus('error');
    const why = lastErr && lastErr.message ? lastErr.message : 'unknown';
    ui.status.textContent = 'Could not connect (' + why.slice(0, 80) + ')';
    toast('Voice AI could not connect. Check the API key and model names.', 'error');
  }

  function cleanupAudio() {
    stopPlayback();
    try { if (micNode) { micNode.disconnect(); if (micNode.port) micNode.port.onmessage = null; micNode.onaudioprocess = null; } } catch (e) { /* ignore */ }
    try { if (micSink) micSink.disconnect(); } catch (e) { /* ignore */ }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (inCtx) inCtx.close().catch(() => {});
    if (outCtx) outCtx.close().catch(() => {});
    micNode = micSink = micStream = inCtx = outCtx = null;
  }

  function stopSession(finalStatus) {
    farewellInProgress=false;farewellTurnComplete=false;clearTimeout(farewellTimer);farewellTimer=null;
    greetingPending = false; clearTimeout(greetingTimer); greetingTimer = null;
    clearInterval(idleMonitor);idleMonitor=null;
    const sock = ws;
    ws = null; ready = false; active = false; starting = false; muted = false;
    if (sock) { sock.onclose = null; sock.onerror = null; try { sock.close(1000); } catch (e) { /* ignore */ } }
    cleanupAudio();
    if (ui.sheet) {
      setStatus(finalStatus || 'idle');
    }
  }

  /* ---------------- boot ---------------- */
  function init() {
    if (aiCfg().enabled === false) return;
    buildUi();
    window.JASVoice = {
      open: openSheet,
      close: closeSheet,
      isActive: () => active,
      model: () => activeModel
    };
  }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();