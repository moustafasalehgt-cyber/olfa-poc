/*
 * OLFA connectivity PoC F0 — evidence and decision helpers (F2c, F5, F6, F7).
 * Records never contain the PIN, the tooling key or a session token.
 */
'use strict';

(function (POC) {
  POC.records = [];   // every F6 record made in this page session
  POC.samples = [];   // latency samples {cell, case, run, call_id, start, end, ms}

  var SECRET_KEYS = { token: 1, pin: 1, tool_key: 1 };

  /** Deep copy without secrets; long strings are replaced by their length (C2/L3 data). */
  POC.sanitize = function (obj) {
    return JSON.parse(JSON.stringify(obj, function (k, v) {
      if (SECRET_KEYS[k]) return v ? '[redacted]' : v;
      if (typeof v === 'string' && v.length > 2048) return '[' + v.length + ' chars]';
      return v;
    }));
  };

  POC.sha256Hex = async function (text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return (b < 16 ? '0' : '') + b.toString(16);
    }).join('');
  };

  POC.randText = function (n) {
    var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < n; i++) s += a[b[i] & 63];
    return s;
  };

  /** Nearest-rank percentile of a numeric array. */
  POC.percentile = function (arr, p) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (x, y) { return x - y; });
    var idx = Math.max(0, Math.ceil(p / 100 * s.length) - 1);
    return s[idx];
  };

  /** F5: latency verdict over every latency-set sample of the cell. */
  POC.latencyVerdict = function (cell) {
    var ms = POC.samples.filter(function (s) { return s.cell === cell; }).map(function (s) { return s.ms; });
    var p50 = POC.percentile(ms, 50), p95 = POC.percentile(ms, 95);
    return { n: ms.length, p50: p50, p95: p95, pass: ms.length > 0 && p50 < 3000 && p95 < 6000 };
  };

  /**
   * F2c cleanup simulator: applies the fixed cleanup order to row views at now = k.
   * Used to compute the expected store state in C14 and C15.
   */
  POC.simulateCleanup = function (rows, k, cfg) {
    var deleted = [], converted = [], after1 = [];
    rows.forEach(function (r) {
      if (r.state === 'TOMBSTONE' && r.expired_at + cfg.rTomb <= k) deleted.push(r.exec_id);
      else after1.push(r);
    });
    var out = after1.map(function (r) {
      var tf = null, fin = null;
      if (r.state === 'COMPLETED' || r.state === 'FAILED') { tf = r.t_f; fin = r.state; }
      else if (r.state === 'PENDING') { tf = r.deadline_at; fin = 'STALE_PENDING'; }
      if (tf !== null && tf + cfg.rFull <= k) {
        converted.push(r.exec_id);
        return Object.assign({}, r, { state: 'TOMBSTONE', final_state: fin, t_f: tf, expired_at: k });
      }
      return r;
    });
    return { rows: out, deleted: deleted, converted: converted };
  };

  /**
   * C8 rule: NOT_FOUND only before the first PENDING or COMPLETED; then PENDING
   * zero or more times; then COMPLETED; nothing else (lookups without a readable
   * answer are ignored, they carry no state).
   */
  POC.validC8Path = function (states) {
    var phase = 0; // 0 = NOT_FOUND allowed, 1 = PENDING seen, 2 = COMPLETED seen
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      if (s === 'NO_RESPONSE') continue;
      if (s === 'NOT_FOUND') { if (phase !== 0) return false; }
      else if (s === 'PENDING') { if (phase === 2) return false; phase = 1; }
      else if (s === 'COMPLETED') { if (phase === 2) return false; phase = 2; }
      else return false;
    }
    return phase === 2;
  };

  /** Builds and stores one F6 record; sends it to the records sheet; never throws. */
  POC.saveRecord = async function (ctx, outcome) {
    var meta = POC.meta || {};
    var rec = POC.sanitize({
      poc_version: 'F0 page 1.0 (Document F rev 10.4)',
      cell_id: ctx.cell,
      browser: meta.browser, browser_version: meta.browserVersion, os_version: meta.osVersion,
      device: meta.device, user_agent: navigator.userAgent,
      tester: meta.tester,
      date_time: new Date().toISOString(),
      case: ctx.caseId,
      run: ctx.run,
      attempt: ctx.attempt || 1,
      cold: !!ctx.cold,
      clock_offset_ms: POC.offsetMs,
      result: outcome.result,
      reason: outcome.reason || '',
      calls: ctx.calls,
      oracle: outcome.oracle || null,
      details: outcome.details || null,
      cleanup_invocations: ctx.cleanups,
      latency_samples: ctx.samples,
      evidence: 'Attach for this run: screenshot, console log, network log (HAR) with tokens redacted.'
    });
    POC.records.push(rec);
    try {
      var r = await POC.tool('record_run', { record: rec });
      rec.server_recorded = r.recorded === true;
    } catch (e) {
      rec.server_recorded = false;
      rec.server_record_error = String(e.message || e);
    }
    return rec;
  };

  POC.download = function (name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  /**
   * F6: redacts tokens, the tooling key and PINs from a HAR text. HAR bodies are
   * JSON strings inside JSON, so the quotes may be escaped (\").
   */
  POC.redactHar = function (text) {
    var count = 0;
    var keyHex = /(\\?"(?:token|tool_key)\\?"\s*:\s*\\?")([0-9a-f]{64})/g;
    var pin = /(\\?"pin\\?"\s*:\s*\\?")(\d{4,12})/g;
    var out = text.replace(keyHex, function (m, p1) { count++; return p1 + '[redacted]'; })
                  .replace(pin, function (m, p1) { count++; return p1 + '[redacted]'; });
    var remaining = (out.match(keyHex) || []).length + (out.match(pin) || []).length;
    return { text: out, count: count, remaining: remaining };
  };

  POC.exportRecords = function (cell) {
    var recs = POC.records.filter(function (r) { return r.cell_id === cell; });
    POC.download(cell + '_records_' + Date.now() + '.json', JSON.stringify(recs, null, 2));
  };

  /** F5 raw timing file: one line per sample; the percentiles come from this file only. */
  POC.exportTiming = function (cell) {
    var lines = ['cell_id,case,run,call_id,start_iso,end_iso,ms'];
    POC.samples.filter(function (s) { return s.cell === cell; }).forEach(function (s) {
      lines.push([s.cell, s.case, s.run, s.call_id, new Date(s.start).toISOString(),
                  new Date(s.end).toISOString(), Math.round(s.ms)].join(','));
    });
    POC.download(cell + '_timing_' + Date.now() + '.csv', lines.join('\n') + '\n', 'text/csv');
  };
})(window.POC);
