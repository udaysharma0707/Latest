
// app.js - improved mobile-friendly client with JSONP queue & background send
// IMPORTANT: set ENDPOINT to your Apps Script web app URL and SHARED_TOKEN to the secret above
const ENDPOINT = "https://script.google.com/macros/s/AKfycbyR5ofGSm1Pafs7n4rT_jVg58Da_rTFQ-NNP8R6hpyxhyA2jFkxA_hp033AcNZNvlB3-A/exec";
const SHARED_TOKEN = "shopSecret2025";
const KEY_QUEUE = "car_entry_queue_v1";

// ---------- runtime state for dedupe ----------
const activeSubmissions = new Set(); // submissionIds currently being processed

// ---------- helpers ----------
function updateStatus() {
  const s = document.getElementById('status');
  if (s) s.textContent = navigator.onLine ? 'online' : 'offline';
  console.log('[STATUS]', navigator.onLine ? 'online' : 'offline');
}
window.addEventListener('online', ()=>{ updateStatus(); flushQueue(); });
window.addEventListener('offline', ()=>{ updateStatus(); });

// queue helpers (backwards-compatible)
function getQueue(){
  try {
    const raw = localStorage.getItem(KEY_QUEUE) || "[]";
    const arr = JSON.parse(raw);
    // Normalize any old-format items (data-only) to have id
    return arr.map(item => {
      if (!item) return null;
      if (item.id) return item;
      // older format: {ts:..., data:...} -> ensure id exists
      if (item.data && item.data.submissionId) return { id: item.data.submissionId, ts: item.ts, data: item.data };
      // fallback: create id
      const gen = ("s_" + (item.ts || Date.now()) + "_" + Math.floor(Math.random()*1000000));
      return { id: gen, ts: item.ts || Date.now(), data: item.data || {} };
    }).filter(Boolean);
  } catch(e){
    console.warn('queue parse err', e);
    return [];
  }
}
function setQueue(q){ localStorage.setItem(KEY_QUEUE, JSON.stringify(q)); }

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

// JSONP helper
function jsonpRequest(url, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
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

// Build JSONP URL and call — now includes submissionId
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
  // include submissionId for server-side dedupe
  if (formData.submissionId) add("submissionId", formData.submissionId);
  if (clientTs) add("clientTs", String(clientTs));

  var base = ENDPOINT;
  var url = base + (base.indexOf('?') === -1 ? '?' : '&') + params.join("&");
  if (url.length > 1900) return Promise.reject(new Error("Payload too large for JSONP"));
  return jsonpRequest(url, 20000);
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
  q.push({ id: id, ts: Date.now(), data: formData });
  setQueue(q);
  console.log('[QUEUE] queued, length=', getQueue().length, 'id=', id);
}

// flushQueue: sequentially send oldest-first (respects submissionId)
async function flushQueue() {
  if (!navigator.onLine) return;
  var q = getQueue();
  if (!q || q.length === 0) { console.log('[FLUSH] queue empty'); return; }
  console.log('[FLUSH] starting, len=', q.length);
  var submitBtnEl = document.getElementById('submitBtn');
  if (submitBtnEl) submitBtnEl.disabled = true;
  while (q.length > 0 && navigator.onLine) {
    var item = q[0];
    // guard: if item missing, shift
    if (!item || !item.data) { q.shift(); setQueue(q); q = getQueue(); continue; }
    // if this submission is currently active (in-flight elsewhere), skip it for now
    if (item.id && activeSubmissions.has(item.id)) {
      console.log('[FLUSH] skipping in-flight id=', item.id);
      // move to next (we'll retry later)
      break;
    }
    try {
      // mark active
      if (item.id) activeSubmissions.add(item.id);
      var resp = await sendToServerJSONP(item.data, item.ts);
      console.log('[FLUSH] resp', resp);
      if (resp && resp.success) {
        // remove from queue only on success
        q.shift(); setQueue(q);
        // remove from active
        if (item.id) activeSubmissions.delete(item.id);
        await new Promise(r=>setTimeout(r,120));
      } else {
        // server returned validation error => remove from queue? No — better to alert user and stop
        if (resp && resp.error) { alert("Server error during flush: " + resp.error); break; }
        // unknown failure -> break and try later
        if (item.id) activeSubmissions.delete(item.id);
        break;
      }
    } catch (err) {
      console.warn('[FLUSH] error', err);
      // send failed -> ensure not marked active, and break to try later
      if (item.id) activeSubmissions.delete(item.id);
      break;
    }
    q = getQueue();
  }
  if (submitBtnEl) submitBtnEl.disabled = false;
  console.log('[FLUSH] finished, remaining=', getQueue().length);
}

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

// ---------- DOM bindings (safe for mobile) ----------
document.addEventListener('DOMContentLoaded', function() {
  updateStatus();

  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');

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
      var carReg = document.getElementById('carRegistrationNo').value.trim();
      var servicesChecked = document.querySelectorAll('.service:checked');
      var amount = document.getElementById('amountPaid').value.trim();
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

      // immediate visible feedback but short-lived
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      setTimeout(()=>{ submitBtn.textContent = 'Submit'; submitBtn.disabled = false; }, 700);

      // clear UI immediately (user asked for this)
      showMessage('Submitted — registering...');
      clearForm();

      // background send (fire-and-forget style)
      (async function backgroundSend(localForm) {
        try {
          if (navigator.onLine) {
            // flush queued first (best-effort)
            try { await flushQueue(); } catch(e){ console.warn('flushQueue err', e); }

            // Try send current item
            try {
              const clientTs = Date.now();
              const resp = await sendToServerJSONP(localForm, clientTs);
              if (resp && resp.success) {
                showMessage('Saved — Serial: ' + resp.serial);
                // ensure item is not in queue (sometimes user retried earlier)
                // remove any queued items with same id
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
            try { await flushQueue(); } catch(e){}
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




