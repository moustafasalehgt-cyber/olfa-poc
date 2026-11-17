/*
 * OLFA connectivity PoC F0 — transport (Document F rev 10.4, F2 F0 page, F2a, F2d).
 * TEST ONLY. Direct fetch: POST, text/plain, redirect "follow", credentials "omit",
 * client timer 30 s. An unreadable response or a timeout is UNKNOWN, never "failed".
 */
'use strict';

window.POC = window.POC || {};
(function (POC) {
  POC.cfg = {
    url: '',             // the web app /exec URL
    toolKey: '',         // TEST tooling key (memory only)
    username: '',        // TEST user
    pin: '',             // TEST PIN (memory only)
    timeoutMs: 30000     // F2: client timer 30 s
  };
  POC.offsetMs = 0;      // server time − client time (F2c, F6)

  POC.uuid = function () {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };

  /** F2a: exec_id = UUIDv4 + "_" + client creation time (ISO). One per intended action. */
  POC.newExecId = function () { return POC.uuid() + '_' + new Date().toISOString(); };
  POC.newCallId = function () { return POC.uuid(); };
  POC.execIdTime = function (E) { return Date.parse(String(E).split('_')[1]); };

  POC.serverNow = function () { return Date.now() + POC.offsetMs; };
  POC.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms)); }); };

  /**
   * Sends one request. Returns an outcome:
   *  {kind:'RESPONSE', body, http, ...times}            readable JSON with the right call_id
   *  {kind:'MISCORRELATED', body, ...}                  readable, but call_id differs (cross-delivery)
   *  {kind:'UNKNOWN', reason, ...}                      timeout, forced abort, network error, unreadable
   * opts.timeoutMs (default 30 s); opts.abortAfterMs forces an early client abort (C16).
   */
  POC.send = async function (req, opts) {
    opts = opts || {};
    req.v = 1;
    req.call_id = req.call_id || POC.newCallId();
    var ctrl = new AbortController();
    var why = null;
    var timeoutMs = opts.timeoutMs || POC.cfg.timeoutMs;
    var timer = setTimeout(function () { why = 'timeout'; ctrl.abort(); }, timeoutMs);
    var forced = null;
    if (opts.abortAfterMs) {
      forced = setTimeout(function () { why = 'forced_timeout'; ctrl.abort(); }, opts.abortAfterMs);
    }
    var wallStart = Date.now();
    var t0 = performance.now();
    var base = { call_id: req.call_id, wall_start: wallStart };
    try {
      var res = await fetch(POC.cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(req),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal
      });
      var text = await res.text();
      clearTimeout(timer); if (forced) clearTimeout(forced);
      var ms = performance.now() - t0;
      var out = Object.assign(base, { http: res.status, ms: ms, wall_end: wallStart + ms });
      var body;
      try { body = JSON.parse(text); } catch (e) {
        return Object.assign(out, { kind: 'UNKNOWN', reason: 'unreadable', http_type: res.type });
      }
      if (body.call_id !== req.call_id) return Object.assign(out, { kind: 'MISCORRELATED', body: body });
      return Object.assign(out, { kind: 'RESPONSE', body: body });
    } catch (e) {
      clearTimeout(timer); if (forced) clearTimeout(forced);
      var ms2 = performance.now() - t0;
      return Object.assign(base, {
        kind: 'UNKNOWN',
        reason: why || 'network_error',
        error: String(e && e.name || e),
        ms: ms2,
        wall_end: wallStart + ms2
      });
    }
  };

  /** Measures the client clock offset from server time; keeps the sample with the smallest round trip. */
  POC.measureOffset = async function (samples) {
    var best = null;
    for (var i = 0; i < (samples || 3); i++) {
      var t0 = Date.now();
      var out = await POC.send({ kind: 'time' });
      var t1 = Date.now();
      if (out.kind === 'RESPONSE' && out.body.status === 'TIME') {
        var rtt = t1 - t0;
        var off = out.body.server_now - (t0 + rtt / 2);
        if (!best || rtt < best.rtt) best = { rtt: rtt, offset: Math.round(off) };
      }
    }
    if (best) POC.offsetMs = best.offset;
    return best;
  };

  POC.tool = async function (name, args) {
    var out = await POC.send({ kind: 'tool', tool: name, tool_key: POC.cfg.toolKey, args: args || {} });
    if (out.kind !== 'RESPONSE') throw new Error('tool ' + name + ': ' + out.kind + ' ' + (out.reason || ''));
    if (out.body.status === 'TOOL_DENIED') throw new Error('tool key refused');
    return out.body;
  };
})(window.POC);
