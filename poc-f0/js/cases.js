/*
 * OLFA connectivity PoC F0 — functional cases C1–C16 (F4) and latency set L1–L3 (F5).
 * Pass/fail is decided by the server oracle (effects, exec_log, counter, store
 * snapshots) and the recorded server times, never by response timing alone.
 * A case that could not be set up is NOT RUN; C14/C15 outside their windows are VOID.
 */
'use strict';

(function (POC) {
  var LATENCY_CASES = { C1: 1, C2: 1, C3: 1, C12: 1, C11: 1, L2: 1, L3: 1 };
  var TEST_CFG = { rFull: 120000, rTomb: 300000, f: 30000, delta: 30000, wAccept: 360000 };
  var DEADLINE_MS = 390000;

  function st(out) {
    return out.kind === 'RESPONSE' ? out.body.status : out.kind;
  }

  POC.makeCtx = function (cell, caseId, run, ui) {
    var ctx = {
      cell: cell, caseId: caseId, run: run, ui: ui,
      calls: [], samples: [], cleanups: [],
      latency: !!LATENCY_CASES[caseId]
    };
    ctx.log = function (m) { ui.log('[' + caseId + ' r' + run + '] ' + m); };

    ctx.send = async function (req, opts) {
      var out = await POC.send(req, opts);
      var call = {
        call_id: req.call_id, kind: req.kind, action: req.action || null, tool: req.tool || null,
        exec_id: req.exec_id || null, target_exec_id: req.target_exec_id || null, store: req.store || null,
        t_start: out.wall_start, t_end: out.wall_end, ms: Math.round(out.ms),
        outcome: out.kind, reason: out.reason || null, http: out.http || null,
        status: out.body ? out.body.status : null, state: out.body ? out.body.state || null : null,
        server_received_at: out.body ? out.body.server_received_at : null,
        server_sent_at: out.body ? out.body.server_sent_at : null
      };
      ctx.calls.push(call);
      if (ctx.latency && req.kind === 'action') {
        var s = { cell: cell, case: caseId, run: run, call_id: req.call_id,
                  start: out.wall_start, end: out.wall_end, ms: out.ms };
        ctx.samples.push(s);
        POC.samples.push(s);
      }
      return out;
    };

    ctx.act = async function (action, payload, opts) {
      opts = opts || {};
      var E = opts.E || POC.newExecId();
      var out = await ctx.send({ kind: 'action', action: action, exec_id: E, store: opts.store || 'MAIN',
                                 payload: payload || {}, token: opts.token }, opts);
      return { E: E, out: out };
    };

    ctx.lookup = function (E, store) {
      return ctx.send({ kind: 'lookup', target_exec_id: E, store: store || 'MAIN' });
    };

    ctx.tool = async function (name, args) {
      var out = await ctx.send({ kind: 'tool', tool: name, tool_key: POC.cfg.toolKey, args: args || {} });
      if (out.kind !== 'RESPONSE') throw new Error('tool ' + name + ' gave ' + out.kind + ' ' + (out.reason || ''));
      if (out.body.status !== 'TOOL_OK') throw new Error('tool ' + name + ' status ' + out.body.status);
      if (name === 'cleanup') ctx.cleanups.push({ store: args.store, k: out.body.k, end: out.body.end,
        deleted: out.body.deleted.length, converted: out.body.converted.length, rows_after: out.body.rows_after });
      return out.body;
    };

    ctx.oracle = async function (ids) {
      var r = await ctx.tool('oracle', { exec_ids: ids });
      return r.oracle;
    };

    ctx.waitServer = async function (t) {
      while (POC.serverNow() < t) {
        if (POC.stopRequested && POC.stopRequested()) throw new Error('stopped by tester');
        await POC.sleep(Math.min(1000, t - POC.serverNow()));
      }
    };

    /**
     * F2d resolver: polls result.get every 5 s until COMPLETED/FAILED or
     * deadline_at + 30 s. EXPIRED or a PENDING past the deadline is UNKNOWN.
     * NOT_FOUND for 60 s allows one resend with the same E (opts.resend).
     */
    ctx.resolve = async function (E, opts) {
      opts = opts || {};
      var store = opts.store || 'MAIN';
      var deadline = opts.deadlineAt || ((opts.sentAtServer || POC.serverNow()) + DEADLINE_MS);
      var path = [];
      var notFoundSince = null;
      var resent = false;
      for (;;) {
        var lk = await ctx.lookup(E, store);
        var state = lk.kind === 'RESPONSE' ? (lk.body.state || lk.body.status) : 'NO_RESPONSE';
        path.push({ at: POC.serverNow(), state: state });
        if (state === 'COMPLETED' || state === 'FAILED') return { final: state, path: path, body: lk.body, resent: resent };
        if (state === 'EXPIRED') return { final: 'UNKNOWN', reason: 'EXPIRED', path: path, resent: resent };
        if (state === 'PENDING') { deadline = lk.body.deadline_at; notFoundSince = null; }
        if (state === 'NOT_FOUND') {
          if (notFoundSince === null) notFoundSince = POC.serverNow();
          if (opts.resend && !resent && POC.serverNow() - notFoundSince >= 60000) {
            resent = true;
            ctx.log('NOT_FOUND for 60 s: resending with the same exec_id (F2d)');
            var r = await opts.resend();
            var rs = st(r);
            path.push({ at: POC.serverNow(), state: 'RESEND:' + rs });
            if (rs === 'COMPLETED' || rs === 'FAILED') return { final: rs, path: path, body: r.body, resent: true };
            if (r.kind === 'RESPONSE' && r.body.deadline_at) deadline = r.body.deadline_at;
            else deadline = POC.serverNow() + DEADLINE_MS;
          }
        } else if (state !== 'NO_RESPONSE') {
          notFoundSince = null;
        }
        if (POC.serverNow() > deadline + 30000) {
          return { final: 'UNKNOWN', reason: state === 'PENDING' ? 'STALE_PENDING' : state, path: path, resent: resent };
        }
        await POC.sleep(5000);
      }
    };

    ctx.prompt = function (msg, buttons) { return ui.prompt(msg, buttons); };
    return ctx;
  };

  function count(o, E, mark) {
    if (!o || !o[E]) return 0;
    return o[E].effects.filter(function (e) { return e.mark === mark; }).length;
  }
  function execs(o, E) { return o && o[E] ? o[E].executions.length : 0; }
  function pass(extra) { return Object.assign({ result: 'PASS' }, extra || {}); }
  function fail(reason, extra) { return Object.assign({ result: 'FAIL', reason: reason }, extra || {}); }

  // ---------- C1, C2, C3 ----------

  async function c1(ctx) {
    var text = POC.randText(1024);
    var r = await ctx.act('echo', { text: text });
    if (r.out.kind !== 'RESPONSE') return fail('response ' + r.out.kind + ' ' + (r.out.reason || ''));
    if (r.out.body.status !== 'COMPLETED') return fail('status ' + r.out.body.status);
    if (!r.out.body.result || r.out.body.result.text !== text) return fail('payload differs');
    return pass({ details: { exec_id: r.E } });
  }

  async function c2(ctx) {
    var r = await ctx.act('big', {});
    if (r.out.kind !== 'RESPONSE') return fail('response ' + r.out.kind + ' ' + (r.out.reason || ''));
    var b = r.out.body;
    if (b.status !== 'COMPLETED') return fail('status ' + b.status);
    var h = await POC.sha256Hex(b.result.data);
    if (b.result.data.length !== 102400 || h !== b.result.sha256) {
      return fail('SHA-256 or length differs', { details: { received_sha: h, server_sha: b.result.sha256, length: b.result.data.length } });
    }
    return pass({ details: { sha256: h, length: b.result.data.length } });
  }

  async function c3(ctx) {
    var steps = [];
    var token = null;
    var a = await ctx.act('login', { username: POC.cfg.username, pin: POC.cfg.pin });
    steps.push({ step: 'login', status: st(a.out) });
    if (st(a.out) !== 'COMPLETED' || !a.out.body.result.token) return fail('login did not succeed', { details: { steps: steps } });
    token = a.out.body.result.token;
    var b = await ctx.act('whoami', {}, { token: token });
    steps.push({ step: 'whoami', status: st(b.out), user: b.out.body && b.out.body.result ? b.out.body.result.user : null });
    var c = await ctx.act('logout', {}, { token: token });
    steps.push({ step: 'logout', status: st(c.out) });
    var d = await ctx.act('whoami', {}, { token: token });
    steps.push({ step: 'whoami after logout', status: st(d.out),
                 error: d.out.body && d.out.body.error ? d.out.body.error.code : null });
    // Exposure checks: URL, cookies, web storage.
    var exposed = [];
    if (location.href.indexOf(token) >= 0) exposed.push('url');
    if (document.cookie.indexOf(token) >= 0) exposed.push('cookie');
    [localStorage, sessionStorage].forEach(function (s, i) {
      for (var j = 0; j < s.length; j++) {
        if (String(s.getItem(s.key(j))).indexOf(token) >= 0) exposed.push(i ? 'sessionStorage' : 'localStorage');
      }
    });
    token = null;
    var ok = st(b.out) === 'COMPLETED' && st(c.out) === 'COMPLETED' &&
             st(d.out) === 'FAILED' && d.out.body.error && d.out.body.error.code === 'TOKEN_INVALID';
    if (exposed.length) return fail('token exposed: ' + exposed.join(','), { details: { steps: steps } });
    if (!ok) return fail('token not accepted then refused as required', { details: { steps: steps } });
    return pass({ details: { steps: steps, note: 'Console log and HAR must also be checked by the tester for the token.' } });
  }

  // ---------- C4, C5 ----------

  async function c4(ctx) {
    var texts = [];
    for (var i = 0; i < 20; i++) texts.push(i + ':' + POC.randText(256));
    var res = await Promise.all(texts.map(function (t) { return ctx.act('echo', { text: t }); }));
    var bad = [];
    res.forEach(function (r, i) {
      if (r.out.kind !== 'RESPONSE') bad.push(i + ':' + r.out.kind);
      else if (r.out.body.status !== 'COMPLETED' || r.out.body.result.text !== texts[i]) bad.push(i + ':mismatch');
    });
    if (bad.length) return fail('cross-delivery or unreadable: ' + bad.join(' '));
    return pass({ details: { parallel: 20 } });
  }

  async function counterBurst(ctx, forcedIdx) {
    await ctx.tool('reset_counter', { key: ctx.cell });
    var ids = [];
    for (var i = 0; i < 20; i++) ids.push(POC.newExecId());
    var sentAt = POC.serverNow();
    var res = await Promise.all(ids.map(function (E, i) {
      var opts = { E: E };
      if (forcedIdx && forcedIdx.indexOf(i) >= 0) opts.abortAfterMs = 300;
      return ctx.act('counter', { key: ctx.cell }, opts);
    }));
    var finals = {};
    var shownUnknown = [];
    for (var j = 0; j < 20; j++) {
      var r = res[j];
      if (r.out.kind === 'RESPONSE' && (r.out.body.status === 'COMPLETED' || r.out.body.status === 'FAILED')) {
        finals[r.E] = r.out.body.status;
        continue;
      }
      shownUnknown.push(r.E);
      ctx.log('exec ' + j + ' shows UNKNOWN (' + (r.out.reason || st(r.out)) + '); resolving by lookup');
      var E = r.E;
      var rs = await ctx.resolve(E, {
        sentAtServer: sentAt,
        resend: function () { return ctx.act('counter', { key: ctx.cell }, { E: E }).then(function (x) { return x.out; }); }
      });
      finals[E] = rs.final === 'UNKNOWN' ? 'UNKNOWN:' + rs.reason : rs.final;
    }
    var oracle = await ctx.oracle(ids);
    var counter = (await ctx.tool('get_counter', { key: ctx.cell })).value;
    return { ids: ids, res: res, finals: finals, oracle: oracle, counter: counter, shownUnknown: shownUnknown };
  }

  async function c5(ctx) {
    var b = await counterBurst(ctx, null);
    var values = [];
    var problems = [];
    b.ids.forEach(function (E, i) {
      var counts = b.oracle[E].effects.filter(function (e) { return e.mark === 'COUNT'; });
      if (counts.length !== 1) problems.push(i + ': ' + counts.length + ' COUNT rows');
      else values.push(Number(counts[0].value));
      var r = b.res[i].out;
      if (r.kind === 'RESPONSE' && r.body.status === 'COMPLETED' && counts.length === 1 &&
          Number(r.body.result.value) !== Number(counts[0].value)) problems.push(i + ': response value differs from oracle');
    });
    values.sort(function (x, y) { return x - y; });
    var expected = values.length === 20 && values.every(function (v, i) { return v === i + 1; });
    if (!expected) problems.push('counter values are not 1..20 once each');
    if (b.counter !== 20) problems.push('counter = ' + b.counter);
    var details = { counter: b.counter, values: values, finals: b.finals };
    if (problems.length) return fail(problems.join('; '), { oracle: b.oracle, details: details });
    return pass({ oracle: b.oracle, details: details });
  }

  // ---------- C6, C7, C8 ----------

  async function c6(ctx) {
    var r = await ctx.act('fail', {});
    var o = await ctx.oracle([r.E]);
    if (r.out.kind !== 'RESPONSE') return fail('response ' + r.out.kind, { oracle: o });
    if (r.out.body.status !== 'FAILED') return fail('status ' + r.out.body.status, { oracle: o });
    if (o[r.E].effects.length !== 0) return fail('side effects found', { oracle: o });
    return pass({ oracle: o, details: { error: r.out.body.error } });
  }

  async function c7(ctx) {
    var r = await ctx.act('slow_effect', { seconds: 25 });
    var o = await ctx.oracle([r.E]);
    if (r.out.kind !== 'RESPONSE') return fail('no readable response before 30 s: ' + r.out.kind + ' ' + (r.out.reason || ''), { oracle: o });
    if (r.out.body.status !== 'COMPLETED') return fail('status ' + r.out.body.status, { oracle: o });
    if (count(o, r.E, 'START') !== 1 || count(o, r.E, 'FINISH') !== 1) return fail('START/FINISH not exactly once', { oracle: o });
    return pass({ oracle: o, details: { ms: Math.round(r.out.ms) } });
  }

  async function c8(ctx) {
    var sentAt = POC.serverNow();
    var r = await ctx.act('slow_effect', { seconds: 40 });
    if (r.out.kind === 'RESPONSE') {
      var o0 = await ctx.oracle([r.E]);
      return fail('a readable ' + r.out.body.status + ' arrived before the 30 s client timer; the client must show UNKNOWN', { oracle: o0 });
    }
    ctx.log('client shows UNKNOWN (' + r.out.reason + '); polling result.get');
    var rs = await ctx.resolve(r.E, { sentAtServer: sentAt });
    var states = rs.path.map(function (p) { return p.state; });
    var o = await ctx.oracle([r.E]);
    var starts = o[r.E].effects.filter(function (e) { return e.mark === 'START'; });
    var fins = o[r.E].effects.filter(function (e) { return e.mark === 'FINISH'; });
    var details = { client_first: 'UNKNOWN:' + r.out.reason, path: states, final: rs.final };
    if (rs.final !== 'COMPLETED') return fail('polling did not end COMPLETED (' + rs.final + ' ' + (rs.reason || '') + ')', { oracle: o, details: details });
    if (!POC.validC8Path(states)) return fail('invalid state sequence', { oracle: o, details: details });
    if (starts.length !== 1 || fins.length !== 1 || !(fins[0].at > starts[0].at)) return fail('START/FINISH not exactly once in order', { oracle: o, details: details });
    return pass({ oracle: o, details: details });
  }

  // ---------- C9 (tester-assisted network cut) ----------

  async function c9(ctx) {
    var E = POC.newExecId();
    var sentAt = POC.serverNow();
    var pending = ctx.act('slow_effect', { seconds: 20 }, { E: E });
    await ctx.prompt('C9: cut the network NOW (airplane mode, Wi-Fi off, or DevTools "Offline"). Press the button once it is cut.', ['Network is cut']);
    await ctx.prompt('Wait at least 10 seconds, then restore the network. Press the button once it is back.', ['Network restored']);
    var r = await pending;
    if (r.out.kind === 'RESPONSE') {
      return { result: 'NOT RUN', reason: 'the network cut did not take effect (readable ' + r.out.body.status + '); rerun C9' };
    }
    ctx.log('client shows UNKNOWN (' + r.out.reason + '); resolving');
    var rs = await ctx.resolve(E, {
      sentAtServer: sentAt,
      resend: function () { return ctx.act('slow_effect', { seconds: 20 }, { E: E }).then(function (x) { return x.out; }); }
    });
    var o = await ctx.oracle([E]);
    var details = { client_first: 'UNKNOWN:' + r.out.reason, path: rs.path.map(function (p) { return p.state; }),
                    final: rs.final, resent_same_exec_id: rs.resent };
    if (count(o, E, 'START') !== 1 || execs(o, E) !== 1) return fail('START or execution not exactly once', { oracle: o, details: details });
    if (rs.final !== 'COMPLETED') return fail('polling did not end COMPLETED (' + rs.final + ')', { oracle: o, details: details });
    return pass({ oracle: o, details: details });
  }

  // ---------- C10 ----------

  async function c10(ctx) {
    var sentAt = POC.serverNow();
    var r = await ctx.act('slow_effect', { seconds: 400 });
    if (r.out.kind === 'RESPONSE' && r.out.body.status !== 'FAILED') {
      // A readable final before 30 s is impossible for a 400 s action unless it was refused.
      var o0 = await ctx.oracle([r.E]);
      return fail('unexpected readable ' + r.out.body.status + ' before the client timer', { oracle: o0 });
    }
    var clientFirst = r.out.kind === 'RESPONSE' ? 'FAILED' : 'UNKNOWN:' + r.out.reason;
    ctx.log('client: ' + clientFirst + '; polling until deadline_at + 30 s (about 7 minutes)');
    var rs = await ctx.resolve(r.E, { sentAtServer: sentAt });
    var o = await ctx.oracle([r.E]);
    var starts = count(o, r.E, 'START'), fins = count(o, r.E, 'FINISH');
    var cls;
    if (rs.final === 'FAILED') cls = 'c_caught_failure';
    else if (starts === 1 && fins === 1 && rs.final === 'COMPLETED') cls = 'b_completed';
    else if (starts === 1 && fins === 0) cls = 'a_platform_termination';
    else cls = 'unclassified';
    var clientOk = (cls === 'a_platform_termination' && rs.final === 'UNKNOWN') ||
                   (cls === 'b_completed' && rs.final === 'COMPLETED') ||
                   (cls === 'c_caught_failure' && rs.final === 'FAILED');
    var rr = await ctx.act('slow_effect', { seconds: 400 }, { E: r.E });
    var o2 = await ctx.oracle([r.E]);
    var resendOk = ['IN_PROGRESS', 'REPLAY', 'REPLAY_FAILED'].indexOf(st(rr.out)) >= 0;
    var details = { client_first: clientFirst, path: rs.path.map(function (p) { return p.state; }),
                    client_final: rs.final, classification: cls, resend_status: st(rr.out),
                    starts_after_resend: count(o2, r.E, 'START') };
    if (cls === 'unclassified') return fail('oracle could not classify (START=' + starts + ', FINISH=' + fins + ')', { oracle: o2, details: details });
    if (!clientOk) return fail('client state does not match the oracle classification', { oracle: o2, details: details });
    if (!resendOk) return fail('same-E resend gave ' + st(rr.out), { oracle: o2, details: details });
    if (count(o2, r.E, 'START') !== 1) return fail('second START after resend', { oracle: o2, details: details });
    return pass({ oracle: o2, details: details });
  }

  // ---------- C12 (G3 cells only), C13 ----------

  async function c12(ctx) {
    var a = await c1(ctx);
    var b = await c3(ctx);
    var details = { c1: a, c3: b, note: 'Compared with the G1 cell of the same browser in the summary.' };
    if (a.result !== 'PASS' || b.result !== 'PASS') return fail('C1 or C3 part failed', { details: details });
    return pass({ details: details });
  }

  async function c13(ctx) {
    var E = POC.newExecId();
    var sentAt = POC.serverNow();
    var both = await Promise.all([
      ctx.act('slow_effect', { seconds: 5 }, { E: E }),
      ctx.act('slow_effect', { seconds: 5 }, { E: E })
    ]);
    var rs = await ctx.resolve(E, { sentAtServer: sentAt });
    var o = await ctx.oracle([E]);
    var details = { responses: both.map(function (x) { return st(x.out); }), lookup_final: rs.final };
    if (count(o, E, 'START') !== 1 || execs(o, E) !== 1) return fail('not exactly one START/execution', { oracle: o, details: details });
    if (rs.final !== 'COMPLETED') return fail('later lookup did not give COMPLETED', { oracle: o, details: details });
    return pass({ oracle: o, details: details });
  }

  // ---------- C14 (deterministic retention timeline) ----------

  function rowOf(snapshot, E) {
    for (var i = 0; i < snapshot.length; i++) if (snapshot[i].exec_id === E) return snapshot[i];
    return null;
  }

  async function c14(ctx) {
    var store = 'C14:' + ctx.cell;
    var runFrom = POC.serverNow() - 1000;
    await ctx.tool('store_reset', { store: store });
    var text = POC.randText(64);
    var E = POC.newExecId();
    var tc = POC.execIdTime(E);
    var first = await ctx.act('echo', { text: text }, { E: E, store: store });
    if (st(first.out) !== 'COMPLETED') return { result: 'VOID', reason: 'initial echo gave ' + st(first.out) + '; rerun' };
    var snap0 = (await ctx.tool('store_snapshot', { store: store })).snapshot;
    var row0 = rowOf(snap0, E);
    if (!row0 || row0.state !== 'COMPLETED' || row0.t_f === null) return { result: 'VOID', reason: 'row not COMPLETED after the echo; rerun' };
    var tf = row0.t_f;
    var void_ = [];

    // k1: target t_f + 60 s (window t_f + 30 s .. t_f + 90 s); expected COMPLETED.
    await ctx.waitServer(tf + 60000);
    var c1x = await ctx.tool('cleanup', { store: store });
    var lk1 = await ctx.lookup(E, store);
    if (c1x.k < tf + 30000 || c1x.k > tf + 90000) void_.push('k1 outside window');
    if (lk1.kind !== 'RESPONSE' || lk1.body.server_received_at < c1x.end) void_.push('lookup 1 not after cleanup 1');

    // k2: target t_f + 2 min 37.5 s (window t_f + 2 min 15 s .. t_f + 3 min); expected EXPIRED, expired_at = k2.
    await ctx.waitServer(tf + 157500);
    var c2x = await ctx.tool('cleanup', { store: store });
    var lk2 = await ctx.lookup(E, store);
    if (c2x.k < tf + 135000 || c2x.k > tf + 180000) void_.push('k2 outside window');
    if (lk2.kind !== 'RESPONSE' || lk2.body.server_received_at < c2x.end) void_.push('lookup 2 not after cleanup 2');
    var x = (lk2.kind === 'RESPONSE' && lk2.body.expired_at) ? lk2.body.expired_at : c2x.k;

    // k3: target x + 5 min 37.5 s (window x + 5 min 15 s .. x + 6 min); expected NOT_FOUND.
    await ctx.waitServer(x + 337500);
    var c3x = await ctx.tool('cleanup', { store: store });
    var lk3 = await ctx.lookup(E, store);
    if (c3x.k < x + 315000 || c3x.k > x + 360000) void_.push('k3 outside window');
    if (lk3.kind !== 'RESPONSE' || lk3.body.server_received_at < c3x.end) void_.push('lookup 3 not after cleanup 3');

    // Resend with the same E after k3: expected EXEC_ID_TOO_OLD, no execution.
    var rs = await ctx.act('echo', { text: text }, { E: E, store: store });
    var tResend = rs.out.kind === 'RESPONSE' ? rs.out.body.server_received_at : null;
    if (tResend === null || tResend < c3x.end) void_.push('resend not received after cleanup 3');
    else if (tResend - tc <= TEST_CFG.wAccept) void_.push('resend inside W_accept');

    var o = await ctx.oracle([E]);
    var clock = await ctx.tool('clock_report', { from: runFrom, to: POC.serverNow() + 5000 });
    var details = {
      t_c: tc, t_f: tf, k1: c1x.k, k2: c2x.k, k3: c3x.k, x: x, resend_received: tResend,
      lookups: [lk1, lk2, lk3].map(function (l) { return l.kind === 'RESPONSE' ? l.body.state : l.kind; }),
      resend_status: st(rs.out), executions: execs(o, E),
      pa1: { samples: clock.samples, duration_ms: clock.duration_ms, b_max_ms: clock.b_max_ms, delta_ms: TEST_CFG.delta }
    };
    if (void_.length) return { result: 'VOID', reason: void_.join('; '), oracle: o, details: details };

    // Expected states computed from the recorded times (F2c rules).
    var row = Object.assign({}, row0);
    var exp1 = POC.simulateCleanup([row], c1x.k, TEST_CFG).rows;
    var exp2 = POC.simulateCleanup(exp1, c2x.k, TEST_CFG).rows;
    var exp3 = POC.simulateCleanup(exp2, c3x.k, TEST_CFG).rows;
    var problems = [];
    if (!(exp1.length === 1 && exp1[0].state === 'COMPLETED')) problems.push('model: k1 should leave COMPLETED');
    if (lk1.body.state !== 'COMPLETED' || !lk1.body.result || lk1.body.result.text !== text) problems.push('after k1 expected COMPLETED with the result, got ' + lk1.body.state);
    if (!(exp2.length === 1 && exp2[0].state === 'TOMBSTONE')) problems.push('model: k2 should make a tombstone');
    if (lk2.body.state !== 'EXPIRED' || lk2.body.expired_at !== c2x.k) problems.push('after k2 expected EXPIRED with expired_at = k2, got ' + lk2.body.state + ' ' + lk2.body.expired_at);
    if (lk2.body.result || lk3.body.result) problems.push('a result was returned after k2');
    if (exp3.length !== 0) problems.push('model: k3 should delete the tombstone');
    if (lk3.body.state !== 'NOT_FOUND') problems.push('after k3 expected NOT_FOUND, got ' + lk3.body.state);
    if (st(rs.out) !== 'EXEC_ID_TOO_OLD') problems.push('resend expected EXEC_ID_TOO_OLD, got ' + st(rs.out));
    if (execs(o, E) !== 1) problems.push('re-execution: ' + execs(o, E) + ' executions');
    if (clock.b_max_ms > TEST_CFG.delta) problems.push('PA-1 CONTRADICTED: b_max ' + clock.b_max_ms + ' ms > δ');
    if (problems.length) return fail(problems.join('; '), { oracle: o, details: details });
    details.pa1.statement = 'PA-1 not contradicted in ' + clock.samples + ' samples over ' + Math.round(clock.duration_ms / 1000) + ' s';
    return pass({ oracle: o, details: details });
  }

  // ---------- C15 (capacity, deterministic seed) ----------

  async function c15(ctx) {
    var store = 'C15:' + ctx.cell;
    var runFrom = POC.serverNow() - 1000;
    var seed = await ctx.tool('seed_c15', { store: store });
    var T = seed.seed_completed_at;
    var E5 = POC.newExecId();
    var s1r = await ctx.act('slow_effect', { seconds: 0 }, { E: E5, store: store });
    var recent = seed.snapshot.filter(function (r) { return r.state === 'COMPLETED' && r.t_f === seed.base - 30000; })[0];
    var tomb = seed.snapshot.filter(function (r) { return r.state === 'TOMBSTONE'; })[0];
    var lkA = await ctx.lookup(recent.exec_id, store);
    var lkB = await ctx.lookup(tomb.exec_id, store);
    var oBefore = await ctx.oracle([E5]);
    var cl = await ctx.tool('cleanup', { store: store });
    var s2r = await ctx.act('slow_effect', { seconds: 0 }, { E: E5, store: store });
    var o = await ctx.oracle([E5]);
    var clock = await ctx.tool('clock_report', { from: runFrom, to: POC.serverNow() + 5000 });

    var s1 = s1r.out.kind === 'RESPONSE' ? s1r.out.body.server_received_at : null;
    var s2 = s2r.out.kind === 'RESPONSE' ? s2r.out.body.server_received_at : null;
    var void_ = [];
    if (T - seed.base > 5000) void_.push('seeding took more than 5 s');
    if (s1 === null || !(T <= s1 && s1 < cl.k)) void_.push('s1 not in [T, k)');
    if (!(cl.k <= T + 60000)) void_.push('k later than T + 60 s');
    if (s2 === null || !(s2 > cl.end)) void_.push('s2 not after the cleanup end');
    if (lkA.kind !== 'RESPONSE' || lkB.kind !== 'RESPONSE' ||
        lkA.body.server_received_at > cl.k || lkB.body.server_received_at > cl.k) void_.push('lookups not before cleanup');
    var details = {
      base: seed.base, T: T, s1: s1, k: cl.k, cleanup_end: cl.end, s2: s2,
      first_send: st(s1r.out), lookups: [lkA.kind === 'RESPONSE' ? lkA.body.state : lkA.kind,
                                         lkB.kind === 'RESPONSE' ? lkB.body.state : lkB.kind],
      rows_after: cl.rows_after, deleted: cl.deleted.length, converted: cl.converted.length,
      resend: st(s2r.out),
      pa1: { samples: clock.samples, duration_ms: clock.duration_ms, b_max_ms: clock.b_max_ms, delta_ms: TEST_CFG.delta }
    };
    if (void_.length) return { result: 'VOID', reason: void_.join('; '), oracle: o, details: details };

    var expected = POC.simulateCleanup(seed.snapshot, cl.k, TEST_CFG);
    var problems = [];
    if (st(s1r.out) !== 'STORE_FULL') problems.push('first send expected STORE_FULL, got ' + st(s1r.out));
    if (execs(oBefore, E5) !== 0 || count(oBefore, E5, 'START') !== 0) problems.push('execution while full');
    if (lkA.body.state !== 'COMPLETED') problems.push('recent lookup expected COMPLETED, got ' + lkA.body.state);
    if (lkB.body.state !== 'EXPIRED') problems.push('tombstone lookup expected EXPIRED, got ' + lkB.body.state);
    if (cl.rows_after !== 30) problems.push('rows after cleanup = ' + cl.rows_after);
    if (expected.rows.length !== cl.snapshot.length) problems.push('store differs from the F2c model (count)');
    else {
      for (var i = 0; i < expected.rows.length; i++) {
        var e = expected.rows[i], a = cl.snapshot[i];
        if (e.exec_id !== a.exec_id || e.state !== a.state || (e.final_state || '') !== (a.final_state || '') ||
            (e.expired_at || null) !== (a.expired_at || null)) { problems.push('store differs from the F2c model at row ' + (i + 2)); break; }
      }
    }
    var pendingKept = cl.snapshot.some(function (r) { return r.state === 'PENDING'; });
    if (!pendingKept) problems.push('the PENDING row was touched');
    if (cl.converted.some(function (id) { return cl.deleted.indexOf(id) >= 0; })) problems.push('a tombstone was created and deleted in the same run');
    if (st(s2r.out) !== 'COMPLETED') problems.push('resend expected COMPLETED, got ' + st(s2r.out));
    if (execs(o, E5) !== 1 || count(o, E5, 'START') !== 1) problems.push('E5 did not execute exactly once');
    if (clock.b_max_ms > TEST_CFG.delta) problems.push('PA-1 CONTRADICTED: b_max ' + clock.b_max_ms + ' ms > δ');
    if (problems.length) return fail(problems.join('; '), { oracle: o, details: details });
    details.pa1.statement = 'PA-1 not contradicted in ' + clock.samples + ' samples over ' + Math.round(clock.duration_ms / 1000) + ' s';
    return pass({ oracle: o, details: details });
  }

  // ---------- C16 ----------

  async function c16(ctx) {
    var b = await counterBurst(ctx, [2, 7, 11, 15, 19]);
    var problems = [];
    var forcedShown = [2, 7, 11, 15, 19].every(function (i) { return b.shownUnknown.indexOf(b.ids[i]) >= 0; });
    if (!forcedShown) problems.push('a forced-timeout call was not shown as UNKNOWN');
    b.ids.forEach(function (E, i) {
      var n = count(b.oracle, E, 'COUNT');
      if (n !== 1) problems.push(i + ': ' + n + ' COUNT rows');
      var f = b.finals[E];
      if (f !== 'COMPLETED' && f !== 'UNKNOWN:STALE_PENDING') problems.push(i + ': final ' + f);
    });
    if (b.counter !== 20) problems.push('counter = ' + b.counter);
    var details = { counter: b.counter, finals: b.finals, shown_unknown: b.shownUnknown.length };
    if (problems.length) return fail(problems.join('; '), { oracle: b.oracle, details: details });
    return pass({ oracle: b.oracle, details: details });
  }

  // ---------- Latency set (F5) ----------

  async function l1(ctx) { // = C11
    var bad = 0;
    for (var i = 0; i < 100; i++) {
      var text = POC.randText(1024);
      var r = await ctx.act('echo', { text: text });
      if (st(r.out) !== 'COMPLETED' || r.out.body.result.text !== text) bad++;
      if (POC.stopRequested && POC.stopRequested()) throw new Error('stopped by tester');
    }
    return bad ? fail(bad + ' of 100 echoes unreadable or wrong') : pass({ details: { echoes: 100 } });
  }

  async function l2(ctx) {
    var bad = 0;
    async function client() {
      for (var i = 0; i < 20; i++) {
        var text = POC.randText(1024);
        var r = await ctx.act('echo', { text: text });
        if (st(r.out) !== 'COMPLETED' || r.out.body.result.text !== text) bad++;
      }
    }
    await Promise.all([client(), client(), client(), client(), client()]);
    return bad ? fail(bad + ' of 100 echoes unreadable or wrong') : pass({ details: { clients: 5, echoes_each: 20 } });
  }

  async function l3(ctx) {
    var bad = 0;
    for (var i = 0; i < 10; i++) {
      var r = await ctx.act('big', {});
      if (st(r.out) !== 'COMPLETED') { bad++; continue; }
      var h = await POC.sha256Hex(r.out.body.result.data);
      if (h !== r.out.body.result.sha256) bad++;
    }
    return bad ? fail(bad + ' of 10 big responses unreadable or wrong') : pass({ details: { big: 10 } });
  }

  POC.CASES = {
    C1: c1, C2: c2, C3: c3, C4: c4, C5: c5, C6: c6, C7: c7, C8: c8, C9: c9, C10: c10,
    C11: l1, C12: c12, C13: c13, C14: c14, C15: c15, C16: c16, L2: l2, L3: l3
  };
  POC.CASE_TITLES = {
    C1: 'echo 1 KB', C2: 'big 100 KB', C3: 'login → whoami → logout → whoami', C4: '20 parallel echoes',
    C5: '20 parallel counter calls', C6: 'fail', C7: 'slow_effect(25)', C8: 'slow_effect(40), poll',
    C9: 'network cut during slow_effect(20) — tester assisted', C10: 'slow_effect(400), about 8 min',
    C11: 'L1: 100 sequential echoes', C12: 'C1 + C3 in G3', C13: 'same exec_id twice in parallel',
    C14: 'retention timeline (TEST values), about 9 min', C15: 'capacity 50 (TEST), deterministic seed',
    C16: '20 counter calls, 5 forced timeouts', L2: '5 clients × 20 echoes', L3: '10 × big 100 KB'
  };
})(window.POC);
