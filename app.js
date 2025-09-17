// app.js — online-only mode (no offline queue, sync button removed)
const ENDPOINT = "https://script.google.com/macros/s/AKfycbwyBqXdqrjtPUmkJETwPzTN6nCfc0J7xhiDVPdDAv61bKzoZk0JAK3Tqfm-5pl4VvC_/exec";
const SHARED_TOKEN = "shopSecret2025";

// Tunables
const JSONP_TIMEOUT_MS = 20000;   // JSONP timeout

// runtime
const activeSubmissions = new Set(); // submissionIds being processed

// ---------- helpers ----------
function updateStatus() {
  const s = document.getElementById('status');
  if (s) s.textContent = navigator.onLine ? 'online' : 'offline';
  console.log('[STATUS]', navigator.onLine ? 'online' : 'offline');
}
// only show status, do not try to auto-flush/queue
window.addEventListener('online', ()=>{ updateStatus(); });
window.addEventListener('offline', ()=>{ updateStatus(); });

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
    otherInfo: document.getElementById('otherInfo').value.trim()
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
  } catch(e){ console.warn('clearForm error', e); }
}

// small generator for submissionId
function makeSubmissionId() {
  return "s_" + Date.now() + "_" + Math.floor(Math.random()*1000000);
}

// Expose submitForm global so index.html's inline call works
window.submitForm = async function() {
  const btn = document.getElementById('submitBtn');
  if (btn) btn.click();
  else await doSubmitFlow();
};

// ---------- DOM bindings (online-only) ----------
document.addEventListener('DOMContentLoaded', function() {
  updateStatus();

  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');
  const syncBtn  = document.getElementById('syncBtn');

  // remove/hide sync button if present (sync not supported anymore)
  if (syncBtn) {
    try { syncBtn.style.display = 'none'; syncBtn.remove(); } catch(e){ /* ignore */ }
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
      // REQUIRE online
      if (!navigator.onLine) {
        alert('Please connect to internet — this app requires an internet connection to submit.');
        return;
      }

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

      // assign a submissionId
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
      showMessage('Submitting — please wait...');
      clearForm();

      // background send (online-only)
      (async function backgroundSend(localForm) {
        try {
          // Attempt send current item
          const clientTs = Date.now();
          try {
            const resp = await sendToServerJSONP(localForm, clientTs);
            if (resp && resp.success) {
              showMessage('Saved — Serial: ' + resp.serial);
            } else if (resp && resp.error) {
              // server validation error -> inform user, don't auto-queue
              alert('Server rejected submission: ' + resp.error);
            } else {
              // unknown server response
              alert('Unexpected server response. Please retry while online.');
            }
          } catch (errSend) {
            // network/JSONP error -> inform user, do NOT save locally
            console.error('send failed', errSend);
            alert('Submission failed. Ensure you have a working internet connection and try again.');
          }

        } catch (bgErr) {
          console.error('backgroundSend unexpected', bgErr);
          alert('Unexpected error occurred. Please retry.');
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
      alert('Unexpected error. Try again.');
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
