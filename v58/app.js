/* Sacrament Time Tracker — front-end logic.
 * Storage is either a Google Apps Script Web App (backed by a Google Sheet)
 * or, if no URL is configured, this browser's localStorage. */
(function () {
  "use strict";

  // Bumped every commit (each commit is a new version).
  var APP_VERSION = 58;

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
    var recs = sortedRecords().slice(-8);   // keep the axis readable on phones
    if (recs.length === 0) { section.hidden = true; state.hgSig = null; return; }
    section.hidden = false;
    var sig = recs.map(function (r) { return r.date + "|" + r.start + "|" + r.end; }).join(",");
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

    setupFly();
  }
  // ---- Scroll-scrubbed fly: as the calendar scrolls off the top, each week's
  // bar and date leave their calendar card and travel down into the graph.
  // A clone carries the visual; the real calendar contents fade out as they
  // "leave" and the real graph bars fade in as they arrive. Fully reversible.
  function setupFly() {
    var layer = $("hgFlyLayer");
    if (!layer) { layer = document.createElement("div"); layer.id = "hgFlyLayer"; document.body.appendChild(layer); }
    layer.innerHTML = "";
    state.fly = null;
    var section = $("historyGraph"), cover = $("coverflow");
    if (prefersReduced() || !cover || !section || section.hidden || !state.hgItems || !state.hgItems.length) return;
    var groups = [];
    state.hgItems.forEach(function (it) {
      var card = state.cardEls && state.cardEls[it.date];
      if (!card) return;                       // no source card in the picker → element just stays put
      var rec = recordFor(it.date); if (!rec) return;
      var calBar = card.querySelector(".cal-bar"), calDay = card.querySelector(".cal-day"), calTop = card.querySelector(".cal-top");
      var a = analyze(rec), cs = lateColor(a.startDev), ce = lateColor(a.endDev);
      // the bar clone mimics the calendar bar exactly, then morphs into the graph bar
      var barEl = document.createElement("div"); barEl.className = "hg-fly-bar";
      barEl.style.background = "linear-gradient(to right," + cs + "," + ce + ")";
      layer.appendChild(barEl);
      // month & day are literal clones of the calendar nodes → identical font/size/colour
      var monEl = calTop.cloneNode(true); monEl.classList.add("hg-fly-clone");
      var dayEl = calDay.cloneNode(true); dayEl.classList.add("hg-fly-clone");
      if (it.date === state.selected) dayEl.style.color = "var(--brand)";
      layer.appendChild(monEl); layer.appendChild(dayEl);
      var g = { it: it, card: card, calBar: calBar, calDay: calDay, calTop: calTop, barEl: barEl, monEl: monEl, dayEl: dayEl };
      g.dayNatH = dayEl.getBoundingClientRect().height || 20;   // day number's natural (unscaled) height
      groups.push(g);
    });
    if (!groups.length) return;
    state.fly = { groups: groups, anchored: false, start: 0, end: 1 };
    refreshFlyAnchors();
    updateFly();
  }
  function docBox(el) {
    var r = el.getBoundingClientRect();
    return { cx: r.left + window.pageXOffset + r.width / 2, cy: r.top + window.pageYOffset + r.height / 2, w: r.width, h: r.height };
  }
  function refreshFlyAnchors() {
    var f = state.fly; if (!f) return;
    var sy = window.pageYOffset, vh = window.innerHeight;
    f.start = $("coverflow").getBoundingClientRect().top + sy;                 // calendar top reaches the viewport top
    f.end = $("historyGraph").getBoundingClientRect().top + sy - vh * 0.42;    // graph settles into view
    if (f.end <= f.start) f.end = f.start + 1;
    f.groups.forEach(function (g) {
      g.sBar = docBox(g.calBar || g.card); g.sMon = docBox(g.calTop); g.sDay = docBox(g.calDay);
      g.tBar = docBox(g.it.bar); g.tMon = docBox(g.it.xc.querySelector(".hg-mon")); g.tDay = docBox(g.it.xc.querySelector(".hg-day"));
      // month: size the clone to the calendar header's rendered box so it starts
      // pixel-identical, then scale uniformly to the axis label
      g.monEl.style.width = g.sMon.w + "px"; g.monEl.style.height = g.sMon.h + "px";
      g.monScale0 = 1;
      g.monScale1 = g.sMon.h ? g.tMon.h / g.sMon.h : 1;
      // day number: scale from its rendered calendar size (incl. Cover Flow scaling)
      // to its graph size, using the clone's natural height as the reference
      g.dayScale0 = g.dayNatH ? g.sDay.h / g.dayNatH : 1;
      g.dayScale1 = g.dayNatH ? g.tDay.h / g.dayNatH : 1;
    });
    f.anchored = true;
  }
  function updateFly() {
    var f = state.fly; if (!f) return;
    var sy = window.pageYOffset;
    var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    var p = (sy - f.start) / (f.end - f.start);
    if (sy >= maxScroll - 1) p = 1;             // can't scroll further → make sure it fully assembles
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    if (p > 0 && !f.anchored) refreshFlyAnchors();
    if (p <= 0) f.anchored = false;             // re-measure next time the fly starts
    var eP = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;   // easeInOut
    var active = p > 0.0015 && p < 0.9985;
    // hard handoffs so the user never sees double: originals vanish the instant
    // the clone takes over, and the real graph bars appear only once it lands.
    var shed = active || p >= 0.9985 ? 1 : 0;
    var appear = p >= 0.9985 ? 1 : 0;
    var vis = active ? "1" : "0";
    var sx = window.pageXOffset, syo = window.pageYOffset;   // doc → viewport (fixed positioning)
    f.groups.forEach(function (g) {
      if (g.calBar) g.calBar.style.opacity = String(1 - shed);
      g.calDay.style.opacity = String(1 - shed);
      g.calTop.style.opacity = String(1 - shed);
      g.it.bar.style.opacity = String(appear);
      g.it.xc.style.opacity = String(appear);
      // display:none when idle so these fixed clones can never sit off-screen and
      // let iOS pan the page sideways (fixed elements dodge overflow-x: hidden)
      var disp = active ? "block" : "none";
      g.barEl.style.display = disp; g.monEl.style.display = disp; g.dayEl.style.display = disp;
      g.barEl.style.opacity = vis; g.monEl.style.opacity = vis; g.dayEl.style.opacity = vis;
      if (!active) return;
      // bar: horizontal calendar bar → vertical start→end graph bar
      var bx = g.sBar.cx + (g.tBar.cx - g.sBar.cx) * eP, by = g.sBar.cy + (g.tBar.cy - g.sBar.cy) * eP;
      var w = g.sBar.w + (g.tBar.h - g.sBar.w) * eP, h = g.sBar.h + (14 - g.sBar.h) * eP;
      g.barEl.style.left = (bx - sx) + "px"; g.barEl.style.top = (by - syo) + "px";
      g.barEl.style.width = w + "px"; g.barEl.style.height = h + "px";
      g.barEl.style.borderRadius = (2 + 5 * eP) + "px";
      g.barEl.style.transform = "translate(-50%,-50%) rotate(" + (90 * eP) + "deg)";
      // month & day clones: glide from the card into the axis, scaling to fit
      placeClone(g.monEl, g.sMon, g.tMon, g.monScale0 + (g.monScale1 - g.monScale0) * eP, eP, sx, syo);
      placeClone(g.dayEl, g.sDay, g.tDay, g.dayScale0 + (g.dayScale1 - g.dayScale0) * eP, eP, sx, syo);
    });
  }
  function placeClone(el, s, t, scale, eP, sx, sy) {
    var x = s.cx + (t.cx - s.cx) * eP - sx, y = s.cy + (t.cy - s.cy) * eP - sy;
    el.style.left = x + "px"; el.style.top = y + "px";
    el.style.transform = "translate(-50%,-50%) scale(" + scale + ")";
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
  var CF_WINDOW = 5;       // how many cards fan out on each side of centre
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
  // The centre card is biggest and cards shrink progressively with distance, but
  // the curve flattens to a floor so far cards stay visible (keeps it dense).
  function cardScale(ao) { return 0.5 + 0.6 * Math.pow(0.7, ao); }   // 1.1 → 0.92 → 0.79 → …
  function applyCard(el, o, isCenter, dateStr) {
    var ao = Math.abs(o), s = o < 0 ? -1 : 1;
    var near = 52, far = 22;
    if (ao > CF_WINDOW + 0.5) {
      // Park off-window cards AT the window edge (not off-screen) and hide them.
      // iOS Safari doesn't clip 3D-transformed children with overflow:hidden, so
      // a big translateX here would let the page pan sideways — keep them inside.
      el.style.opacity = "0"; el.style.pointerEvents = "none"; el.style.zIndex = "0";
      el.style.visibility = "hidden";
      el.style.transform = "translateX(" + (s * (near + (CF_WINDOW - 1) * far)) + "px) scale(" + cardScale(ao) + ")";
      el.classList.remove("is-center"); setDot(el, dateStr); return;
    }
    var cl = Math.min(ao, 1);
    var x = ao <= 1 ? o * near : s * (near + (ao - 1) * far);
    var transform = "translateX(" + x + "px) translateZ(" + ((1 - cl) * 52) + "px) " +
      "rotateY(" + (-s * 50 * cl) + "deg) scale(" + cardScale(ao) + ")";
    el.style.visibility = "visible";
    el.style.transform = transform;
    el.style.opacity = String(ao <= 1 ? 1 : Math.max(0, 1 - (ao - 1) * 0.24));
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
      if (Math.abs(cf.target - cf.pos) < 0.003) { cf.pos = cf.target; cf.target = null; cf.vel = 0; cfLayout(); cfSyncCenter(); cf.raf = null; return; }
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
    if (which === "start") state.slider.start = clamp(m, AXIS_START, state.slider.end - MIN_GAP);
    else state.slider.end = clamp(m, state.slider.start + MIN_GAP, AXIS_END);
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
  function init() {
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
    // drive the history-graph scroll scrubber (calendar bars fly down to the graph)
    var flyTick = false;
    window.addEventListener("scroll", function () {
      if (flyTick) return; flyTick = true;
      requestAnimationFrame(function () { flyTick = false; updateFly(); });
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
      .finally(function () { setTimeout(finishFabLoading, Math.max(0, 700 - (Date.now() - t0))); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
