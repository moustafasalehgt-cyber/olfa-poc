/*
 * OLFA connectivity PoC F0 — page controller: configuration, the per-cell run
 * sequence (F3 repetitions), VOID reruns for C14/C15, the latency verdict (F5),
 * N/A recording and the F7 matrix summary. TEST ONLY.
 */
'use strict';

(function (POC) {
  var $ = function (id) { return document.getElementById(id); };
  var stop = false;
  var busy = false;
  var firstCaseDone = false;
  POC.stopRequested = function () { return stop; };

  var FUNCTIONAL = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C12', 'C13', 'C14', 'C15', 'C16'];
  var LATENCY = ['C11', 'L2', 'L3'];
  var VOIDABLE = { C14: 1, C15: 1 };
  var MAX_VOID_ATTEMPTS = 3;

  // ---------- UI helpers ----------

  var ui = {
    log: function (msg) {
      var line = new Date().toISOString().slice(11, 23) + '  ' + msg;
      var el = $('log');
      el.textContent += line + '\n';
      el.scrollTop = el.scrollHeight;
      console.log('[OLFA-POC-F0] ' + msg);
    },
    status: function (msg) { $('status').textContent = msg; },
    prompt: function (msg, buttons) {
      return new Promise(function (resolve) {
        $('overlayMsg').textContent = msg;
        var box = $('overlayButtons');
        box.innerHTML = '';
        buttons.forEach(function (label) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'primary';
          b.textContent = label;
          b.addEventListener('click', function () { $('overlay').hidden = true; resolve(label); });
          box.appendChild(b);
        });
        $('overlay').hidden = false;
      });
    }
  };

  function cellId() { return 'F0-' + $('cellB').value + '-' + $('cellG').value + '-TP0'; }

  function readConfig() {
    POC.cfg.url = $('cfgUrl').value.trim();
    POC.cfg.toolKey = $('cfgToolKey').value.trim();
    POC.cfg.username = $('cfgUser').value.trim();
    POC.cfg.pin = $('cfgPin').value.trim();
    POC.meta = {
      tester: $('metaTester').value.trim(),
      device: $('metaDevice').value.trim(),
      browserVersion: $('metaBrowserVersion').value.trim(),
      osVersion: $('metaOsVersion').value.trim(),
      browser: $('cellB').options[$('cellB').selectedIndex].text
    };
    try {
      localStorage.setItem('olfaPocF0', JSON.stringify({
        url: POC.cfg.url, user: POC.cfg.username, tester: POC.meta.tester, device: POC.meta.device,
        bv: POC.meta.browserVersion, os: POC.meta.osVersion
      }));
    } catch (e) { /* storage may be unavailable (G4); nothing secret is stored anyway */ }
    var missing = [];
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(POC.cfg.url)) missing.push('web app URL (…/exec)');
    if (!/^[0-9a-f]{64}$/.test(POC.cfg.toolKey)) missing.push('tooling key (64 hex)');
    if (!POC.cfg.username) missing.push('test user');
    if (!/^\d{6,12}$/.test(POC.cfg.pin)) missing.push('test PIN');
    ['tester', 'device', 'browserVersion', 'osVersion'].forEach(function (k) { if (!POC.meta[k]) missing.push(k); });
    return missing;
  }

  function loadSaved() {
    try {
      var s = JSON.parse(localStorage.getItem('olfaPocF0') || '{}');
      if (s.url) $('cfgUrl').value = s.url;
      if (s.user) $('cfgUser').value = s.user;
      if (s.tester) $('metaTester').value = s.tester;
      if (s.device) $('metaDevice').value = s.device;
      if (s.bv) $('metaBrowserVersion').value = s.bv;
      if (s.os) $('metaOsVersion').value = s.os;
    } catch (e) { /* ignore */ }
    $('uaHint').textContent = 'User agent: ' + navigator.userAgent + '. Enter the exact browser and OS versions from the browser\'s About page.';
  }

  function addResultRow(rec) {
    var tr = document.createElement('tr');
    var cls = 'r-' + String(rec.result).split(' ')[0].replace('/', '');
    [new Date().toISOString().slice(11, 19), rec.cell_id, rec.case, rec.run, rec.result, rec.reason || '',
     rec.server_recorded ? 'yes' : 'NO — download the records'].forEach(function (v, i) {
      var td = document.createElement('td');
      td.textContent = String(v);
      if (i === 4) td.className = cls;
      tr.appendChild(td);
    });
    $('results').querySelector('tbody').appendChild(tr);
  }

  function setBusy(b) {
    busy = b;
    ['btnCheck', 'btnRunCell', 'btnRunOne', 'btnLatency', 'btnNA', 'btnSummary'].forEach(function (id) { $(id).disabled = b; });
    $('btnStop').disabled = !b;
    if (!b) ui.status('Idle.');
  }

  var wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { ui.log('Screen wake lock not available: keep the screen on manually.'); }
  }

  // ---------- Running cases ----------

  async function prepare() {
    var missing = readConfig();
    if (missing.length) { alert('Missing or invalid: ' + missing.join(', ')); return false; }
    var off = await POC.measureOffset(3);
    if (!off) { ui.log('Connection check: the time request was not readable. Record the browser console and network log.'); return false; }
    ui.log('Clock offset (server − client) = ' + off.offset + ' ms (round trip ' + off.rtt + ' ms).');
    try {
      var info = await POC.tool('info', {});
      ui.log('Server: ' + info.version + '; TEST W_accept = ' + info.test.wAccept + ' ms; nominal W_accept = ' + info.nominal.wAccept + ' ms.');
    } catch (e) { ui.log('Tooling check failed: ' + e.message); return false; }
    if (Math.abs(off.offset) > 25000) {
      ui.log('WARNING: the client clock differs from the server by more than 25 s. TEST F = 30 s, so new exec_ids may be refused (EXEC_ID_INVALID_TIME). Correct the device clock before testing.');
    }
    return true;
  }

  async function runCase(caseId, run) {
    var cell = cellId();
    var attempts = VOIDABLE[caseId] ? MAX_VOID_ATTEMPTS : 1;
    var outcome = null;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      if (stop) throw new Error('stopped by tester');
      var ctx = POC.makeCtx(cell, caseId, run, ui);
      ctx.attempt = attempt;
      ctx.cold = !firstCaseDone;
      firstCaseDone = true;
      ui.status(cell + ' — ' + caseId + ' (' + POC.CASE_TITLES[caseId] + '), run ' + run + (attempts > 1 ? ', attempt ' + attempt : ''));
      ui.log('start ' + caseId + ' run ' + run + (ctx.cold ? ' (cold)' : ''));
      try {
        outcome = await POC.CASES[caseId](ctx);
      } catch (e) {
        outcome = { result: 'NOT RUN', reason: 'error: ' + (e.message || e) };
      }
      var rec = await POC.saveRecord(ctx, outcome);
      addResultRow(rec);
      ui.log(caseId + ' run ' + run + ': ' + outcome.result + (outcome.reason ? ' — ' + outcome.reason : ''));
      if (outcome.result !== 'VOID') break;
      ui.log('VOID: the store is reset and the case is rerun with a new exec_id (F4).');
    }
    return outcome;
  }

  async function recordLatency() {
    var cell = cellId();
    var v = POC.latencyVerdict(cell);
    var ctx = POC.makeCtx(cell, 'LAT', 1, ui);
    var outcome = v.n === 0
      ? { result: 'NOT RUN', reason: 'no latency samples in this page session' }
      : { result: v.pass ? 'PASS' : 'FAIL',
          reason: 'n=' + v.n + ', p50=' + Math.round(v.p50) + ' ms, p95=' + Math.round(v.p95) + ' ms (thresholds 3000 / 6000)',
          details: v };
    var rec = await POC.saveRecord(ctx, outcome);
    addResultRow(rec);
    ui.log('LAT: ' + outcome.result + ' — ' + outcome.reason);
  }

  async function runFullCell() {
    if (!(await prepare())) return;
    var g3 = $('cellG').value === 'G3';
    for (var run = 1; run <= 3; run++) {
      for (var i = 0; i < FUNCTIONAL.length; i++) {
        var c = FUNCTIONAL[i];
        if (c === 'C12' && !g3) continue; // C12 is defined for G3 cells only (F4)
        await runCase(c, run);
      }
      if (run === 1) {
        for (var j = 0; j < LATENCY.length; j++) await runCase(LATENCY[j], 1);
      }
    }
    await recordLatency();
    ui.log('Full cell finished. Download the records and the timing file, and attach screenshots, the console log and a redacted HAR.');
  }

  function guard(fn) {
    return async function () {
      if (busy) return;
      stop = false;
      setBusy(true);
      await keepAwake(true);
      try { await fn(); }
      catch (e) { ui.log('Stopped: ' + (e.message || e)); }
      finally { await keepAwake(false); setBusy(false); }
    };
  }

  // ---------- Summary (F7) ----------

  async function showSummary() {
    var missing = readConfig().filter(function (m) { return /URL|tooling/.test(m); });
    if (missing.length) { alert('Missing: ' + missing.join(', ')); return; }
    var s = await POC.tool('summary', {});
    var cases = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'L2', 'L3', 'LAT'];
    var box = $('summary');
    box.innerHTML = '';
    var d = document.createElement('div');
    d.className = 'decision';
    d.textContent = s.decision + ' (' + s.records + ' records)';
    box.appendChild(d);
    var t = document.createElement('table');
    var head = document.createElement('tr');
    ['Cell', 'Status'].concat(cases).forEach(function (h) { var th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    t.appendChild(head);
    s.cells.forEach(function (c) {
      var tr = document.createElement('tr');
      [c.cell, c.status].concat(cases.map(function (k) { return c.cases[k] || '—'; })).forEach(function (v, i) {
        var td = document.createElement('td');
        td.textContent = v;
        var first = String(v).split(' ')[0];
        if (first === 'PASS' || first === 'FAIL') td.className = 'r-' + first;
        else if (i > 0 && v !== '—') td.className = 'r-VOID';
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    box.appendChild(t);
  }

  async function recordNA() {
    var missing = readConfig();
    if (missing.length) { alert('Missing or invalid: ' + missing.join(', ')); return; }
    var reason = $('naReason').value.trim();
    if (reason.length < 10) { alert('Give the N/A reason (at least 10 characters).'); return; }
    var c = $('naCase').value;
    var ctx = POC.makeCtx(cellId(), c, 0, ui);
    var rec = await POC.saveRecord(ctx, { result: 'N/A', reason: reason + ' [requires Owner review: set owner_reviewed = TRUE in the records sheet]' });
    addResultRow(rec);
  }

  // ---------- Wiring ----------

  function init() {
    loadSaved();
    var all = FUNCTIONAL.concat(LATENCY);
    all.sort(function (a, b) {
      var na = a[0] === 'C' ? Number(a.slice(1)) : 100 + Number(a.slice(1));
      var nb = b[0] === 'C' ? Number(b.slice(1)) : 100 + Number(b.slice(1));
      return na - nb;
    });
    all.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c + ' — ' + POC.CASE_TITLES[c];
      $('oneCase').appendChild(o);
      var n = document.createElement('option');
      n.value = c; n.textContent = c;
      $('naCase').appendChild(n);
    });
    var cellOpt = document.createElement('option');
    cellOpt.value = 'CELL'; cellOpt.textContent = 'CELL (whole cell)';
    $('naCase').insertBefore(cellOpt, $('naCase').firstChild);
    $('naCase').value = 'CELL';

    var updateCell = function () { $('cellId').textContent = cellId(); };
    $('cellB').addEventListener('change', updateCell);
    $('cellG').addEventListener('change', updateCell);

    $('btnCheck').addEventListener('click', guard(async function () {
      if (await prepare()) ui.log('Connection check passed: readable responses from the web app and the tooling.');
    }));
    $('btnRunCell').addEventListener('click', guard(runFullCell));
    $('btnRunOne').addEventListener('click', guard(async function () {
      var c = $('oneCase').value;
      if (c === 'C12' && $('cellG').value !== 'G3') { alert('C12 is defined for G3 cells only.'); return; }
      if (await prepare()) await runCase(c, Number($('oneRun').value));
    }));
    $('btnLatency').addEventListener('click', guard(async function () {
      if (await prepare()) await recordLatency();
    }));
    $('btnStop').addEventListener('click', function () { stop = true; ui.log('Stop requested: the current step finishes first.'); });
    $('btnExport').addEventListener('click', function () { POC.exportRecords(cellId()); });
    $('btnTiming').addEventListener('click', function () { POC.exportTiming(cellId()); });
    $('btnSummary').addEventListener('click', guard(showSummary));
    $('btnNA').addEventListener('click', guard(recordNA));
    $('btnRedact').addEventListener('click', function () {
      var f = $('harFile').files[0];
      if (!f) { alert('Choose a HAR file first.'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var red = POC.redactHar(String(reader.result));
        POC.download(f.name.replace(/\.har$/i, '') + '.redacted.har', red.text);
        ui.log('HAR redacted: ' + red.count + ' secret value(s) replaced. Remaining unredacted secrets: ' + red.remaining + '.');
      };
      reader.readAsText(f);
    });
    $('btnGenKey').addEventListener('click', function () {
      var b = new Uint8Array(32);
      crypto.getRandomValues(b);
      $('genKey').value = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
      $('genKey').select();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.POC);
