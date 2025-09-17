// app.js - improved mobile-friendly client with JSONP queue, background send, manual sync, concurrency
// IMPORTANT: set ENDPOINT to your Apps Script web app URL and SHARED_TOKEN to the secret above
const ENDPOINT = "https://script.google.com/macros/s/AKfycbwyBqXdqrjtPUmkJETwPzTN6nCfc0J7xhiDVPdDAv61bKzoZk0JAK3Tqfm-5pl4VvC_/exec";
const SHARED_TOKEN = "shopSecret2025";
const KEY_QUEUE = "car_entry_queue_v1";

// Tunables
const MAX_CONCURRENT = 4;         // how many JSONP sends in parallel
const FLUSH_INTERVAL_MS = 3000;   // auto-flush interval while online (ms)
const JSONP_TIMEOUT_MS = 20000;   // JSONP timeout
const MAX_RETRY = 6;              // after these many attempts, stop auto-retrying and alert user

// runtime
const activeSubmissions = new Set(); // submissionIds being processed
let flushIntervalId = null;

// ---------- helpers ----------
function updateStatus() {
  const s = document.getElementById('status');
  if (s) s.textContent = navigator.onLine ? 'online' : 'offline';
  // queue count
  const qCountEl = document.getElementById('queueCount');
  if (qCountEl) qCountEl.textContent = getQueue().length || 0;
  console.log('[STATUS]', navigator.onLine ? 'online' : 'offline', 'queue=', getQueue().length);
}
window.addEventListener('online', ()=>{ updateStatus(); startAutoFlush(); flushOnce(); });
window.addEventListener('offline', ()=>{ updateStatus(); stopAutoFlush(); });

// queue helpers (backwards-compatible)
function getQueue(){
  try {
    const raw = localStorage.getItem(KEY_QUEUE) || "[]";
    const arr = JSON.parse(raw);
    // Normalize items: ensure id, ts, data, retryCount
    return arr.map(item => {
      if (!item) return null;
      if (item.id && item.data) {
        item.retryCount = item.retryCount || 0;
        return item;
      }
      // older format: {ts:..., data:...} -> ensure id
      if (item.data && item.data.submissionId) return { id: item.data.submissionId, ts: item.ts || Date.now(), data: item.data, retryCount: item.retryCount || 0 };
      // fallback: create id
      const gen = ("s_" + (item.ts || Date.now()) + "_" + Math.floor(Math.random()*1000000));
      return { id: gen, ts: item.ts || Date.now(), data: item.data || item, retryCount: item.retryCount || 0 };
    }).filter(Boolean);
  } catch(e){
    console.warn('queue parse err', e);
    return [];
  }
}
function setQueue(q){ localStorage.setItem(KEY_QUEUE, JSON.stringify(q)); updateStatus(); }

function pushToQueueItem(item){
  const q = getQueue();
  q.push(item);
  setQueue(q);
}

function removeFromQueueById(id){
  let q = getQueue();
  q = q.filter(it => !(it && it.id === id));
  setQueue(q);
}

// Uppercase except services (do not touch services array)
function uppercaseExceptServices(fd) {
  try {
    fd.carRegistrationNo = (fd.carRegistrationNo || "").toString().toUpperCase();
    fd.carName = (fd.carName || "").toString().toUpperCase();
    if (Array.isArray(fd.modeOfPayment)) fd.modeOfPayment = fd.modeOfPayment.map(s => (s||"").toString().toUpperCase());
    else fd.modeOfPayment = (fd.modeOfPayment || "").toString().toUpperCase();
    fd.adviceToCustomer = (fd.adviceToCustomer || "").toString().toUpperCase();
    fd.otherInfo = (fd.otherInfo || "").toString().toUpperCase();
  } catch(e){ console.warn('uppercaseExceptServices err', e); }
  return fd;
}

// Format car registration: try to produce "AA NNXXX NNNN" style
function formatCarRegistration(raw) {
  if (!raw) return raw;
  var s = raw.toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
  var re = /^([A-Z]{1,2})(\d{1,2})([A-Z0-9]{0,6})(\d{4})$/;
  var m = s.match(re);
  if (m) {
    var part1 = m[1];
    var part2 = m[2] + (m[3] || "");
    var part3 = m[4];
    return part1 + " " + part2 + " " + part3;
  }
  var last4 = s.match(/(\d{4})$/);
  if (last4) {
    var last4Digits = last4[1];
    var rest = s.slice(0, s.length - 4);
    if (rest.length >= 2) {
      var st = rest.slice(0, 2);
      var mid = rest.slice(2);
      if (mid.length > 0) return st + " " + mid + " " + last4Digits;
      return st + " " + last4Digits;
    } else if (rest.length > 0) {
      return rest + " " + last4Digits;
    }
  }
  return s;
}

// JSONP helper (returns Promise)
function jsonpRequest(url, timeoutMs) {
  timeoutMs = timeoutMs || JSONP_TIMEOUT_MS;
  return new Promise(function(resolve, reject) {
    var cbName = "jsonp_cb_" + Date.now() + "_" + Math.floor(Math.random()*100000);
    window[cbName] = function(data) {
      try { resolve(data); } finally {
        try { delete window[cbName]; } catch(e){}
        var s = document.getElementById(cbName);
        if (s && s.parentNode) s.parentNode.removeChild(s);
      }
    };
    url = url.replace(/(&|\?)?callback=[^&]*/i, "");
    var full = url + (url.indexOf('?') === -1 ? '?' : '&') + 'callback=' + encodeURIComponent(cbName);
    var script = document.createElement('script');
    script.id = cbName;
    script.src = full;
    script.async = true;
    script.onerror = function() {
      try { delete window[cbName]; } catch(e){}
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('JSONP script load error'));
    };
    var timer = setTimeout(function(){
      try { delete window[cbName]; } catch(e){}
      if (script.parentNode) script.parentNode.removeChild(script);
      reject(new Error('JSONP timeout'));
    }, timeoutMs);
    document.body.appendChild(script);
  });
}

// Build JSONP URL and call — includes both submissionId and clientId for server compatibility
function sendToServerJSONP(formData, clientTs) {
  var params = [];
  function add(k,v){ if (v === undefined || v === null) v=""; params.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v))); }
  add("token", SHARED_TOKEN);
  add("carRegistrationNo", formData.carRegistrationNo || "");
  add("carName", formData.carName || "");
  if (Array.isArray(formData.services)) add("services", formData.services.join(", "));
  else add("services", formData.services || "");
  add("qtyTiresWheelCoverSold", formData.qtyTiresWheelCoverSold || "");
  add("amountPaid", formData.amountPaid || "");
  if (Array.isArray(formData.modeOfPayment)) add("modeOfPayment", formData.modeOfPayment.join(", "));
  else add("modeOfPayment", formData.modeOfPayment || "");
  add("kmsTravelled", formData.kmsTravelled || "");
  add("adviceToCustomer", formData.adviceToCustomer || "");
  add("otherInfo", formData.otherInfo || "");
  // include submissionId for server-side dedupe, also include clientId (server expects clientId)
  if (formData.submissionId) { add("submissionId", formData.submissionId); add("clientId", formData.submissionId); }
  if (clientTs) add("clientTs", String(clientTs));

  var base = ENDPOINT;
  var url = base + (base.indexOf('?') === -1 ? '?' : '&') + params.join("&");
  if (url.length > 1900) return Promise.reject(new Error("Payload too large for JSONP"));
  return jsonpRequest(url, JSONP_TIMEOUT_MS);
}

// queue an item — avoid duplicates by submissionId
function queueSubmission(formData){
  var q = getQueue();
  var id = formData.submissionId || ("s_" + Date.now() + "_" + Math.floor(Math.random()*1000000));
  // if already present, don't add again
  if (q.some(it => it && it.id === id)) {
    console.log('[QUEUE] submission already queued, id=', id);
    return;
  }
  q.push({ id: id, ts: Date.now(), data: formData, retryCount: 0 });
  setQueue(q);
  console.log('[QUEUE] queued, length=', getQueue().length, 'id=', id);
}

// ---------- Flush logic (concurrent, safe) ----------
/*
  flushOnce() picks up to MAX_CONCURRENT items from queue and attempts to send them in parallel.
  Successful items are removed. Failed items increment retryCount and remain for later tries.
*/
async function flushOnce() {
  if (!navigator.onLine) return;
  let q = getQueue();
  if (!q || q.length === 0) { console.log('[FLUSH] nothing to flush'); return; }
  // build batch: oldest-first up to MAX_CONCURRENT and skip in-flight ones
  const batch = [];
  for (let i = 0; i < q.length && batch.length < MAX_CONCURRENT; i++) {
    const it = q[i];
    if (!it || !it.id || !it.data) continue;
    if (activeSubmissions.has(it.id)) continue;
    batch.push(it);
  }
  if (batch.length === 0) { console.log('[FLUSH] no eligible items (all in-flight)'); return; }

  console.log('[FLUSH] sending batch size=', batch.length);
  // mark active
  batch.forEach(it => activeSubmissions.add(it.id));

  // send in parallel
  const promises = batch.map(it => {
    return sendToServerJSONP(it.data, it.ts)
      .then(resp => ({ id: it.id, success: !!(resp && resp.success), resp: resp }))
      .catch(err => ({ id: it.id, error: err }));
  });

  const results = await Promise.allSettled(promises);
  // process results
  for (const p of results) {
    if (p.status === 'fulfilled') {
      const r = p.value;
      if (r.success) {
        // remove from queue
        removeFromQueueById(r.id);
        console.log('[FLUSH] success id=', r.id, r.resp);
        // notify user briefly
        if (r.resp && r.resp.serial) showMessage('Saved — Serial: ' + r.resp.serial);
      } else {
        // server-side returned validation error or unknown structure
        if (r.resp && r.resp.error) {
          // remove from queue (server rejected) and inform user
          removeFromQueueById(r.id);
          alert('Server rejected an offline entry and it was removed: ' + r.resp.error);
        } else {
          // treat as temporary failure -> increment retryCount
          incrementRetryCount(r.id);
          console.warn('[FLUSH] response indicates failure, will retry later id=', r.id, r.resp);
        }
      }
    } else {
      // promise rejected
      const obj = p.reason || {};
      if (obj && obj.id) {
        incrementRetryCount(obj.id);
      } else {
        // can't map, just log
        console.warn('[FLUSH] send failed (unmapped)', p.reason);
      }
    }
    // unmark active for that id
    try { activeSubmissions.delete(p.value && p.value.id ? p.value.id : (p.reason && p.reason.id ? p.reason.id : null)); } catch(e){}
  }

  updateStatus();
}

function incrementRetryCount(id){
  let q = getQueue();
  for (let i=0;i<q.length;i++){
    if (q[i].id === id) {
      q[i].retryCount = (q[i].retryCount || 0) + 1;
      if (q[i].retryCount >= MAX_RETRY) {
        // stop auto retrying and alert user for manual action
        alert('An offline entry failed to sync after multiple attempts. You may inspect and re-submit. id=' + id);
        // optionally keep it in queue for manual retry, or move it to a "dead" area — for now we keep it but don't auto-flush further until manual
      }
      break;
    }
  }
  setQueue(q);
}

// start/stop auto flush loop
function startAutoFlush(){
  if (flushIntervalId) return;
  flushIntervalId = setInterval(function(){
    try { if (navigator.onLine) flushOnce(); } catch(e){ console.warn('auto flush err', e); }
  }, FLUSH_INTERVAL_MS);
}
function stopAutoFlush(){
  if (!flushIntervalId) return;
  clearInterval(flushIntervalId); flushIntervalId = null;
}

// expose manual sync for button
async function manualSyncNow(){
  if (!navigator.onLine) { alert('You are offline. Connect to network and try again.'); return; }
  showMessage('Syncing queued entries...');
  // run flushUntilEmpty but guard loops
  const MAX_RUNS = 8;
  for (let i=0;i<MAX_RUNS;i++){
    await flushOnce();
    const remaining = getQueue().length;
    if (!remaining) break;
    // small delay to let server settle
    await new Promise(r=>setTimeout(r, 300));
  }
  const rem = getQueue().length;
  if (rem === 0) showMessage('All queued entries synced.');
  else showMessage('Sync attempted. Remaining: ' + rem);
}

// convenience alias used by HTML
window.syncNow = manualSyncNow;

// collect data from DOM
function collectFormData(){
  var services = Array.from(document.querySelectorAll('.service:checked')).map(i=>i.value);
  var mode = Array.from(document.querySelectorAll('.mode:checked')).map(i=>i.value);
  return {
    carRegistrationNo: document.getElementById('carRegistrationNo').value.trim(),
    carName: document.getElementById('carName').value.trim(),
    services: services,
    qtyTiresWheelCoverSold: document.getElementById('qtyTiresWheelCoverSold').value,
    amountPaid: document.getElementById('amountPaid').value,
    modeOfPayment: mode,
    kmsTravelled: document.getElementById('kmsTravelled').value,
    adviceToCustomer: document.getElementById('adviceToCustomer').value.trim(),
    otherInfo: document.getElementById('otherInfo').value.trim(),
    addIfMissing: document.getElementById('addIfMissing') ? document.getElementById('addIfMissing').checked : false
  };
}

function showMessage(text){
  var m = document.getElementById('msg');
  if (!m) { console.log('[UI]', text); return; }
  m.textContent = text; m.style.display='block';
  setTimeout(()=>{ if (m) m.style.display='none'; }, 4000);
}
function clearForm(){
  try {
    document.getElementById('carRegistrationNo').value='';
    document.getElementById('carName').value='';
    document.querySelectorAll('.service').forEach(ch=>ch.checked=false);
    document.getElementById('qtyTiresWheelCoverSold').value='';
    document.getElementById('amountPaid').value='';
    document.querySelectorAll('.mode').forEach(ch=>ch.checked=false);
    document.getElementById('kmsTravelled').value='';
    document.getElementById('adviceToCustomer').value='';
    document.getElementById('otherInfo').value='';
    if (document.getElementById('addIfMissing')) document.getElementById('addIfMissing').checked=false;
  } catch(e){ console.warn('clearForm error', e); }
}

// small generator for submissionId
function makeSubmissionId() {
  return "s_" + Date.now() + "_" + Math.floor(Math.random()*1000000);
}

// Expose submitForm global so index.html's inline call works
window.submitForm = async function() {
  // call the same internal flow as click/touch handlers
  const btn = document.getElementById('submitBtn');
  if (btn) {
    // trigger the click handler we attach below
    btn.click();
  } else {
    // fallback: run flow
    await doSubmitFlow();
  }
};

// ---------- DOM bindings (safe for mobile) ----------
document.addEventListener('DOMContentLoaded', function() {
  updateStatus();
  startAutoFlush();

  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');
  // new sync button
  const syncBtn  = document.getElementById('syncBtn');

  if (syncBtn) {
    syncBtn.addEventListener('click', function(){ window.syncNow(); });
    syncBtn.addEventListener('touchend', function(ev){ ev && ev.preventDefault(); window.syncNow(); }, { passive:false });
  }

  if (!submitBtn) {
    console.warn('[INIT] submitBtn not found in DOM');
    return;
  }

  // Ensure button is type=button
  try { submitBtn.setAttribute('type','button'); } catch(e){}

  // Prevent double-handling between touchend and click
  let ignoreNextClick = false;

  async function doSubmitFlow() {
    try {
      // Basic client validation
      var carRegEl = document.getElementById('carRegistrationNo');
      var carReg = carRegEl ? carRegEl.value.trim() : "";
      var servicesChecked = document.querySelectorAll('.service:checked');
      var amountEl = document.getElementById('amountPaid');
      var amount = amountEl ? amountEl.value.trim() : "";
      var modeChecked = document.querySelectorAll('.mode:checked');

      if (carReg === "") { alert("Car registration number is required."); return; }
      if (!servicesChecked || servicesChecked.length === 0) { alert("Please select at least one service."); return; }
      if (amount === "") { alert("Amount paid by customer is required."); return; }
      if (!modeChecked || modeChecked.length === 0) { alert("Please select at least one mode of payment."); return; }

      // collect
      var formData = collectFormData();

      // assign a submissionId (if not already present)
      if (!formData.submissionId) formData.submissionId = makeSubmissionId();

      // if this id is already active (somehow), stop
      if (activeSubmissions.has(formData.submissionId)) {
        console.log('[SUBMIT] submission already in-flight id=', formData.submissionId);
        showMessage('Submission in progress — please wait');
        return;
      }

      // format car registration (client-side)
      formData.carRegistrationNo = formatCarRegistration(formData.carRegistrationNo);
      // uppercase except services
      formData = uppercaseExceptServices(formData);

      // mark active so we don't double-send same id
      activeSubmissions.add(formData.submissionId);

      // immediate visible feedback
      submitBtn.disabled = true;
      const origLabel = submitBtn.textContent;
      submitBtn.textContent = 'Saving...';

      // clear UI immediately
      showMessage('Submitted — registering...');
      clearForm();

      // background send
      (async function backgroundSend(localForm) {
        try {
          if (navigator.onLine) {
            // flush queued first (best-effort)
            try { await flushOnce(); } catch(e){ console.warn('flushOnce err', e); }

            // Try send current item
            try {
              const clientTs = Date.now();
              const resp = await sendToServerJSONP(localForm, clientTs);
              if (resp && resp.success) {
                showMessage('Saved — Serial: ' + resp.serial);
                // ensure item is not in queue (cleanup)
                try {
                  let q = getQueue();
                  q = q.filter(it => !(it && it.id === localForm.submissionId));
                  setQueue(q);
                } catch(e) { console.warn('cleanup queue err', e); }
              } else if (resp && resp.error) {
                // server validation error -> do NOT queue; inform user
                showMessage('Server rejected: ' + resp.error);
                console.warn('Server rejected:', resp.error);
              } else {
                // unknown -> queue
                queueSubmission(localForm);
                showMessage('Saved locally (server busy). Will sync later.');
              }
            } catch (errSend) {
              // network/JSONP error -> queue locally
              console.warn('send failed -> queueing', errSend);
              queueSubmission(localForm);
              showMessage('Network error — saved locally.');
            }

            // attempt another flush (best-effort)
            try { await flushOnce(); } catch(e){}
          } else {
            // offline -> queue locally
            queueSubmission(localForm);
            showMessage('Offline — saved locally and will sync when online.');
          }
        } catch (bgErr) {
          console.error('backgroundSend unexpected', bgErr);
          try { queueSubmission(localForm); } catch(e){}
          showMessage('Error occurred — saved locally.');
        } finally {
          // done processing this id
          try { activeSubmissions.delete(localForm.submissionId); } catch(e){}
          // restore button label
          try { submitBtn.disabled = false; submitBtn.textContent = origLabel || 'Submit'; } catch(e){}
          updateStatus();
        }
      })(formData);

    } catch (ex) {
      console.error('submit handler exception', ex);
      showMessage('Unexpected error. Try again.');
      submitBtn.disabled = false; submitBtn.textContent = 'Submit';
    }
  }

  // touchend handler to support mobile taps
  function onTouchEndSubmit(ev) {
    if (!ev) return;
    ev.preventDefault && ev.preventDefault();
    ev.stopPropagation && ev.stopPropagation();
    ignoreNextClick = true;
    setTimeout(()=>{ ignoreNextClick = false; }, 800);
    doSubmitFlow();
  }
  function onClickSubmit(ev) {
    if (ignoreNextClick) { ev && ev.preventDefault(); console.log('[APP] ignored click after touch'); return; }
    doSubmitFlow();
  }

  // Attach event listeners (touch first, then click)
  submitBtn.addEventListener('touchend', onTouchEndSubmit, { passive:false });
  submitBtn.addEventListener('click', onClickSubmit, { passive:false });

  // Clear button
  if (clearBtn) {
    clearBtn.addEventListener('touchend', function(ev){ ev && ev.preventDefault(); clearForm(); showMessage('Form cleared'); }, { passive:false });
    clearBtn.addEventListener('click', function(ev){ clearForm(); showMessage('Form cleared'); }, { passive:false });
  }

  // quick overlay check (helpful when mobile layouts accidentally cover button)
  setTimeout(function(){
    try {
      var rect = submitBtn.getBoundingClientRect();
      var midX = rect.left + rect.width/2;
      var midY = rect.top + rect.height/2;
      var el = document.elementFromPoint(midX, midY);
      if (el && el !== submitBtn && !submitBtn.contains(el)) {
        console.warn('[APP] submit button may be overlapped by', el);
      } else {
        console.log('[APP] submit button reachable');
      }
    } catch(e){}
  }, 300);

}); // DOMContentLoaded end



