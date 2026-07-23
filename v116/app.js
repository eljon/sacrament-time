/* Sacrament Time Tracker — front-end logic.
 * Storage is either a Google Apps Script Web App (backed by a Google Sheet)
 * or, if no URL is configured, this browser's localStorage. */
(function () {
  "use strict";

  // Bumped every commit (each commit is a new version).
  var APP_VERSION = 116;

  // Scroll-driven CSS animations run the fly on the COMPOSITOR, in lockstep with
  // the real scroll position — no main-thread rAF reading a lagged pageYOffset, so
  // no deceleration "jump" (that desync was the jank). Where unsupported we fall
  // back to the main-thread rAF fly (updateFly + flyLoop) below.
  var CSS_SCROLL = (function () {
    try {
      return typeof CSS !== "undefined" && CSS.supports &&
        CSS.supports("animation-timeline", "scroll()") &&
        CSS.supports("animation-range", "0px 1px");
    } catch (e) { return false; }
  })();
  var FLY_TIMELINE = "scroll(root block)";

  var DEFAULTS = window.APP_CONFIG || {};
  var LS_CONFIG = "stt.config";
  var LS_LOCAL = "stt.records"; // browser-only fallback store

  // ---- Config ---------------------------------------------------------------
  function loadConfig() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_CONFIG) || "{}"); } catch (e) {}
    return {
      url: (saved.url != null ? saved.url : DEFAULTS.WEB_APP_URL || "").trim(),
      token: (saved.token != null ? saved.token : DEFAULTS.SHARED_TOKEN || "").trim(),
      goal: clampInt(saved.goal != null ? saved.goal : DEFAULTS.GOAL_STREAK, 1, 52, 12),
      startTarget: DEFAULTS.START_TARGET || "13:30",
      endTarget: DEFAULTS.END_TARGET || "14:30",
    };
  }
  function saveConfig(patch) {
    var cur = loadConfig();
    var next = { url: cur.url, token: cur.token, goal: cur.goal };
    for (var k in patch) next[k] = patch[k];
    localStorage.setItem(LS_CONFIG, JSON.stringify(next));
    cfg = loadConfig();
  }
  function clampInt(v, lo, hi, dflt) {
    v = parseInt(v, 10);
    if (isNaN(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }

  var cfg = loadConfig();
  var state = {
    records: [], loading: false, selected: null, heroMode: "auto", slider: null, dragging: null,
    cf: { pos: 0, vel: 0, target: null, dragging: false, raf: null, startX: 0, startPos: 0, lastX: 0, vpx: 0, moved: false },
    cfCenter: null, armed: false, heroView: null,
  };

  // ---- Time helpers ---------------------------------------------------------
  function toMin(hhmm) {
    if (!hhmm) return null;
    var m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  var START_TARGET = toMin(cfg.startTarget);
  var END_TARGET = toMin(cfg.endTarget);

  // Timeline axis: one hour of slack around each target (1:00 PM … 3:00 PM),
  // so a late start or a long meeting still fits on the line.
  var AXIS_START = Math.min(START_TARGET, END_TARGET) - 30; // 13:00
  var AXIS_END = Math.max(START_TARGET, END_TARGET) + 30;   // 15:00
  var AXIS_SPAN = AXIS_END - AXIS_START;
  var MIN_GAP = 1; // start must be at least a minute before end

  function minToHHMM(m) { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function pctOf(min) { return clamp(((min - AXIS_START) / AXIS_SPAN) * 100, 0, 100); }

  function fmt12(hhmm) {
    var mins = toMin(hhmm);
    if (mins == null) return "—";
    var h = Math.floor(mins / 60), m = mins % 60;
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + ap;
  }
  function deltaLabel(mins) {
    if (mins == null) return "";
    if (mins > 0) return mins + " min late";
    if (mins < 0) return (-mins) + " min early";
    return "right on time";
  }

  // ---- Record analysis ------------------------------------------------------
  function analyze(rec) {
    var s = toMin(rec.start), e = toMin(rec.end);
    var startDev = s == null ? null : s - START_TARGET;
    var endDev = e == null ? null : e - END_TARGET;
    var startOnTime = startDev != null && startDev <= 0;
    var endOnTime = endDev != null && endDev <= 0;
    return {
      startMin: s, endMin: e, startDev: startDev, endDev: endDev,
      startOnTime: startOnTime, endOnTime: endOnTime,
      success: startOnTime && endOnTime,
      partial: (startOnTime || endOnTime) && !(startOnTime && endOnTime),
    };
  }
  function sortedRecords() {
    return state.records.slice().sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
  }
  function recordFor(date) {
    for (var i = 0; i < state.records.length; i++) if (state.records[i].date === date) return state.records[i];
    return null;
  }

  function computeStats() {
    var recs = sortedRecords();
    var n = recs.length, successes = 0, startLate = 0, endLate = 0;
    var startDevSum = 0, endDevSum = 0, startDevN = 0, endDevN = 0, longest = 0, run = 0, current = 0;
    recs.forEach(function (r) {
      var a = analyze(r);
      if (a.success) { successes++; run++; if (run > longest) longest = run; } else { run = 0; }
      if (a.startDev != null) { startDevSum += a.startDev; startDevN++; if (a.startDev > 0) startLate++; }
      if (a.endDev != null) { endDevSum += a.endDev; endDevN++; if (a.endDev > 0) endLate++; }
    });
    for (var i = recs.length - 1; i >= 0; i--) { if (analyze(recs[i]).success) current++; else break; }
    return {
      total: n, successes: successes, current: current, longest: longest,
      rate: n ? Math.round((successes / n) * 100) : null,
      avgStartDev: startDevN ? startDevSum / startDevN : null,
      avgEndDev: endDevN ? endDevSum / endDevN : null,
      startLate: startLate, endLate: endLate,
      firstDate: recs.length ? recs[0].date : null,
    };
  }

  // ---- Storage layer --------------------------------------------------------
  function usingRemote() { return !!cfg.url; }
  function localRead() { try { return JSON.parse(localStorage.getItem(LS_LOCAL) || "[]"); } catch (e) { return []; } }
  function localWrite(recs) { localStorage.setItem(LS_LOCAL, JSON.stringify(recs)); }
  function uid() { return "r" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function apiGet() {
    var url = cfg.url + (cfg.url.indexOf("?") >= 0 ? "&" : "?") + "action=list";
    if (cfg.token) url += "&token=" + encodeURIComponent(cfg.token);
    return fetch(url, { method: "GET" }).then(function (r) { return r.json(); });
  }
  function apiPost(payload) {
    payload.token = cfg.token || "";
    return fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // dodges CORS preflight
      body: JSON.stringify(payload), redirect: "follow",
    }).then(function (r) { return r.json(); });
  }

  function loadRecords() {
    if (!usingRemote()) { state.records = localRead(); return Promise.resolve(); }
    state.loading = true; renderAll();
    return apiGet().then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || "Load failed");
      state.records = (data.records || []).filter(function (r) { return r && r.date; });
    }).finally(function () { state.loading = false; });
  }
  // one Sunday = one record, so upsert by date
  function upsertRecord(list, rec) {
    var out = (list || []).filter(function (r) { return r.date !== rec.date; });
    out.push(rec); return out;
  }
  // Reconcile local state with the sheet without disturbing the UI (no spinner,
  // no loading render). Used after an optimistic write so the save feels instant.
  function syncInBackground() {
    apiGet().then(function (data) {
      if (data && data.ok !== false) { state.records = (data.records || []).filter(function (r) { return r && r.date; }); renderAll(); }
    }).catch(function () {});
  }
  function addRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead().filter(function (r) { return r.date !== rec.date; });
      rec.id = uid(); recs.push(rec); localWrite(recs); state.records = recs;
      return Promise.resolve();
    }
    // resolve as soon as the write lands; update state optimistically so the
    // recorded view can render immediately (the sheet is re-synced in the background)
    return apiPost({ action: "add", date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || "Save failed");
        rec.id = rec.id || uid(); state.records = upsertRecord(state.records, rec);
      });
  }
  function updateRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead().map(function (r) { return r.id === rec.id ? rec : r; });
      localWrite(recs); state.records = recs; return Promise.resolve();
    }
    return apiPost({ action: "update", id: rec.id, date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || "Update failed");
        state.records = upsertRecord(state.records, rec);
      });
  }
  function deleteRecord(id) {
    if (!usingRemote()) {
      var recs = localRead().filter(function (r) { return r.id !== id; });
      localWrite(recs); state.records = recs; return Promise.resolve();
    }
    return apiPost({ action: "delete", id: id })
      .then(function (res) {
        if (!res || res.ok === false) throw new Error((res && res.error) || "Delete failed");
        state.records = state.records.filter(function (r) { return r.id !== id; });
      });
  }

  // ---- Date helpers ---------------------------------------------------------
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function parseYMD(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function addDays(s, n) { var d = parseYMD(s); d.setDate(d.getDate() + n); return ymd(d); }
  function shortDate(s) { var d = parseYMD(s); return d ? MON[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear() : s; }
  function weekdayDate(s) { var d = parseYMD(s); return d ? MON[d.getMonth()] + " " + d.getDate() + " <span class='yr'>" + d.getFullYear() + "</span>" : s; }
  function mostRecentSunday() { var d = new Date(); d.setDate(d.getDate() - d.getDay()); return ymd(d); }

  // ---- Rendering ------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  function renderAll() {
    renderBanner(); renderHero(); renderStats(); renderGoal(); renderHistoryGraph(); renderStrip(); renderHistory();
  }

  // A bar per week spanning that week's start→end time on a 1 PM–3 PM axis, so
  // you read punctuality the same way as the timeline (start high, end low).
  // Colour reuses the start→end gradient. On first reveal the real calendar
  // bars and dates fly from the picker into the graph.
  var HG_T0 = 13 * 60, HG_T1 = 15 * 60, HG_PH = 210;   // 1 PM, 3 PM, plot height px
  function hgY(min) { return Math.max(0, Math.min(1, (min - HG_T0) / (HG_T1 - HG_T0))) * HG_PH; }
  function renderHistoryGraph() {
    var section = $("historyGraph"), plot = $("hgPlot"), xrow = $("hgXrow"), yaxis = $("hgYaxis");
    var recs = sortedRecords();   // all weeks; the plot scrolls horizontally
    if (recs.length === 0) { section.hidden = true; state.hgSig = null; return; }
    section.hidden = false;
    // selected is part of the signature: the fly window (and the graph's centred
    // scroll) is keyed to the middle week, so a new selection must rebuild.
    var sig = state.selected + "||" + recs.map(function (r) { return r.date + "|" + r.start + "|" + r.end; }).join(",");
    if (sig === state.hgSig) return;            // unchanged → keep current bars & animation state
    state.hgSig = sig;

    plot.style.height = HG_PH + "px";
    yaxis.style.height = HG_PH + "px";
    plot.innerHTML = ""; yaxis.innerHTML = ""; xrow.innerHTML = "";

    // time axis + gridlines; the 1:30 / 2:30 targets are emphasised
    [[780, "1 PM"], [810, "1:30"], [840, "2 PM"], [870, "2:30"], [900, "3 PM"]].forEach(function (t) {
      var y = hgY(t[0]);
      var lab = document.createElement("span"); lab.className = "hg-ytick"; lab.style.top = y + "px"; lab.textContent = t[1];
      yaxis.appendChild(lab);
      var line = document.createElement("span");
      line.className = "hg-grid" + (t[0] === 810 || t[0] === 870 ? " target" : "");
      line.style.top = y + "px"; plot.appendChild(line);
    });

    state.hgItems = [];
    recs.forEach(function (r) {
      var a = analyze(r), cur = r.date === state.selected;
      var top = hgY(a.startMin), h = Math.max(8, hgY(a.endMin) - top);
      var cs = lateColor(a.startDev), ce = lateColor(a.endDev);
      var d = parseYMD(r.date);
      var col = document.createElement("div"); col.className = "hg-col";
      var bar = document.createElement("span");
      bar.className = "hg-bar" + (cur ? " is-current" : "");
      bar.style.top = top.toFixed(1) + "px"; bar.style.height = h.toFixed(1) + "px";
      bar.style.background = "linear-gradient(to bottom," + cs + "," + ce + ")";
      col.appendChild(bar); plot.appendChild(col);
      var xc = document.createElement("div"); xc.className = "hg-xcol" + (cur ? " is-current" : "");
      xc.innerHTML = '<span class="hg-mon">' + MON[d.getMonth()].toUpperCase() + '</span><span class="hg-day">' + d.getDate() + '</span>';
      xrow.appendChild(xc);
      var tip = shortDate(r.date) + " · " + fmt12(r.start) + " → " + fmt12(r.end);
      col.title = tip; xc.title = tip;
      var go = function () { var idx = state.sundays ? state.sundays.indexOf(r.date) : -1; if (idx >= 0) animateTo(idx); scrollToHero(); };
      col.onclick = go; xc.onclick = go;
      state.hgItems.push({ date: r.date, bar: bar, xc: xc });
    });

    // the 8 weeks that fly are centred on the selected ("middle") week —
    // 3 ahead (more recent) + 4 behind (older), shifted at the ends.
    state.flyWin = computeFlyWindow(state.hgItems.map(function (it) { return it.date; }), state.selected);

    // size columns so the 8-week fly window exactly fills the viewport (older
    // weeks are still a scroll away), then centre the scroller on that window.
    var scroller = plot.parentNode, anchorItem = state.hgItems[state.flyWin.anchor];
    if (scroller && scroller.clientWidth > 50) {
      scroller.style.setProperty("--hgcw", (scroller.clientWidth / 8) + "px");
    }
    if (scroller && anchorItem) {
      var er = anchorItem.xc.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
      scroller.scrollLeft += (er.left + er.width / 2) - (sr.left + sr.width / 2);
      state.hgSuppressUntil = Date.now() + 300;   // ignore the scroll event this programmatic recentre fires
    }

    setupFly();
  }
  // Pick the 8-week fly window around the selected week: 4 behind + centre + 3
  // ahead. Dates are "YYYY-MM-DD" so string order is chronological. Fewer than 3
  // ahead → the shortfall is taken from behind (and vice versa).
  function computeFlyWindow(dates, selected) {
    var n = dates.length;
    if (n === 0) return { set: {}, anchor: 0 };
    if (n <= 8) {
      var all = {}; dates.forEach(function (d) { all[d] = 1; });
      return { set: all, anchor: Math.max(0, dates.indexOf(selected)) };
    }
    var anchor = dates.indexOf(selected);
    if (anchor < 0) { anchor = 0; while (anchor < n && dates[anchor] < selected) anchor++; if (anchor > n - 1) anchor = n - 1; }
    var lo = anchor - 4, hi = anchor + 3;
    if (lo < 0) { hi += -lo; lo = 0; }
    if (hi > n - 1) { lo -= (hi - (n - 1)); hi = n - 1; }
    if (lo < 0) lo = 0;
    var set = {};
    for (var i = lo; i <= hi; i++) set[dates[i]] = 1;
    return { set: set, anchor: anchor };
  }
  // Which week sits at the centre of the graph's horizontal viewport right now.
  function graphCenterWeek() {
    var main = document.querySelector(".hg-main");
    if (!main || !state.hgItems || !state.hgItems.length) return null;
    var mr = main.getBoundingClientRect(), cx = mr.left + mr.width / 2, best = null, bd = Infinity;
    state.hgItems.forEach(function (it) {
      var r = it.xc.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - cx);
      if (d < bd) { bd = d; best = it.date; }
    });
    return best;
  }
  function markHgCurrent() {
    if (!state.hgItems) return;
    state.hgItems.forEach(function (it) {
      var cur = it.date === state.selected;
      it.bar.classList.toggle("is-current", cur);
      it.xc.classList.toggle("is-current", cur);
    });
  }
  // Scrolling the graph horizontally re-centres everything on the week now in the
  // middle: move the selection + picker to it and rebuild the fly for that window,
  // WITHOUT re-scrolling the graph (the user is driving it).
  function syncFromGraphScroll() {
    if (state.hgSuppressUntil && Date.now() < state.hgSuppressUntil) return;   // programmatic recentre, not the user
    var wk = graphCenterWeek();
    if (!wk || wk === state.selected) return;
    state.selected = wk; state.heroMode = "auto"; state.armed = false;
    var idx = state.sundays ? state.sundays.indexOf(wk) : -1;
    if (idx >= 0) { state.cf.target = null; state.cf.vel = 0; state.cf.pos = idx; state.cfCenter = idx; cfStopRaf(); cfLayout(); }
    renderHeroBody();
    state.flyWin = computeFlyWindow(state.hgItems.map(function (it) { return it.date; }), state.selected);
    markHgCurrent();
    setupFly();
  }
  // ---- Scroll-scrubbed fly: as the calendar scrolls off the top, each week's
  // bar and date leave their calendar card and travel down into the graph.
  // A clone carries the visual; the real calendar contents fade out as they
  // "leave" and the real graph bars fade in as they arrive. Fully reversible.
  // natural (unscaled, shrink-wrapped) height of a calendar glyph, used as the
  // reference for how much to scale a clone so it lands at the graph label's size
  function natGlyphH(node) {
    var c = node.cloneNode(true);
    c.style.cssText = "position:absolute;left:-9999px;top:0;width:auto;height:auto;margin:0";
    document.body.appendChild(c);
    var h = c.getBoundingClientRect().height; c.remove();
    return h || 16;
  }
  // Build a clone that reproduces a calendar piece: sized to the source's LAYOUT
  // box and anchored at the layer origin (transform is set every frame).
  function flyClone(src, layer, extra) {
    var el = src.cloneNode(true);
    el.classList.add("hg-fly-clone");
    el.style.width = src.offsetWidth + "px"; el.style.height = src.offsetHeight + "px";
    el.style.boxSizing = "border-box"; el.style.margin = "0"; el.style.transformOrigin = "0 0";
    if (extra) for (var k in extra) el.style[k] = extra[k];
    layer.appendChild(el);
    return el;
  }
  function setupFly() {
    var layer = $("hgFlyLayer");
    if (!layer) { layer = document.createElement("div"); layer.id = "hgFlyLayer"; document.body.appendChild(layer); }
    // Detach any scroll animations left on the REAL calendar/graph elements from a
    // previous window (the clones themselves go with layer.innerHTML). Otherwise a
    // card that scrolls out of the fly window would stay faded / a graph bar hidden.
    if (state.fly && state.fly.animEls) state.fly.animEls.forEach(clearFlyAnim);
    layer.innerHTML = "";
    state.fly = null;
    var section = $("historyGraph"), cover = $("coverflow");
    if (prefersReduced() || !cover || !section || section.hidden || !state.hgItems || !state.hgItems.length) {
      if (CSS_SCROLL) flyStyleEl().textContent = "";
      return;
    }
    var groups = [];
    state.hgItems.forEach(function (it) {
      if (state.flyWin && !state.flyWin.set[it.date]) return;   // only the 8-week window flies
      var card = state.cardEls && state.cardEls[it.date];
      if (!card) return;                       // no source card in the picker → element just stays put
      var rec = recordFor(it.date); if (!rec) return;
      var calBar = card.querySelector(".cal-bar"), calDay = card.querySelector(".cal-day"), calTop = card.querySelector(".cal-top");
      // day & month: literal clones (identical font/size/colour). bar: a plain div
      // carrying the calendar bar's exact gradient + radius (avoids class clashes).
      var dayEl = flyClone(calDay, layer);
      // the month header only looks rounded because the CARD clips it; the detached
      // clone must carry the card's top-corner radius so it keeps that shape mid-air
      var cardR = getComputedStyle(card).borderTopLeftRadius;
      var monEl = flyClone(calTop, layer, {
        borderTopLeftRadius: cardR, borderTopRightRadius: cardR,
        borderBottomLeftRadius: "0", borderBottomRightRadius: "0"
      });
      var bcs = getComputedStyle(calBar);
      var barEl = flyClone(calBar, layer, { background: bcs.backgroundImage, borderRadius: bcs.borderRadius });
      var cardHW = card.offsetWidth / 2, cardHH = card.offsetHeight / 2;
      var pc = function (el, kind) {
        return { el: el, kind: kind, w: el.offsetWidth || 1, h: el.offsetHeight || 1, cardHW: cardHW, cardHH: cardHH,
                 offL: el === barEl ? calBar.offsetLeft : (kind === "day" ? calDay.offsetLeft : calTop.offsetLeft),
                 offT: el === barEl ? calBar.offsetTop : (kind === "day" ? calDay.offsetTop : calTop.offsetTop) };
      };
      var g = {
        it: it, date: it.date, card: card, calBar: calBar, calDay: calDay, calTop: calTop,
        cardHW: card.offsetWidth / 2, cardHH: card.offsetHeight / 2,
        day: pc(dayEl, "day"), mon: pc(monEl, "mon"), bar: pc(barEl, "bar")
      };
      g.day.natH = natGlyphH(calDay); g.mon.natH = natGlyphH(calTop);
      groups.push(g);
    });
    if (!groups.length) return;
    state.fly = { groups: groups, anchored: false, start: 0, endDown: 1, endUp: 1, assembled: false, centerDate: state.selected };
    refreshFlyAnchors();
    if (CSS_SCROLL) buildFlyAnimations(state.fly); else updateFly();
  }
  function docBox(el) {
    var r = el.getBoundingClientRect();
    return { cx: r.left + window.pageXOffset + r.width / 2, cy: r.top + window.pageYOffset + r.height / 2, w: r.width, h: r.height };
  }
  function refreshFlyAnchors() {
    var f = state.fly; if (!f) return;
    var sy = window.pageYOffset, vh = window.innerHeight;
    f.start = $("coverflow").getBoundingClientRect().top + sy - 154;           // begin the fly ~154px before the calendar reaches the top (start ≈ scroll 330)
    // Directional hysteresis: scrolling DOWN the fly completes when the graph
    // reaches ~33% viewport; once assembled it HOLDS, and scrolling back up it
    // doesn't start flying apart again until the graph drops to ~55%.
    var gTop = $("historyGraph").getBoundingClientRect().top + sy;
    f.endDown = gTop - vh * 0.33;
    f.endUp = gTop - vh * 0.55;
    if (f.endDown <= f.start) f.endDown = f.start + 1;
    if (f.endUp <= f.start) f.endUp = f.start + 1;
    f.maxScroll = document.documentElement.scrollHeight - vh;                  // cached so updateFly does no layout reads
    // the coverflow's exact 3D setup, so a clone's projection matches the card 1:1
    var cover = $("coverflow"), cr = cover.getBoundingClientRect(), ccs = getComputedStyle(cover);
    var po = ccs.perspectiveOrigin.split(" ").map(parseFloat);
    f.persp = parseFloat(ccs.perspective) || 760;
    f.P = new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / f.persp, 0, 0, 0, 1]);
    f.baseX = cr.left + window.pageXOffset + (po[0] || 0);   // document point the perspective/card centre maps to
    f.baseY = cr.top + window.pageYOffset + (po[1] || 0);
    f.groups.forEach(function (g) {
      var hgDayEl = g.it.xc.querySelector(".hg-day"), hgMonEl = g.it.xc.querySelector(".hg-mon");
      var tDay = docBox(hgDayEl), tMon = docBox(hgMonEl), tBar = docBox(g.it.bar);
      // Target scale = ratio of the two glyphs' NATURAL heights (measured the same
      // way = the font-size ratio), so the flown number ends the exact size of the
      // graph number. Using the graph element's own box height is wrong — it has
      // line-height:1, so it's smaller than the glyph and shrank the clone too far.
      // source centre = the real calendar piece; target centre = the graph piece;
      // the clone flies its centre in flat screen space (no perspective distortion).
      prepPiece(g.day, docBox(g.calDay), tDay, g.day.natH ? natGlyphH(hgDayEl) / g.day.natH : 1);
      prepPiece(g.mon, docBox(g.calTop), tMon, g.mon.natH ? natGlyphH(hgMonEl) / g.mon.natH : 1);
      prepPiece(g.bar, docBox(g.calBar), tBar, 1);
      g.bar.barTW = tBar.h;   // graph bar length (becomes vertical after the 90° roll)
      g.bar.barTH = tBar.w;   // graph bar thickness
    });
    f.anchored = true;
  }
  function prepPiece(pc, src, tgt, dstScale) {
    pc.offX = pc.offL - pc.cardHW; pc.offY = pc.offT - pc.cardHH;   // box top-left vs card centre
    pc.dstScale = dstScale;
    pc.CsrcX = src.cx; pc.CsrcY = src.cy;    // exact calendar centre
    pc.PtX = tgt.cx; pc.PtY = tgt.cy;        // graph centre
  }
  // Re-point the fly at the card currently centred in the coverflow. Returns true
  // (and rebuilds the clones) if the middle card changed since the fly was built.
  function retargetFlyToCenter() {
    if (!state.sundays || !state.hgItems || !state.hgItems.length) return false;
    var mid = state.sundays[clampPos(Math.round(state.cf.pos))];
    if (!mid) return false;
    if (state.selected === mid && state.fly && state.fly.centerDate === mid) return false;
    state.selected = mid;
    state.flyWin = computeFlyWindow(state.hgItems.map(function (it) { return it.date; }), mid);
    markHgCurrent();
    setupFly();   // rebuilds clones + re-anchors + renders for the new middle card
    return true;
  }
  // Progress is tied directly to scroll position (1:1, no lag). The clones live
  // in DOCUMENT space (absolute), so they scroll with the page on the compositor
  // and we only ever set transforms in document coordinates — no scroll-cancel
  // math, so the fly can't jitter against the content. rAF-throttled by the
  // scroll listener so it runs at most once a frame.
  function updateFly() {
    var f = state.fly; if (!f) return;
    var sy = window.pageYOffset;
    // Once assembled, hold longer on the way back (start flying apart at ~55%, not
    // the ~33% it landed at) — but keep the SAME animation span as the forward trip,
    // just shifted by the hold distance, so the clones travel at the same speed and
    // stay near the graph on the initial scroll-up (a shorter span made them jump).
    var gap = f.endDown - f.endUp;
    var s0 = f.assembled ? f.start - gap : f.start;
    var e0 = f.assembled ? f.endUp : f.endDown;
    var p = (sy - s0) / (e0 - s0);
    if (f.maxScroll != null && sy >= f.maxScroll - 1) p = 1;   // can't scroll further → fully assemble
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    // As the fly-down begins, always target whatever card is centred in the coverflow
    // RIGHT NOW — the picker may have been scrolled since the fly was last built, so
    // re-check its position and rebuild the window if the middle card changed.
    if (p > 0 && !f.assembled && !f.anchored && retargetFlyToCenter()) return;
    // Latch "assembled" the moment the fly visually completes (the 0.9985 handoff),
    // not at an exact p===1 the user rarely scrolls to — otherwise the latch never
    // engages and scrolling up flies back immediately using the down end-point.
    if (p >= 0.9985) f.assembled = true; else if (p <= 0) f.assembled = false;
    // Anchors are DOCUMENT positions — scroll-invariant — so they're measured once
    // in setupFly (and re-measured on resize / rebuild), never lazily here. Doing a
    // getBoundingClientRect pass at the fly-start frame forced a synchronous reflow
    // mid-momentum and dropped a frame — that was the jump.
    if (!f.anchored) refreshFlyAnchors();
    var active = p > 0.0015 && p < 0.9985;
    // Remap the morph so it reaches 0 / 1 EXACTLY at the handoff boundaries — that
    // way the clone sits precisely on the calendar tile / graph bar the instant it
    // swaps with the real element, so there's no last-pixel snap as it settles.
    var pm = p <= 0.0015 ? 0 : p >= 0.9985 ? 1 : (p - 0.0015) / (0.9985 - 0.0015);
    var eP = pm < 0.5 ? 2 * pm * pm : 1 - Math.pow(-2 * pm + 2, 2) / 2;   // easeInOut
    // hard handoffs so the user never sees double: originals vanish the instant
    // the clone takes over, and the real graph bars appear only once it lands.
    var shed = active || p >= 0.9985 ? 1 : 0;
    var appear = p >= 0.9985 ? 1 : 0;
    var vis = active ? "1" : "0";
    f.groups.forEach(function (g) {
      if (g.calBar) g.calBar.style.opacity = String(1 - shed);
      g.calDay.style.opacity = String(1 - shed);
      g.calTop.style.opacity = String(1 - shed);
      g.it.bar.style.opacity = String(appear);
      g.it.xc.style.opacity = String(appear);
      // Show/hide by OPACITY only — never display/visibility. Those repaint the 24
      // clones the frame they become visible (a paint burst that stalled the main
      // thread and dropped scroll frames — the jump). The clones stay painted into
      // their compositor layers (will-change: opacity), so toggling opacity is a
      // compositor-only change. Only written when the active state flips.
      if (g._active !== active) {
        g._active = active;
        g.day.el.style.opacity = vis; g.mon.el.style.opacity = vis; g.bar.el.style.opacity = vis;
      }
      if (!active) return;
      // Rebuild the card's EXACT projection at this progress: its rotateY, translateZ
      // and scale decay from the stored Cover Flow values to face-on/flat, while a
      // per-piece translate carries each piece from the card to its graph target.
      var src = (state.cardXform && state.cardXform[g.date]) || { x: 0, z: 0, ry: 0, scale: 1 };
      var ry = src.ry * (1 - eP), z = src.z * (1 - eP);
      // position tracks the scroll linearly (pm) so the clone stays in view and
      // glides down with the page; only the look (rotate/scale/roll) eases (eP).
      flyPiece(f, g, g.day, src, ry, z, eP, pm, null);
      flyPiece(f, g, g.mon, src, ry, z, eP, pm, null);
      flyPiece(f, g, g.bar, src, ry, z, eP, pm, eP);   // bar also rolls 90° + stretches
    });
  }
  // One reusable scratch matrix so the per-frame fly does ZERO allocations — the
  // old code newed ~6 DOMMatrix/DOMPoint per piece × 24 pieces every frame, and the
  // resulting garbage triggered a GC pause that dropped a scroll frame (the jump).
  var _fm = (typeof DOMMatrix !== "undefined") ? new DOMMatrix() : null;
  function flyIdentity(m) {
    m.m11 = 1; m.m12 = 0; m.m13 = 0; m.m14 = 0;
    m.m21 = 0; m.m22 = 1; m.m23 = 0; m.m24 = 0;
    m.m31 = 0; m.m32 = 0; m.m33 = 1; m.m34 = 0;
    m.m41 = 0; m.m42 = 0; m.m43 = 0; m.m44 = 1;
    return m;
  }
  function flyPiece(f, g, pc, src, ry, z, eP, lp, barMorph) {
    var sc = src.scale + (pc.dstScale - src.scale) * eP;
    // Build "inner" = Translate(base) · Perspective · Card(src.x,0,z,ry,sc) ·
    // Translate(off) [· bar roll/stretch] in the ONE scratch matrix via *Self (no
    // allocations). The perspective wraps only this local transform so it never
    // distorts; the graph-ward travel is a flat screen-space translate on top.
    var m = flyIdentity(_fm);
    m.translateSelf(f.baseX, f.baseY);
    m.multiplySelf(f.P);
    m.translateSelf(src.x, 0, z);
    m.rotateSelf(0, ry, 0);
    m.scaleSelf(sc, sc);
    m.translateSelf(pc.offX, pc.offY);
    if (barMorph != null) {
      var cx = pc.w / 2, cy = pc.h / 2;
      var w = pc.w + (pc.barTW - pc.w) * barMorph, h = pc.h + (pc.barTH - pc.h) * barMorph;
      m.translateSelf(cx, cy);
      m.rotateSelf(0, 0, 90 * barMorph);
      m.scaleSelf(w / pc.w, h / pc.h);
      m.translateSelf(-cx, -cy);
    }
    // project the piece centre through m by hand (no DOMPoint alloc)
    var lx = pc.w / 2, ly = pc.h / 2;
    var W = m.m14 * lx + m.m24 * ly + m.m44;
    var cx0 = (m.m11 * lx + m.m21 * ly + m.m41) / W;
    var cy0 = (m.m12 * lx + m.m22 * ly + m.m42) / W;
    // glide the centre linearly from the exact calendar centre to the graph centre;
    // the difference is a flat screen-space translate composed in front of matrix3d.
    var wantX = pc.CsrcX + (pc.PtX - pc.CsrcX) * lp, wantY = pc.CsrcY + (pc.PtY - pc.CsrcY) * lp;
    pc.el.style.transform = "translate(" + (wantX - cx0) + "px," + (wantY - cy0) + "px) " + m.toString();
  }

  // ---- Compositor fly: CSS scroll-driven animations -------------------------
  // The fly transform at any progress p is a pure function of the (already
  // measured) anchors, so we can bake it into @keyframes once and let the
  // COMPOSITOR interpolate them against the real scroll position. The main thread
  // then only flips the animation-range at the hysteresis latch — never per frame.
  var _flyUid = 0;
  function rnd(n, d) { var p = Math.pow(10, d); return Math.round(n * p) / p; }
  function flyStyleEl() {
    var s = document.getElementById("flyKeyframes");
    if (!s) { s = document.createElement("style"); s.id = "flyKeyframes"; document.head.appendChild(s); }
    return s;
  }
  // The full transform for one piece at progress p, expressed with NAMED transform
  // functions (perspective/translate3d/rotateY/scale/…) so CSS interpolates each
  // primitive as itself (angles as angles) between keyframes — matching flyPiece's
  // matrix EXACTLY at every sampled node. Structure is identical across a piece's
  // keyframes (bar always carries the roll suffix) so per-function interpolation
  // stays valid.
  function flySampleTransform(f, g, pc) {
    return function (p) {
      var pm = p <= 0.0015 ? 0 : p >= 0.9985 ? 1 : (p - 0.0015) / (0.9985 - 0.0015);
      var eP = pm < 0.5 ? 2 * pm * pm : 1 - Math.pow(-2 * pm + 2, 2) / 2;   // easeInOut
      var src = (state.cardXform && state.cardXform[g.date]) || { x: 0, z: 0, ry: 0, scale: 1 };
      var ry = src.ry * (1 - eP), z = src.z * (1 - eP);
      var sc = src.scale + (pc.dstScale - src.scale) * eP;
      var isBar = pc === g.bar;
      var m = flyIdentity(_fm);
      m.translateSelf(f.baseX, f.baseY);
      m.multiplySelf(f.P);
      m.translateSelf(src.x, 0, z);
      m.rotateSelf(0, ry, 0);
      m.scaleSelf(sc, sc);
      m.translateSelf(pc.offX, pc.offY);
      var bcx, bcy, bw, bh;
      if (isBar) {
        bcx = pc.w / 2; bcy = pc.h / 2;
        bw = pc.w + (pc.barTW - pc.w) * eP; bh = pc.h + (pc.barTH - pc.h) * eP;
        m.translateSelf(bcx, bcy);
        m.rotateSelf(0, 0, 90 * eP);
        m.scaleSelf(bw / pc.w, bh / pc.h);
        m.translateSelf(-bcx, -bcy);
      }
      var lx = pc.w / 2, ly = pc.h / 2;
      var W = m.m14 * lx + m.m24 * ly + m.m44;
      var cx0 = (m.m11 * lx + m.m21 * ly + m.m41) / W;
      var cy0 = (m.m12 * lx + m.m22 * ly + m.m42) / W;
      var wantX = pc.CsrcX + (pc.PtX - pc.CsrcX) * pm, wantY = pc.CsrcY + (pc.PtY - pc.CsrcY) * pm;
      var Lx = (wantX - cx0) + f.baseX, Ly = (wantY - cy0) + f.baseY;
      var s = "translate(" + rnd(Lx, 2) + "px," + rnd(Ly, 2) + "px) perspective(" + f.persp + "px) " +
        "translate3d(" + rnd(src.x, 2) + "px,0," + rnd(z, 2) + "px) rotateY(" + rnd(ry, 3) + "deg) scale(" + rnd(sc, 4) + ") " +
        "translate(" + rnd(pc.offX, 2) + "px," + rnd(pc.offY, 2) + "px)";
      if (isBar) {
        s += " translate(" + rnd(bcx, 2) + "px," + rnd(bcy, 2) + "px) rotateZ(" + rnd(90 * eP, 3) + "deg) " +
          "scale(" + rnd(bw / pc.w, 4) + "," + rnd(bh / pc.h, 4) + ") translate(" + rnd(-bcx, 2) + "px," + rnd(-bcy, 2) + "px)";
      }
      return s;
    };
  }
  var FLY_N = 24;   // transform samples per piece (denser near curvature is unneeded — nodes are exact)
  function flyKeyframesFor(name, sample) {
    // opacity baked in: clone hidden at both ends (real piece takes over), visible
    // across the middle — the exact 0.0015 / 0.9985 handoff the old fly used.
    var body = "0%{transform:" + sample(0) + ";opacity:0}0.15%{opacity:1}";
    for (var i = 1; i < FLY_N; i++) body += rnd(i / FLY_N * 100, 4) + "%{transform:" + sample(i / FLY_N) + "}";
    body += "99.85%{opacity:1}100%{transform:" + sample(1) + ";opacity:0}";
    return "@keyframes " + name + "{" + body + "}";
  }
  function flyRangeStr(f, assembled) {
    var gap = f.endDown - f.endUp;
    var s = assembled ? f.start - gap : f.start;
    var e = assembled ? f.endUp : f.endDown;
    if (f.maxScroll != null) { if (e > f.maxScroll) e = f.maxScroll; if (s > f.maxScroll) s = f.maxScroll; }
    if (s < 0) s = 0; if (e < s + 1) e = s + 1;
    return rnd(s, 2) + "px " + rnd(e, 2) + "px";
  }
  function attachFlyAnim(el, name, range) {
    if (!el) return;
    var st = el.style;
    st.animationName = name;
    st.animationDuration = "auto";
    st.animationTimingFunction = "linear";
    st.animationFillMode = "both";
    st.animationDirection = "normal";
    st.animationTimeline = FLY_TIMELINE;
    st.animationRange = range;
  }
  function clearFlyAnim(el) {
    if (!el) return;
    var st = el.style;
    st.animationName = ""; st.animationDuration = ""; st.animationTimingFunction = "";
    st.animationFillMode = ""; st.animationDirection = ""; st.animationTimeline = ""; st.animationRange = "";
    st.transform = "";   // drop any inline transform the rAF fallback may have left
    st.opacity = "";
  }
  function buildFlyAnimations(f) {
    // shared opacity rules: the real calendar pieces shed as the clone leaves; the
    // real graph bars only appear once the clone lands (both near-instant steps).
    var css = "@keyframes fly-shed{0%{opacity:1}0.15%{opacity:0}100%{opacity:0}}" +
      "@keyframes fly-appear{0%{opacity:0}99.85%{opacity:0}100%{opacity:1}}";
    // seed the latch from where we are: rebuilding while the graph is already
    // assembled (e.g. scrolling the graph horizontally) must keep the hold state.
    f.assembled = window.pageYOffset >= f.start + 0.9985 * (f.endDown - f.start);
    var range = flyRangeStr(f, f.assembled);
    var els = [];
    f.groups.forEach(function (g) {
      [g.day, g.mon, g.bar].forEach(function (pc) {
        var nm = "fly-tf-" + (++_flyUid);
        css += flyKeyframesFor(nm, flySampleTransform(f, g, pc));
        pc.el.style.transform = "";   // let the animation own transform
        attachFlyAnim(pc.el, nm, range);
        els.push(pc.el);
      });
      [g.calDay, g.calTop, g.calBar].forEach(function (el) { attachFlyAnim(el, "fly-shed", range); if (el) els.push(el); });
      [g.it.bar, g.it.xc].forEach(function (el) { attachFlyAnim(el, "fly-appear", range); if (el) els.push(el); });
    });
    flyStyleEl().textContent = css;
    f.animEls = els;
  }
  function applyFlyRange(f) {
    if (!f.animEls) return;
    var range = flyRangeStr(f, f.assembled);
    for (var i = 0; i < f.animEls.length; i++) f.animEls[i].style.animationRange = range;
  }
  // Directional hysteresis, compositor edition: the same scroll position maps to a
  // different progress depending on whether we're assembling or holding, which a
  // pure scroll timeline can't express — so at the two latch points (each of which
  // sits where progress is saturated at 0 or 1, so the swap is seamless) we shift
  // the animation-range. This is event-driven, not per-frame — the compositor draws
  // every in-between frame.
  function flyScrollLatch() {
    var f = state.fly; if (!f || !f.animEls) return;
    var sy = window.pageYOffset, gap = f.endDown - f.endUp;
    if (!f.assembled) {
      var fwdEnd = f.start + 0.9985 * (f.endDown - f.start);
      if (sy >= fwdEnd || (f.maxScroll != null && sy >= f.maxScroll - 1)) { f.assembled = true; applyFlyRange(f); }
    } else if (sy <= f.start - gap) {
      f.assembled = false; applyFlyRange(f);
    }
  }

  function renderBanner() {
    var b = $("banner");
    if (usingRemote()) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = "Saving to this browser only. Connect a Google Sheet in " +
      '<a id="bannerSettings">Settings</a> to sync everywhere.';
    var link = $("bannerSettings");
    if (link) link.onclick = function () { openSettings(); };
  }

  // -- Hero: the timeline is always shown; "editing" vs "recorded" only
  //    changes how it looks and whether the handles respond. --
  function renderHero() {
    if (!state.selected) state.selected = mostRecentSunday();
    // snap the cover flow to the selected week, then render the body
    if (state.sundays) {
      var idx = state.sundays.indexOf(state.selected);
      if (idx >= 0) { state.cf.target = null; state.cf.vel = 0; state.cf.pos = idx; state.cfCenter = idx; cfStopRaf(); }
      cfLayout();
    }
    renderHeroBody();
  }
  // Three views of a week:
  //  empty    — no record yet, not started: just the round record button.
  //  editing  — timeline is formed and draggable; the round button becomes ✓.
  //  recorded — a saved week shown read-only.
  function renderHeroBody() {
    var sel = state.selected, rec = recordFor(sel);
    var isEditing = (rec && state.heroMode === "edit") || (!rec && state.armed);
    var isEmpty = !rec && !isEditing;
    var isRecorded = rec && !isEditing;
    state.editing = isEditing;
    state.heroView = isEmpty ? "empty" : (isEditing ? "editing" : "recorded");

    var form = $("heroInput");
    form.classList.toggle("state-empty", isEmpty);
    form.classList.toggle("recorded", isRecorded);
    form.classList.toggle("editing", isEditing);
    form.classList.toggle("has-record", !!rec);   // gates the delete button

    setSlider(rec ? rec.start : cfg.startTarget, rec ? rec.end : cfg.endTarget);
    setHandlesInteractive(isEditing);

    var fab = $("recordFab");
    fab.classList.toggle("as-check", !isEmpty);   // ✓ when editing, drawn + otherwise
    $("fabGlyph").textContent = isEmpty ? "" : "✓";
    fab.setAttribute("aria-label", isEmpty ? "Record this week" : "Save");
    $("notesBtn").classList.toggle("has-note", !!$("notes").value);

    if (isRecorded) {
      $("recHead").hidden = false;
      $("recVerdict").textContent = verdict(analyze(rec));
      if (rec.notes) { $("recNotes").hidden = false; $("recNotes").textContent = "“" + rec.notes + "”"; }
      else { $("recNotes").hidden = true; }
    } else {
      $("recHead").hidden = true; $("recNotes").hidden = true;
    }
  }

  function prefersReduced() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  // record button loading animation: spinning clock → hands morph into + → stop.
  // Easter egg: the clock doesn't start at 12 — it starts at the actual system
  // time, then spins. A negative animation-delay offsets each hand's spin so it
  // *begins* at the current hour/minute angle (periods match the CSS: 7.2s / 0.6s).
  function startFabLoading() {
    var fab = $("recordFab");
    var now = new Date();
    var mins = now.getMinutes(), hrs = now.getHours() % 12;
    var minuteAngle = mins * 6;                  // 6° per minute
    var hourAngle = hrs * 30 + mins * 0.5;       // 30° per hour, plus the within-hour drift
    var hourEl = fab.querySelector(".fab-arm.hour");
    var minEl = fab.querySelector(".fab-arm.minute");
    hourEl.style.animationDelay = (-(hourAngle / 360) * 7.2).toFixed(3) + "s";
    minEl.style.animationDelay = (-(minuteAngle / 360) * 0.6).toFixed(3) + "s";
    fab.classList.add("loading");
  }
  function finishFabLoading() {
    var fab = $("recordFab");
    if (!fab.classList.contains("loading")) return;
    var hour = fab.querySelector(".fab-arm.hour");
    var minute = fab.querySelector(".fab-arm.minute");
    // read each hand's live angle so its spin-down continues without a jump
    function angleOf(el) {
      var m = new DOMMatrix(getComputedStyle(el).transform);
      return Math.atan2(m.b, m.a) * 180 / Math.PI;
    }
    var hStart = angleOf(hour), mStart = angleOf(minute);
    fab.classList.remove("loading");
    fab.classList.add("settling");           // arms grow their other half → full + strokes
    if (prefersReduced()) {
      fab.classList.remove("settling");
      hour.style.transform = ""; minute.style.transform = "";
      hour.style.animationDelay = ""; minute.style.animationDelay = "";
      return;
    }
    hour.style.animation = "none"; minute.style.animation = "none";
    // each hand keeps its own speed for P1, then eases to a stop forming the +.
    // minute lands horizontal (≡90° mod 180), hour lands vertical (≡0° mod 180),
    // so they're perpendicular and match the rest state seamlessly on clear.
    var P1 = 300, P2 = 700, mSpeed = 600, hSpeed = 50;  // deg/s, matching the CSS (12:1)
    var mMid = mStart + mSpeed * (P1 / 1000);
    var hMid = hStart + hSpeed * (P1 / 1000);
    var mTarget = Math.round((mMid - 90) / 180) * 180 + 90;
    if (mTarget < mMid) mTarget += 180;                 // always finish forward
    var hTarget = Math.round(hMid / 180) * 180;         // nearest vertical to its momentum
    function ease(a, b, p) { return a + (b - a) * (1 - Math.pow(1 - p, 2)); }
    var t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var t = ts - t0, hd, md;
      if (t <= P1) { hd = hStart + hSpeed * (t / 1000); md = mStart + mSpeed * (t / 1000); }
      else if (t <= P1 + P2) { var p = (t - P1) / P2; hd = ease(hMid, hTarget, p); md = ease(mMid, mTarget, p); }
      else {
        fab.classList.remove("settling");
        hour.style.transform = ""; minute.style.transform = "";
        hour.style.animation = ""; minute.style.animation = "";
        hour.style.animationDelay = ""; minute.style.animationDelay = "";
        return;
      }
      hour.style.transform = "rotate(" + hd + "deg)";
      minute.style.transform = "rotate(" + md + "deg)";
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // tap the record button on an empty week → the whole timeline (lane, ticks,
  // handles, fill, axis labels) unfolds outward from the centre button, which
  // stays put and morphs + → ✓.
  function armAndForm() {
    state.armed = true; state.heroMode = "auto"; $("notes").value = "";
    if (prefersReduced()) { renderHeroBody(); return; }
    var tl = document.querySelector(".timeline");
    tl.classList.add("forming");     // enable the unfold transitions
    void tl.offsetWidth;             // make sure they're live before the state flips
    renderHeroBody();                // drops .state-empty → everything animates out from centre
    slideAxisLabels();               // slide the time labels out from the centre
    setTimeout(function () { tl.classList.remove("forming"); }, 840);
  }
  // On launch, an already-recorded week just popped in fully formed while the
  // empty state got the spinning-clock → + reveal. Give the recorded timeline the
  // same unfold: fold it back to the centre for one frame, then let it animate
  // outward under .forming — the verdict fades in alongside. Runs once.
  var _launchRevealed = false;
  function maybeRevealOnLaunch() {
    if (_launchRevealed) return;
    _launchRevealed = true;
    if (prefersReduced()) return;
    if ($("heroInput").classList.contains("state-empty")) return;   // empty week keeps its own reveal
    revealTimeline();
  }
  function revealTimeline() {
    var tl = document.querySelector(".timeline");
    if (!tl) return;
    tl.classList.add("reveal-start");     // fold to the centre (committed as the start frame)
    void tl.offsetWidth;
    tl.classList.add("forming");          // enable the unfold transitions
    void tl.offsetWidth;
    tl.classList.remove("reveal-start");  // → handles / fill / flags / duration animate outward
    slideAxisLabels();
    var head = $("recHead");              // fade the verdict + pencil in with the timeline
    if (head && !head.hidden) {
      head.style.transition = "none"; head.style.opacity = "0";
      void head.offsetWidth;
      head.style.transition = "opacity .5s ease .2s"; head.style.opacity = "1";
      setTimeout(function () { head.style.transition = ""; head.style.opacity = ""; }, 820);
    }
    setTimeout(function () { tl.classList.remove("forming"); }, 840);
  }
  // Slide each axis label from the centre to its position at a constant speed,
  // so the outer labels (farther to travel) finish last.
  function slideAxisLabels() {
    var axis = document.querySelector(".tl-axis"), labels = axis.children, n = labels.length;
    var w = axis.getBoundingClientRect().width;
    if (!w || n < 2) return;
    var MAX = 0.7, half = 0.5 * w, i, el, offset;
    for (i = 0; i < n; i++) {           // collapse every label to the centre, no transition
      offset = (0.5 - i / (n - 1)) * w;
      el = labels[i];
      el.style.transition = "none";
      el.style.transform = "translateX(" + offset + "px)";
    }
    void axis.offsetWidth;              // reflow so this is the starting frame
    for (i = 0; i < n; i++) {           // slide back to place; duration ∝ distance ⇒ same speed.
      offset = (0.5 - i / (n - 1)) * w; // easing matches the line background so they settle together
      var dur = Math.max(0.001, MAX * (Math.abs(offset) / half));
      el = labels[i];
      el.style.transition = "transform " + dur + "s cubic-bezier(.5,0,.2,1)";
      el.style.transform = "translateX(0)";
    }
    setTimeout(function () {
      for (var k = 0; k < labels.length; k++) { labels[k].style.transition = ""; labels[k].style.transform = ""; }
    }, MAX * 1000 + 80);
  }
  function cancelEdit() {
    if (recordFor(state.selected)) state.heroMode = "auto"; // back to the recorded view
    else state.armed = false;                                // discard a not-yet-saved week
    renderHeroBody();
  }
  function openNotesModal() {
    $("notesText").value = $("notes").value;
    $("notesDialog").showModal();
    setTimeout(function () { $("notesText").focus(); }, 30);
  }
  function commitNote() {
    $("notes").value = $("notesText").value.trim();
    $("notesBtn").classList.toggle("has-note", !!$("notes").value);
    $("notesDialog").close();
  }
  // lift the + so it sits exactly on the timeline line in the empty state
  function positionFab() {
    var track = $("tlTrack"), cluster = document.querySelector(".tl-cluster");
    if (!track || !cluster) return;
    var tr = track.getBoundingClientRect(), cr = cluster.getBoundingClientRect();
    if (!tr.height) return;
    cluster.style.setProperty("--fab-lift", ((tr.top + tr.height / 2) - cr.top) + "px");
  }
  function saveHero() {
    var existing = recordFor(state.selected);
    var rec = { id: existing ? existing.id : "", date: state.selected, start: $("start").value, end: $("end").value, notes: $("notes").value.trim() };
    if (!rec.date || !rec.start || !rec.end) { toast("Set the times"); return; }
    var fab = $("recordFab"); fab.disabled = true;
    // the ✓ turns back into the spinning clock while the save is in flight
    var animate = !prefersReduced();
    if (animate) { fab.classList.remove("as-check"); startFabLoading(); }
    var op = rec.id ? updateRecord(rec) : addRecord(rec);
    op.then(function () {
      // stop the clock the instant the record lands, and slide it into the pencil
      state.heroMode = "auto"; state.armed = false;
      fab.classList.remove("loading", "settling"); fab.disabled = false;
      var fromRect = animate ? fab.getBoundingClientRect() : null;   // ✓ position
      renderAll();   // → recorded view: verdict comment appears on the ✓'s line
      if (animate) flipEditIn(fromRect);   // ✓ slides sideways and becomes the edit pencil
      if (usingRemote()) syncInBackground();
    }).catch(function (err) {
      fab.classList.remove("loading", "settling"); fab.disabled = false;
      renderHeroBody();   // restore the ✓ so the user can retry
      toast("Error: " + err.message);
    });
  }
  // FLIP: glide the edit pencil in from where the ✓ was, so the check appears to
  // slide right and become the edit button rather than vanishing.
  function flipEditIn(fromRect) {
    if (!fromRect) return;
    var btn = $("recEditBtn"), to = btn.getBoundingClientRect();
    // horizontal only — the pencil sits on the same line the ✓ did
    var dx = (fromRect.left + fromRect.width / 2) - (to.left + to.width / 2);
    if (!isFinite(dx) || Math.abs(dx) < 1) return;
    btn.style.transition = "none";
    btn.style.transform = "translateX(" + dx + "px)";
    void btn.offsetWidth;                 // commit the start position
    btn.style.transition = "transform .5s cubic-bezier(.4,0,.2,1)";
    btn.style.transform = "translateX(0)";
    var clear = function () { btn.style.transition = ""; btn.style.transform = ""; btn.removeEventListener("transitionend", clear); };
    btn.addEventListener("transitionend", clear);
  }
  function setHandlesInteractive(on) {
    [$("tlStart"), $("tlEnd")].forEach(function (h) {
      h.tabIndex = on ? 0 : -1;
      h.setAttribute("aria-readonly", on ? "false" : "true");
    });
  }
  var WINS = ["Right on time.", "On the dot.", "Perfect week.", "Nailed it.", "Textbook."];
  function verdict(a) {
    if (a.success) return WINS[(a.startMin + a.endMin) % WINS.length];
    if (!a.startOnTime && !a.endOnTime) return "Late start and ran long.";
    if (!a.startOnTime) return "Started a bit late.";
    return "Ran a little long.";
  }

  function renderStats() {
    var s = computeStats();
    $("statStreak").textContent = s.current;
    $("statStreakSub").textContent = s.current === 1 ? "week on time" : "weeks on time";
    $("statLongest").textContent = s.longest;
    $("statRate").textContent = s.rate == null ? "—" : s.rate + "%";
    $("statRateSub").textContent = s.total ? s.successes + " of " + s.total + " weeks" : "start & end on time";
    $("statWeeks").textContent = s.total;
    $("statSince").textContent = s.firstDate ? "since " + shortDate(s.firstDate) : "let's begin";
  }

  function renderGoal() {
    var s = computeStats(), goal = cfg.goal;
    $("goalTarget").textContent = goal + "-week on-time streak";
    var pct = goal ? Math.min(100, Math.round((s.current / goal) * 100)) : 0;
    $("goalRing").style.setProperty("--deg", (pct * 3.6) + "deg");
    $("ringPct").textContent = pct + "%";

    var msg = $("goalMsg");
    if (s.total === 0) msg.innerHTML = "Log your first week to get started.";
    else if (s.current >= goal) msg.innerHTML = "<strong>Goal reached.</strong> You're on a " + s.current + "-week on-time streak — keep it going.";
    else {
      var togo = goal - s.current;
      msg.innerHTML = "<strong>" + togo + " more on-time week" + (togo === 1 ? "" : "s") + "</strong> to hit your goal. " + weakSpot(s);
    }

    var grid = $("insightGrid");
    if (s.total === 0) { grid.hidden = true; return; }
    grid.hidden = false;
    $("insStart").textContent = devText(s.avgStartDev); $("insStart").style.color = colorFor(s.avgStartDev);
    $("insEnd").textContent = devText(s.avgEndDev); $("insEnd").style.color = colorFor(s.avgEndDev);
    $("insStartLate").textContent = s.startLate + " / " + s.total;
    $("insEndLate").textContent = s.endLate + " / " + s.total;
  }
  function weakSpot(s) {
    if (s.startLate === 0 && s.endLate === 0) return "You're on time — just keep the streak alive.";
    if (s.endLate > s.startLate) return "Running long is the main snag — late finish on " + s.endLate + " of " + s.total + " weeks.";
    if (s.startLate > s.endLate) return "Starting late is the main snag — on " + s.startLate + " of " + s.total + " weeks.";
    return "Start and finish run late about equally often.";
  }
  function devText(mins) { if (mins == null) return "—"; var r = Math.round(mins); if (r === 0) return "on time"; return (r > 0 ? "+" : "") + r + " min"; }
  function colorFor(mins) { if (mins == null) return ""; return mins > 0.5 ? "var(--late)" : "var(--ok)"; }

  function renderStrip() {
    var recs = sortedRecords().slice(-14), card = $("stripCard");
    if (recs.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    var strip = $("strip"); strip.innerHTML = "";
    recs.forEach(function (r) {
      var a = analyze(r);
      var cls = a.success ? "ok" : (a.partial ? "partial" : "late");
      var cell = document.createElement("button");
      cell.type = "button"; cell.className = "cell " + cls;
      cell.textContent = a.success ? "✓" : (a.partial ? "~" : "✕");
      cell.title = shortDate(r.date) + " · start " + fmt12(r.start) + " (" + deltaLabel(a.startDev) + "), end " + fmt12(r.end) + " (" + deltaLabel(a.endDev) + ")";
      cell.onclick = function () { goToWeek(r.date); };
      strip.appendChild(cell);
    });
  }

  function renderHistory() {
    var host = $("history"); host.innerHTML = "";
    if (state.loading) { host.innerHTML = '<p class="empty">Loading…</p>'; return; }
    var recs = sortedRecords().reverse();
    if (recs.length === 0) { host.innerHTML = '<p class="empty">No weeks logged yet — add your first one up top.</p>'; return; }
    recs.forEach(function (r) {
      var a = analyze(r);
      var el = document.createElement("div"); el.className = "entry";
      var d = document.createElement("div"); d.className = "entry-date"; d.innerHTML = weekdayDate(r.date);
      var mid = document.createElement("div");
      var times = document.createElement("div"); times.className = "entry-times";
      times.appendChild(pill("Start " + fmt12(r.start), a.startOnTime, a.startDev));
      times.appendChild(pill("End " + fmt12(r.end), a.endOnTime, a.endDev));
      mid.appendChild(times);
      if (r.notes) { var nt = document.createElement("div"); nt.className = "entry-notes"; nt.textContent = r.notes; mid.appendChild(nt); }
      var actions = document.createElement("div"); actions.className = "entry-actions";
      actions.appendChild(miniBtn("✎", "Edit", function () { goToWeek(r.date); state.heroMode = "edit"; $("notes").value = r.notes || ""; renderHeroBody(); scrollToHero(); }));
      actions.appendChild(miniBtn("✕", "Delete", function () { confirmDelete(r); }));
      el.appendChild(d); el.appendChild(mid); el.appendChild(actions);
      host.appendChild(el);
    });
  }
  function pill(text, onTime, dev) {
    var p = document.createElement("span"); p.className = "pill " + (onTime ? "ok" : "late");
    p.textContent = text; p.title = deltaLabel(dev); return p;
  }
  function miniBtn(label, title, fn) {
    var b = document.createElement("button"); b.type = "button"; b.className = "mini-btn";
    b.textContent = label; b.title = title; b.onclick = fn; return b;
  }

  // ---- Hero interactions ----------------------------------------------------
  function goToWeek(date) { state.selected = date; state.heroMode = "auto"; renderHero(); }
  function scrollToHero() { document.querySelector(".hero").scrollIntoView({ behavior: "smooth", block: "start" }); }

  // ---- Cover Flow date picker (drag + kinetic momentum) ---------------------
  var CF_RANGE = 104;      // Sundays of history to make available (~2 years)
  var CF_WINDOW = 6;       // how many cards fan out on each side of centre
  var CF_STEP = 64;        // px of drag that advances one card
  var CF_FRICTION = 0.93;  // momentum decay per frame

  function buildCoverflow() {
    var track = $("cfTrack"); track.innerHTML = "";
    state.sundays = []; state.cardEls = {};
    var today = mostRecentSunday();
    for (var i = CF_RANGE; i >= 0; i--) {         // oldest → today (ascending)
      var dt = addDays(today, -7 * i);
      state.sundays.push(dt);
      var el = calCard(dt);
      track.appendChild(el);
      state.cardEls[dt] = el;
    }
    state.cf.pos = state.sundays.length - 1;      // start on today
  }
  function calCard(dateStr) {
    var d = parseYMD(dateStr);
    var el = document.createElement("button");
    el.type = "button"; el.className = "cal"; el.setAttribute("data-date", dateStr);
    el.setAttribute("aria-label", MON[d.getMonth()] + " " + d.getDate());
    el.innerHTML = '<span class="cal-top">' + MON[d.getMonth()].toUpperCase() + '</span>' +
      '<span class="cal-day">' + d.getDate() + '</span><span class="cal-bar"></span>';
    el.addEventListener("click", function () {
      if (state.cf.moved) return;                 // was a drag, not a tap
      var idx = state.sundays.indexOf(dateStr);
      if (idx >= 0) animateTo(idx);
    });
    return el;
  }

  function cfMax() { return state.sundays.length - 1; }
  function clampPos(p) { return Math.max(0, Math.min(cfMax(), p)); }

  // Lay out every card from the fractional scroll position — smooth through 0
  // so the fan animates continuously as you drag.
  function cfLayout() {
    if (!state.sundays) return;
    var pos = state.cf.pos, center = Math.round(clampPos(pos));
    for (var i = 0; i < state.sundays.length; i++) {
      applyCard(state.cardEls[state.sundays[i]], i - pos, i === center, state.sundays[i]);
    }
  }
  // Centre card 1.25×, then each further card is smaller than the one before it
  // by a shrinking step (25%, 20%, 15%, 10%, 5%) — so it shrinks fast near the
  // centre and levels off, keeping far cards visible. Interpolated for dragging.
  var CF_SCALES = [1.25, 0.9375, 0.75, 0.6375, 0.57375, 0.545];
  function cardScale(ao) {
    var last = CF_SCALES.length - 1;
    if (ao >= last) return CF_SCALES[last];
    var i = Math.floor(ao);
    return CF_SCALES[i] + (CF_SCALES[i + 1] - CF_SCALES[i]) * (ao - i);
  }
  // Cumulative horizontal offset (px) of each card from centre. The gap between
  // successive cards shrinks going outward (50, 34, 26, 20, 15, 11) so far cards
  // pack a little tighter instead of drifting off on a constant step, without
  // crowding them together. Interpolated so dragging stays smooth.
  var CF_X = [0, 50, 84, 110, 130, 145, 156];
  function cardX(ao) {
    var last = CF_X.length - 1;
    if (ao >= last) return CF_X[last];
    var i = Math.floor(ao);
    return CF_X[i] + (CF_X[i + 1] - CF_X[i]) * (ao - i);
  }
  function applyCard(el, o, isCenter, dateStr) {
    var ao = Math.abs(o), s = o < 0 ? -1 : 1;
    if (ao > CF_WINDOW + 0.5) {
      // Park off-window cards AT the window edge (not off-screen) and hide them.
      // iOS Safari doesn't clip 3D-transformed children with overflow:hidden, so
      // a big translateX here would let the page pan sideways — keep them inside.
      el.style.opacity = "0"; el.style.pointerEvents = "none"; el.style.zIndex = "0";
      el.style.visibility = "hidden";
      el.style.transform = "translateX(" + (s * cardX(CF_WINDOW)) + "px) scale(" + cardScale(ao) + ")";
      (state.cardXform || (state.cardXform = {}))[dateStr] = { x: s * cardX(CF_WINDOW), z: 0, ry: 0, scale: cardScale(ao) };
      el.classList.remove("is-center"); setDot(el, dateStr); return;
    }
    var cl = Math.min(ao, 1);
    var x = s * cardX(ao);
    // tilt ramps progressively: 0° at centre → 60° at the first neighbour → 90°
    // (edge-on) at the farthest card
    var deg = ao <= 1 ? 60 * ao : 60 + 30 * Math.min(1, (ao - 1) / (CF_WINDOW - 1));
    var tz = (1 - cl) * 52, ry = -s * deg, sc = cardScale(ao);
    // remember the EXACT transform components so the history fly can rebuild the
    // card's real projection matrix (no guessing) when a clone leaves this card
    (state.cardXform || (state.cardXform = {}))[dateStr] = { x: x, z: tz, ry: ry, scale: sc };
    var transform = "translateX(" + x + "px) translateZ(" + tz + "px) " +
      "rotateY(" + ry + "deg) scale(" + sc + ")";
    el.style.visibility = "visible";
    el.style.transform = transform;
    el.style.opacity = String(ao <= 1 ? 1 : Math.max(0, 1 - (ao - 1) * 0.13));
    el.style.zIndex = String(1000 - Math.round(ao * 10));
    el.style.pointerEvents = "auto";
    el.classList.toggle("is-center", isCenter);
    setDot(el, dateStr);
  }
  // The card's status bar mirrors the timeline's start→end gradient for that week.
  function setDot(el, dateStr) {
    var bar = el.querySelector(".cal-bar"), rec = recordFor(dateStr);
    if (rec) {
      var a = analyze(rec);
      var cs = lateColor(a.startDev), ce = lateColor(a.endDev);
      bar.style.background = "linear-gradient(90deg, " + cs + ", " + ce + ")";
    } else bar.style.background = "transparent";
  }

  // rAF engine: free momentum until slow, then ease-snap to the nearest card.
  function cfEnsureRaf() { if (!state.cf.raf) state.cf.raf = requestAnimationFrame(cfTick); }
  function cfStopRaf() { if (state.cf.raf) { cancelAnimationFrame(state.cf.raf); state.cf.raf = null; } }
  function cfTick() {
    var cf = state.cf;
    if (cf.dragging) { cf.raf = null; return; }
    if (cf.target != null) {
      cf.pos += (cf.target - cf.pos) * 0.2;
      if (Math.abs(cf.target - cf.pos) < 0.003) { cf.pos = cf.target; cf.target = null; cf.vel = 0; cfLayout(); cfSyncCenter(); renderHistoryGraph(); cf.raf = null; return; }
    } else {
      cf.pos += cf.vel; cf.vel *= CF_FRICTION;
      if (cf.pos < 0) { cf.pos = 0; cf.vel = 0; } else if (cf.pos > cfMax()) { cf.pos = cfMax(); cf.vel = 0; }
      if (Math.abs(cf.vel) < 0.02) cf.target = clampPos(Math.round(cf.pos)); // begin snap
    }
    cfLayout();
    cfSyncCenter();
    cf.raf = requestAnimationFrame(cfTick);
  }
  // Push the centred week into the hero as soon as it changes, so the timeline
  // updates live while scrolling — not only after the flow settles.
  function cfSyncCenter() {
    var ci = clampPos(Math.round(state.cf.pos));
    if (ci === state.cfCenter) return;
    state.cfCenter = ci;
    haptic();                                     // tick as each week snaps under centre
    state.selected = state.sundays[ci];
    state.armed = false; state.heroMode = "auto"; // moving to a new week resets edit state
    renderHeroBody();
  }
  function animateTo(idx) { state.heroMode = "auto"; state.cf.target = clampPos(idx); state.cf.vel = 0; cfEnsureRaf(); }

  function cfDown(e) {
    var cf = state.cf; cfStopRaf();
    cf.dragging = true; cf.target = null; cf.vel = 0; cf.moved = false;
    cf.startX = e.clientX; cf.startPos = cf.pos; cf.lastX = e.clientX; cf.vpx = 0;
    state.heroMode = "auto";
  }
  function cfMove(e) {
    var cf = state.cf; if (!cf.dragging) return;
    var dx = e.clientX - cf.startX;
    if (Math.abs(dx) > 5) cf.moved = true;
    cf.pos = clampPos(cf.startPos - dx / CF_STEP);
    cf.vpx = e.clientX - cf.lastX; cf.lastX = e.clientX;
    cfLayout();
    cfSyncCenter();
  }
  function cfUp() {
    var cf = state.cf; if (!cf.dragging) return;
    cf.dragging = false;
    if (!cf.moved) { cf.target = clampPos(Math.round(cf.pos)); cfEnsureRaf(); return; }
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { cf.pos = clampPos(Math.round(cf.pos)); cfLayout(); cfSyncCenter(); return; }
    cf.vel = -cf.vpx / CF_STEP;   // carry the flick into momentum
    cfEnsureRaf();
  }

  // ---- Timeline slider ------------------------------------------------------
  // Continuous colour for how late an end is, stepping per minute along
  // green → yellow (3 min) → orange (6 min) → red (10 min, then held). Anchors
  // are read from the CSS variables so the scale follows the light/dark theme.
  var STOPS = null;
  function parseColor(str) {
    str = (str || "").trim();
    if (str.charAt(0) === "#") {
      var h = str.slice(1);
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      var n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    var m = str.match(/(\d+)\D+(\d+)\D+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
  }
  function loadStops() {
    var cs = getComputedStyle(document.documentElement);
    STOPS = [
      { m: 0, c: parseColor(cs.getPropertyValue("--c-ok")) },
      { m: 3, c: parseColor(cs.getPropertyValue("--c-yellow")) },
      { m: 6, c: parseColor(cs.getPropertyValue("--c-orange")) },
      { m: 10, c: parseColor(cs.getPropertyValue("--c-red")) },
    ];
  }
  function lateColor(dev) {
    if (!STOPS) loadStops();
    if (dev == null || dev <= 0) return rgb(STOPS[0].c);
    for (var i = 1; i < STOPS.length; i++) {
      if (dev <= STOPS[i].m) {
        var t = (dev - STOPS[i - 1].m) / (STOPS[i].m - STOPS[i - 1].m);
        // ease the first (green→yellow) segment so even 1 minute late leaves
        // green and reads yellow, while still hitting full yellow at 3 min
        if (i === 1) t = Math.pow(t, 0.28);
        return rgb(mixColor(STOPS[i - 1].c, STOPS[i].c, t));
      }
    }
    return rgb(STOPS[STOPS.length - 1].c);
  }
  function mixColor(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function rgb(c) { return "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")"; }
  // rotate a handle's clock hands to the time it represents
  function setClock(el, minutes) {
    var hh = Math.floor(minutes / 60), mm = minutes % 60;
    el.style.setProperty("--m", (mm * 6) + "deg");            // 6° per minute
    el.style.setProperty("--h", (((hh % 12) + mm / 60) * 30) + "deg"); // 30° per hour
  }
  function setSlider(startHHMM, endHHMM) {
    var s = clamp(toMin(startHHMM) != null ? toMin(startHHMM) : START_TARGET, AXIS_START, AXIS_END);
    var e = clamp(toMin(endHHMM) != null ? toMin(endHHMM) : END_TARGET, AXIS_START, AXIS_END);
    if (e < s + MIN_GAP) e = Math.min(AXIS_END, s + MIN_GAP);
    state.slider = { start: s, end: e };
    renderTimeline();
  }
  function setHandle(which, m) {
    if (!state.slider) return;
    var before = which === "start" ? state.slider.start : state.slider.end;
    if (which === "start") state.slider.start = clamp(m, AXIS_START, state.slider.end - MIN_GAP);
    else state.slider.end = clamp(m, state.slider.start + MIN_GAP, AXIS_END);
    if ((which === "start" ? state.slider.start : state.slider.end) !== before) haptic();  // tick per minute
    renderTimeline();
  }
  function renderTimeline() {
    var sl = state.slider; if (!sl) return;
    var sHHMM = minToHHMM(sl.start), eHHMM = minToHHMM(sl.end);
    var a = analyze({ start: sHHMM, end: eHHMM });
    var sp = pctOf(sl.start), ep = pctOf(sl.end);

    $("tlStart").style.left = sp + "%";
    $("tlEnd").style.left = ep + "%";
    $("tlFill").style.left = sp + "%";
    $("tlFill").style.width = (ep - sp) + "%";

    // colour each end by how late it is, and blend the fill between them
    var cs = lateColor(a.startDev), ce = lateColor(a.endDev);
    $("tlFill").style.background = "linear-gradient(90deg, " + cs + ", " + ce + ")";
    $("tlStart").style.setProperty("--hc", cs);
    $("tlEnd").style.setProperty("--hc", ce);
    setClock($("tlStart"), sl.start);
    setClock($("tlEnd"), sl.end);

    $("startValue").textContent = fmt12(sHHMM);
    $("endValue").textContent = fmt12(eHHMM);

    var dur = sl.end - sl.start;
    $("tlDuration").textContent = dur + (dur === 1 ? " minute" : " minutes");   // CSS renders it small-caps
    $("tlDuration").style.left = ((sp + ep) / 2) + "%";   // ride the midpoint between the two handles

    setSliderAria($("tlStart"), sl.start, "start");
    setSliderAria($("tlEnd"), sl.end, "end");

    // keep the hidden inputs (read by save/validation) in sync
    $("start").value = sHHMM;
    $("end").value = eHHMM;
  }
  function setSliderAria(el, min, which) {
    el.setAttribute("aria-valuemin", which === "start" ? AXIS_START : AXIS_START + MIN_GAP);
    el.setAttribute("aria-valuemax", which === "start" ? AXIS_END - MIN_GAP : AXIS_END);
    el.setAttribute("aria-valuenow", String(min));
    el.setAttribute("aria-valuetext", fmt12(minToHHMM(min)) + (
      which === "start" ? (min <= START_TARGET ? " (on time)" : " (late)") : (min <= END_TARGET ? " (on time)" : " (late)")));
  }
  function minFromClientX(clientX) {
    var rect = $("tlTrack").getBoundingClientRect();
    if (!rect.width) return null;
    return Math.round(AXIS_START + ((clientX - rect.left) / rect.width) * AXIS_SPAN);
  }
  function onTimelinePointerDown(ev) {
    if (!state.editing || ev.target === $("recordFab")) return;
    var m = minFromClientX(ev.clientX); if (m == null) return;
    var which;
    if (ev.target === $("tlStart") || $("tlStart").contains(ev.target)) which = "start";
    else if (ev.target === $("tlEnd") || $("tlEnd").contains(ev.target)) which = "end";
    else which = Math.abs(m - state.slider.start) <= Math.abs(m - state.slider.end) ? "start" : "end";
    state.dragging = which;
    (which === "start" ? $("tlStart") : $("tlEnd")).focus();
    setHandle(which, m);
    ev.preventDefault();
  }
  function onTimelineKey(which, ev) {
    if (!state.slider || !state.editing) return;
    var cur = which === "start" ? state.slider.start : state.slider.end;
    var big = ev.shiftKey ? 5 : 1;
    switch (ev.key) {
      case "ArrowLeft": case "ArrowDown": setHandle(which, cur - big); break;
      case "ArrowRight": case "ArrowUp": setHandle(which, cur + big); break;
      case "PageDown": setHandle(which, cur - 5); break;
      case "PageUp": setHandle(which, cur + 5); break;
      case "Home": setHandle(which, which === "start" ? AXIS_START : state.slider.start + MIN_GAP); break;
      case "End": setHandle(which, which === "start" ? state.slider.end - MIN_GAP : AXIS_END); break;
      default: return;
    }
    ev.preventDefault();
  }

  function confirmDelete(r) {
    if (!window.confirm("Delete the entry for " + shortDate(r.date) + "?")) return;
    deleteRecord(r.id).then(function () {
      state.heroMode = "auto"; state.armed = false; renderAll();
      if (usingRemote()) syncInBackground();
    }).catch(function (err) { toast("Error: " + err.message); });
  }

  // ---- Settings -------------------------------------------------------------
  function openSettings() {
    $("cfgUrl").value = cfg.url; $("cfgToken").value = cfg.token; $("cfgGoal").value = cfg.goal;
    setCfgStatus("", ""); $("settingsDialog").showModal();
  }
  function setCfgStatus(msg, cls) { var el = $("cfgStatus"); el.textContent = msg; el.className = "cfg-status " + (cls || ""); }
  function testConnection() {
    var url = $("cfgUrl").value.trim();
    if (!url) { setCfgStatus("No URL — the app will save to this browser only.", ""); return; }
    setCfgStatus("Testing…", "");
    var tok = $("cfgToken").value.trim();
    var q = url + (url.indexOf("?") >= 0 ? "&" : "?") + "action=list" + (tok ? "&token=" + encodeURIComponent(tok) : "");
    fetch(q, { method: "GET" }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok !== false) {
        var count = (data.records || []).length;
        setCfgStatus("✓ Connected — " + count + " week" + (count === 1 ? "" : "s") + " found.", "ok");
      } else setCfgStatus("✕ " + ((data && data.error) || "Unexpected response."), "late");
    }).catch(function () {
      setCfgStatus("✕ Could not reach the Web App. Check the URL and that access is \"Anyone\".", "late");
    });
  }
  function saveSettings() {
    saveConfig({ url: $("cfgUrl").value.trim(), token: $("cfgToken").value.trim(), goal: clampInt($("cfgGoal").value, 1, 52, 12) });
    $("settingsDialog").close(); state.heroMode = "auto";
    loadRecords().then(renderAll).catch(function (err) { toast("Error: " + err.message); renderAll(); });
  }

  // ---- Toast ----------------------------------------------------------------
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---- Wire up --------------------------------------------------------------
  // ---- Haptics --------------------------------------------------------------
  // navigator.vibrate covers Android; iOS Safari ignores it, so we click a <label>
  // wrapping an <input switch> — toggling a Safari switch pulses the Taptic Engine
  // on iOS 17.4+. The control is kept genuinely RENDERED & PAINTED (tiny, corner,
  // near-transparent) — hidden/opacity:0 variants can be skipped and never tick —
  // but pointer-events:none so it can't intercept real taps.
  // ---- Tick sound -----------------------------------------------------------
  // A short synthesized click (Web Audio, no asset to load) played on every
  // coverflow card-snap and picker notch — a working substitute now that iOS has
  // patched the Taptic switch trick. The context must be created/resumed inside a
  // user gesture (autoplay policy), so it's primed on the first pointerdown.
  var _actx = null, _lastTick = -1, _audioUnlocked = false;
  function audioCtx() {
    if (_actx) return _actx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      _actx = new AC();
      // Tell iOS this is UI feedback that should mix with (not replace) other
      // audio; "auto"/"playback" would duck or pause the user's music.
      try { if (navigator.audioSession) navigator.audioSession.type = "ambient"; } catch (e) {}
    } catch (e) { _actx = null; }
    return _actx;
  }
  // iOS only starts routing audio after a real node is STARTED inside a user
  // gesture — resume() alone leaves the context silent. Play a 1-sample silent
  // buffer on the first touch to unlock, and re-resume on every touch since iOS
  // suspends the context between interactions.
  function unlockAudio() {
    var ctx = audioCtx(); if (!ctx) return;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    if (_audioUnlocked) return;
    try {
      var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination);
      s.start ? s.start(0) : s.noteOn(0);
      _audioUnlocked = true;
    } catch (e) {}
  }
  function tick() {
    var ctx = audioCtx(); if (!ctx) return;
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
    var t = ctx.currentTime;
    if (t - _lastTick < 0.015) return;   // guard against pile-up on a fast flick
    _lastTick = t;
    try {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(2100, t);
      osc.frequency.exponentialRampToValueAtTime(1150, t + 0.02);   // pitch drop → "tick", not "beep"
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.001);      // near-instant attack
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);     // fast decay
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.035);
    } catch (e) {}
  }

  var _hapticLabel = null;
  function initHaptics() {
    var label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:fixed;left:1px;bottom:1px;width:22px;height:14px;opacity:0.012;pointer-events:none;z-index:0;margin:0;";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");     // Safari-only switch control
    input.style.cssText = "width:100%;height:100%;margin:0;";
    label.appendChild(input);
    document.body.appendChild(label);
    _hapticLabel = label;
  }
  function haptic() {
    if (navigator.vibrate) { try { navigator.vibrate(6); } catch (e) {} }
    if (_hapticLabel) { try { _hapticLabel.click(); } catch (e) {} }
    tick();
  }
  function init() {
    initHaptics();
    // Unlock/resume audio on EVERY touch (iOS re-suspends the context between
    // interactions), and warm the Taptic engine once — all silently, so a stray
    // first tap doesn't tick. touchend as well: some iOS builds only treat the
    // gesture as "activating" for audio on the end of the tap.
    var _feedbackPrimed = false;
    function primeFeedback() {
      unlockAudio();
      if (_feedbackPrimed) return;
      _feedbackPrimed = true;
      if (navigator.vibrate) { try { navigator.vibrate(6); } catch (e) {} }
      if (_hapticLabel) { try { _hapticLabel.click(); } catch (e) {} }
    }
    window.addEventListener("pointerdown", primeFeedback, { passive: true });
    window.addEventListener("touchend", primeFeedback, { passive: true });
    loadStops();
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onScheme = function () { loadStops(); if (state.slider) renderTimeline(); };
      if (mq.addEventListener) mq.addEventListener("change", onScheme); else if (mq.addListener) mq.addListener(onScheme);
    }
    state.selected = mostRecentSunday();
    buildCoverflow();
    $("heroInput").addEventListener("submit", function (e) { e.preventDefault(); });
    $("recordFab").addEventListener("click", function () {
      if (state.heroView === "empty") armAndForm();
      else if (state.heroView === "editing") saveHero();
    });
    $("tlTrack").addEventListener("pointerdown", onTimelinePointerDown);
    document.addEventListener("pointermove", function (e) { if (state.dragging) { var m = minFromClientX(e.clientX); if (m != null) setHandle(state.dragging, m); } });
    document.addEventListener("pointerup", function () { state.dragging = null; });
    $("tlStart").addEventListener("keydown", function (e) { onTimelineKey("start", e); });
    $("tlEnd").addEventListener("keydown", function (e) { onTimelineKey("end", e); });
    // cover flow: drag with finger/mouse, release for kinetic momentum
    var cf = $("coverflow");
    cf.addEventListener("pointerdown", function (e) { cfDown(e); });
    document.addEventListener("pointermove", function (e) { if (state.cf.dragging) cfMove(e); });
    document.addEventListener("pointerup", function () { if (state.cf.dragging) cfUp(); });
    document.addEventListener("pointercancel", function () { if (state.cf.dragging) cfUp(); });
    $("notesBtn").addEventListener("click", openNotesModal);
    $("cancelBtn").addEventListener("click", cancelEdit);
    $("notesSaveBtn").addEventListener("click", commitNote);
    $("notesCancelBtn").addEventListener("click", function () { $("notesDialog").close(); });
    window.addEventListener("resize", function () { positionFab(); setupFly(); });
    // drive the history-graph scroll scrubber (calendar bars fly down to the graph),
    // rAF-throttled so it runs at most once per frame
    // Drive the fly from a self-sustaining rAF loop (not just scroll events): while
    // the page is moving we sample window.pageYOffset every display frame, so the
    // morph tracks the smooth (compositor) scroll position — including iOS momentum
    // deceleration, when scroll events arrive too coarsely to look smooth.
    //
    // Keep it alive for a short window after the last scroll event OR position
    // change, and park only after real stillness. It must NOT park merely because
    // pageYOffset repeats for a few frames — iOS reports the same offset between
    // momentum checkpoints while the page is still gliding, and parking there froze
    // the morph and then jumped when it re-kicked.
    var flyRaf = null, flyActiveUntil = 0, flyLastY = -1;
    var nowMs = function () { return (window.performance && performance.now) ? performance.now() : Date.now(); };
    function flyLoop() {
      var y = window.pageYOffset, t = nowMs();
      if (y !== flyLastY) { flyLastY = y; flyActiveUntil = t + 350; }   // still moving → extend the window
      updateFly();
      flyRaf = t < flyActiveUntil ? requestAnimationFrame(flyLoop) : null;
    }
    function flyKick() {
      flyActiveUntil = nowMs() + 350;
      if (flyRaf == null) { flyLastY = -1; flyRaf = requestAnimationFrame(flyLoop); }
    }
    window.addEventListener("scroll", CSS_SCROLL ? flyScrollLatch : flyKick, { passive: true });
    // horizontally scrolling the graph re-selects the week it centres on (and
    // moves the picker to match), so the fly always animates the 8 weeks that are
    // actually on screen — not whichever 8 first flew down.
    var hgMain = document.querySelector(".hg-main"), hgScrollT = null;
    if (hgMain) hgMain.addEventListener("scroll", function () {
      if (hgScrollT) clearTimeout(hgScrollT);
      hgScrollT = setTimeout(syncFromGraphScroll, 120);
    }, { passive: true });
    $("recEditBtn").addEventListener("click", function () { var r = recordFor(state.selected); state.heroMode = "edit"; if (r) $("notes").value = r.notes || ""; renderHeroBody(); });
    $("delBtn").addEventListener("click", function () { var r = recordFor(state.selected); if (r) confirmDelete(r); });
    $("refreshBtn").addEventListener("click", function () { loadRecords().then(renderAll).catch(function (err) { toast("Error: " + err.message); }); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("cfgTestBtn").addEventListener("click", testConnection);
    $("cfgSaveBtn").addEventListener("click", saveSettings);
    $("cfgCancelBtn").addEventListener("click", function () { $("settingsDialog").close(); });

    var vEl = $("appVersion");
    if (vEl) vEl.textContent = "v" + APP_VERSION;

    startFabLoading();
    var t0 = Date.now();
    renderAll();
    positionFab();
    setTimeout(positionFab, 120); // re-measure once fonts/layout settle
    loadRecords().then(renderAll).catch(function (err) { toast("Could not load: " + err.message); renderAll(); })
      .finally(function () {
        setTimeout(finishFabLoading, Math.max(0, 700 - (Date.now() - t0)));
        maybeRevealOnLaunch();   // an already-recorded week unfolds like the empty state does
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
