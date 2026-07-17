/* Sacrament Time Tracker — front-end logic.
 * Storage is either a Google Apps Script Web App (backed by a Google Sheet)
 * or, if no URL is configured, this browser's localStorage. */
(function () {
  "use strict";

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
  var state = { records: [], loading: false, selected: null, heroMode: "auto", slider: null, dragging: null };

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
  function addRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead().filter(function (r) { return r.date !== rec.date; });
      rec.id = uid(); recs.push(rec); localWrite(recs); state.records = recs;
      return Promise.resolve();
    }
    return apiPost({ action: "add", date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Save failed"); })
      .then(loadRecords);
  }
  function updateRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead().map(function (r) { return r.id === rec.id ? rec : r; });
      localWrite(recs); state.records = recs; return Promise.resolve();
    }
    return apiPost({ action: "update", id: rec.id, date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Update failed"); })
      .then(loadRecords);
  }
  function deleteRecord(id) {
    if (!usingRemote()) {
      var recs = localRead().filter(function (r) { return r.id !== id; });
      localWrite(recs); state.records = recs; return Promise.resolve();
    }
    return apiPost({ action: "delete", id: id })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Delete failed"); })
      .then(loadRecords);
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
    renderBanner(); renderHero(); renderStats(); renderGoal(); renderStrip(); renderHistory();
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
    var sel = state.selected;
    var rec = recordFor(sel);
    var today = mostRecentSunday();

    renderCoverflow();
    $("weekCaption").textContent = sel === today ? "This Sunday" : "";

    var editing = state.heroMode === "edit" || (state.heroMode === "auto" && !rec);
    state.editing = editing;

    // the slider always reflects the current record (or the targets when new)
    setSlider(rec ? rec.start : cfg.startTarget, rec ? rec.end : cfg.endTarget);
    setHandlesInteractive(editing);
    $("heroInput").classList.toggle("recorded", !editing);

    // editable controls
    $("notes").hidden = !editing;
    $("saveBtn").hidden = !editing;
    $("cancelEditBtn").hidden = !(editing && rec); // cancel only when editing an existing record
    // recorded controls
    $("editBtn").hidden = editing;
    $("clearBtn").hidden = editing;

    if (editing) {
      $("notes").value = rec ? (rec.notes || "") : "";
      $("saveBtn").textContent = rec ? "Update" : "Record it";
      $("recVerdict").hidden = true;
      $("recNotes").hidden = true;
    } else {
      $("recVerdict").hidden = false;
      $("recVerdict").textContent = verdict(analyze(rec));
      if (rec.notes) { $("recNotes").hidden = false; $("recNotes").textContent = "“" + rec.notes + "”"; }
      else { $("recNotes").hidden = true; }
    }
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
      actions.appendChild(miniBtn("✎", "Edit", function () { goToWeek(r.date); state.heroMode = "edit"; renderHero(); scrollToHero(); }));
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

  // ---- Cover Flow date picker -----------------------------------------------
  var CF_RANGE = 104;   // Sundays of history to make available (~2 years)
  var CF_WINDOW = 4;    // how many cards fan out on each side of centre
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
  }
  function calCard(dateStr) {
    var d = parseYMD(dateStr);
    var el = document.createElement("button");
    el.type = "button"; el.className = "cal"; el.setAttribute("data-date", dateStr);
    el.setAttribute("aria-label", MON[d.getMonth()] + " " + d.getDate());
    el.innerHTML = '<span class="cal-top">' + MON[d.getMonth()].toUpperCase() + '</span>' +
      '<span class="cal-day">' + d.getDate() + '</span><span class="cal-dot"></span>';
    el.addEventListener("click", function () { if (!state.cfMoved) goToWeek(dateStr); });
    return el;
  }
  function renderCoverflow() {
    if (!state.sundays) return;
    var idx = state.sundays.indexOf(state.selected);
    if (idx < 0) return;
    $("prevWeek").disabled = idx <= 0;
    $("nextWeek").disabled = idx >= state.sundays.length - 1;
    for (var i = 0; i < state.sundays.length; i++) {
      positionCard(state.cardEls[state.sundays[i]], i - idx, state.sundays[i]);
    }
  }
  function positionCard(el, o, dateStr) {
    var abso = Math.abs(o), dir = o < 0 ? -1 : 1;
    if (o === 0) {
      el.style.transform = "translateX(0) rotateY(0deg) scale(1)";
      el.style.opacity = "1"; el.style.zIndex = "100"; el.style.pointerEvents = "auto";
      el.classList.add("is-center");
    } else if (abso > CF_WINDOW) {
      el.style.transform = "translateX(" + (dir * 190) + "px) rotateY(" + (-dir * 58) + "deg) scale(.7)";
      el.style.opacity = "0"; el.style.zIndex = "0"; el.style.pointerEvents = "none";
      el.classList.remove("is-center");
    } else {
      var x = dir * (46 + (abso - 1) * 24);
      el.style.transform = "translateX(" + x + "px) rotateY(" + (-dir * 54) + "deg) scale(.86)";
      el.style.opacity = String(Math.max(0, 1 - abso * 0.18));
      el.style.zIndex = String(100 - abso); el.style.pointerEvents = "auto";
      el.classList.remove("is-center");
    }
    // status dot for logged weeks
    var dot = el.querySelector(".cal-dot");
    var rec = recordFor(dateStr);
    if (rec) { var a = analyze(rec); dot.style.background = lateColor(Math.max(a.startDev || 0, a.endDev || 0)); }
    else dot.style.background = "transparent";
  }
  function stepWeek(dir) {
    if (!state.sundays) return;
    var ni = state.sundays.indexOf(state.selected) + dir;
    if (ni >= 0 && ni < state.sundays.length) goToWeek(state.sundays[ni]);
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
    if (!state.editing) return;
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

  function onSubmit(ev) {
    ev.preventDefault();
    var existing = recordFor(state.selected);
    var rec = {
      id: existing ? existing.id : "",
      date: state.selected,
      start: $("start").value, end: $("end").value, notes: $("notes").value.trim(),
    };
    if (!rec.date || !rec.start || !rec.end) { toast("Fill in start and end"); return; }
    var btn = $("saveBtn"); btn.disabled = true;
    var op = rec.id ? updateRecord(rec) : addRecord(rec);
    op.then(function () {
      state.heroMode = "auto"; renderAll();
      toast(existing ? "Week updated" : "Week recorded");
    }).catch(function (err) { toast("Error: " + err.message); })
      .finally(function () { btn.disabled = false; });
  }

  function confirmDelete(r) {
    if (!window.confirm("Delete the entry for " + shortDate(r.date) + "?")) return;
    deleteRecord(r.id).then(function () { state.heroMode = "auto"; renderAll(); toast("Deleted"); })
      .catch(function (err) { toast("Error: " + err.message); });
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
    $("heroInput").addEventListener("submit", onSubmit);
    $("tlTrack").addEventListener("pointerdown", onTimelinePointerDown);
    document.addEventListener("pointermove", function (e) { if (state.dragging) { var m = minFromClientX(e.clientX); if (m != null) setHandle(state.dragging, m); } });
    document.addEventListener("pointerup", function () { state.dragging = null; });
    $("tlStart").addEventListener("keydown", function (e) { onTimelineKey("start", e); });
    $("tlEnd").addEventListener("keydown", function (e) { onTimelineKey("end", e); });
    $("prevWeek").addEventListener("click", function () { stepWeek(-1); });
    $("nextWeek").addEventListener("click", function () { stepWeek(1); });
    // swipe the cover flow (drag right → older, left → newer)
    var cf = $("coverflow"), cfStart = null;
    cf.addEventListener("pointerdown", function (e) { cfStart = e.clientX; state.cfMoved = false; });
    cf.addEventListener("pointermove", function (e) { if (cfStart != null && Math.abs(e.clientX - cfStart) > 8) state.cfMoved = true; });
    cf.addEventListener("pointerup", function (e) {
      if (cfStart == null) return;
      var dx = e.clientX - cfStart; cfStart = null;
      if (dx <= -40) stepWeek(1); else if (dx >= 40) stepWeek(-1);
    });
    cf.addEventListener("pointerleave", function () { cfStart = null; });
    $("editBtn").addEventListener("click", function () { state.heroMode = "edit"; renderHero(); });
    $("cancelEditBtn").addEventListener("click", function () { state.heroMode = "auto"; renderHero(); });
    $("clearBtn").addEventListener("click", function () { var r = recordFor(state.selected); if (r) confirmDelete(r); });
    $("refreshBtn").addEventListener("click", function () { loadRecords().then(renderAll).catch(function (err) { toast("Error: " + err.message); }); });
    $("settingsBtn").addEventListener("click", openSettings);
    $("cfgTestBtn").addEventListener("click", testConnection);
    $("cfgSaveBtn").addEventListener("click", saveSettings);
    $("cfgCancelBtn").addEventListener("click", function () { $("settingsDialog").close(); });

    renderAll();
    loadRecords().then(renderAll).catch(function (err) { toast("Could not load: " + err.message); renderAll(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
