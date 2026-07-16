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
  var state = { records: [], loading: false };

  // ---- Time helpers ---------------------------------------------------------
  function toMin(hhmm) {
    if (!hhmm) return null;
    var m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  var START_TARGET = toMin(cfg.startTarget);
  var END_TARGET = toMin(cfg.endTarget);

  function fmt12(hhmm) {
    var mins = toMin(hhmm);
    if (mins == null) return "—";
    var h = Math.floor(mins / 60), m = mins % 60;
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + ap;
  }
  // "+4 min" late / "on time" / "3 min early"
  function deltaLabel(mins) {
    if (mins == null) return "";
    if (mins > 0) return mins + " min late";
    if (mins < 0) return (-mins) + " min early";
    return "on time";
  }

  // ---- Record analysis ------------------------------------------------------
  function analyze(rec) {
    var s = toMin(rec.start), e = toMin(rec.end);
    var startDev = s == null ? null : s - START_TARGET; // + = late
    var endDev = e == null ? null : e - END_TARGET;
    var startOnTime = startDev != null && startDev <= 0;
    var endOnTime = endDev != null && endDev <= 0;
    return {
      startMin: s, endMin: e,
      startDev: startDev, endDev: endDev,
      startOnTime: startOnTime, endOnTime: endOnTime,
      success: startOnTime && endOnTime,
      partial: (startOnTime || endOnTime) && !(startOnTime && endOnTime),
    };
  }

  function sortedRecords() {
    return state.records.slice().sort(function (a, b) {
      return (a.date || "").localeCompare(b.date || "");
    });
  }

  function computeStats() {
    var recs = sortedRecords();
    var n = recs.length;
    var successes = 0, startLate = 0, endLate = 0;
    var startDevSum = 0, endDevSum = 0, startDevN = 0, endDevN = 0;
    var longest = 0, run = 0, current = 0;

    recs.forEach(function (r) {
      var a = analyze(r);
      if (a.success) { successes++; run++; if (run > longest) longest = run; }
      else { run = 0; }
      if (a.startDev != null) { startDevSum += a.startDev; startDevN++; if (a.startDev > 0) startLate++; }
      if (a.endDev != null) { endDevSum += a.endDev; endDevN++; if (a.endDev > 0) endLate++; }
    });
    // current streak = trailing run of successes
    for (var i = recs.length - 1; i >= 0; i--) {
      if (analyze(recs[i]).success) current++; else break;
    }

    return {
      total: n,
      successes: successes,
      current: current,
      longest: longest,
      rate: n ? Math.round((successes / n) * 100) : null,
      avgStartDev: startDevN ? startDevSum / startDevN : null,
      avgEndDev: endDevN ? endDevSum / endDevN : null,
      startLate: startLate,
      endLate: endLate,
      firstDate: recs.length ? recs[0].date : null,
    };
  }

  // ---- Storage layer --------------------------------------------------------
  function usingRemote() { return !!cfg.url; }

  function localRead() {
    try { return JSON.parse(localStorage.getItem(LS_LOCAL) || "[]"); } catch (e) { return []; }
  }
  function localWrite(recs) { localStorage.setItem(LS_LOCAL, JSON.stringify(recs)); }
  function uid() {
    return "r" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function apiGet() {
    var url = cfg.url + (cfg.url.indexOf("?") >= 0 ? "&" : "?") + "action=list";
    if (cfg.token) url += "&token=" + encodeURIComponent(cfg.token);
    return fetch(url, { method: "GET" }).then(function (r) { return r.json(); });
  }
  function apiPost(payload) {
    payload.token = cfg.token || "";
    return fetch(cfg.url, {
      method: "POST",
      // text/plain dodges the CORS preflight that Apps Script can't answer.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
    }).then(function (r) { return r.json(); });
  }

  function loadRecords() {
    if (!usingRemote()) {
      state.records = localRead();
      return Promise.resolve();
    }
    state.loading = true; renderAll();
    return apiGet().then(function (data) {
      if (!data || data.ok === false) throw new Error((data && data.error) || "Load failed");
      state.records = (data.records || []).filter(function (r) { return r && r.date; });
    }).finally(function () { state.loading = false; });
  }

  function addRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead();
      rec.id = uid();
      // replace any existing record for the same Sunday
      recs = recs.filter(function (r) { return r.date !== rec.date; });
      recs.push(rec); localWrite(recs); state.records = recs;
      return Promise.resolve();
    }
    return apiPost({ action: "add", date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Save failed"); })
      .then(loadRecords);
  }

  function updateRecord(rec) {
    if (!usingRemote()) {
      var recs = localRead().map(function (r) { return r.id === rec.id ? rec : r; });
      localWrite(recs); state.records = recs;
      return Promise.resolve();
    }
    return apiPost({ action: "update", id: rec.id, date: rec.date, start: rec.start, end: rec.end, notes: rec.notes })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Update failed"); })
      .then(loadRecords);
  }

  function deleteRecord(id) {
    if (!usingRemote()) {
      var recs = localRead().filter(function (r) { return r.id !== id; });
      localWrite(recs); state.records = recs;
      return Promise.resolve();
    }
    return apiPost({ action: "delete", id: id })
      .then(function (res) { if (!res || res.ok === false) throw new Error((res && res.error) || "Delete failed"); })
      .then(loadRecords);
  }

  // ---- Rendering ------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  function renderAll() {
    renderBanner();
    renderStats();
    renderGoal();
    renderStrip();
    renderHistory();
  }

  function renderBanner() {
    var b = $("banner");
    if (usingRemote()) { b.hidden = true; return; }
    b.hidden = false;
    b.innerHTML = "Saving to this browser only. Connect a Google Sheet in " +
      '<a href="#" id="bannerSettings">Settings ⚙️</a> to sync everywhere.';
    var link = $("bannerSettings");
    if (link) link.onclick = function (ev) { ev.preventDefault(); openSettings(); };
  }

  function renderStats() {
    var s = computeStats();
    $("statStreak").textContent = s.current;
    $("statStreakSub").textContent = s.current === 1 ? "week on time" : "weeks on time";
    $("statLongest").textContent = s.longest;
    $("statRate").textContent = s.rate == null ? "—" : s.rate + "%";
    $("statRateSub").textContent = s.total ? s.successes + " of " + s.total + " weeks" : "start & end on time";
    $("statWeeks").textContent = s.total;
    $("statSince").textContent = s.firstDate ? "since " + shortDate(s.firstDate) : "—";
  }

  function renderGoal() {
    var s = computeStats();
    var goal = cfg.goal;
    $("goalTarget").textContent = goal + "-week on-time streak";
    var pct = goal ? Math.min(100, Math.round((s.current / goal) * 100)) : 0;
    $("goalBar").style.width = pct + "%";
    $("goalBarWrap").setAttribute("aria-valuenow", String(pct));

    var msg = $("goalMsg");
    if (s.total === 0) {
      msg.innerHTML = "Log your first week to get started.";
    } else if (s.current >= goal) {
      msg.innerHTML = "🎉 <strong>Goal reached!</strong> You're on a " + s.current + "-week on-time streak — keep it going.";
    } else {
      var togo = goal - s.current;
      var lead = "<strong>" + togo + " more on-time week" + (togo === 1 ? "" : "s") + "</strong> to hit your goal.";
      msg.innerHTML = lead + " " + weakSpot(s);
    }

    var grid = $("insightGrid");
    if (s.total === 0) { grid.hidden = true; return; }
    grid.hidden = false;
    $("insStart").textContent = devText(s.avgStartDev);
    $("insStart").style.color = colorFor(s.avgStartDev);
    $("insEnd").textContent = devText(s.avgEndDev);
    $("insEnd").style.color = colorFor(s.avgEndDev);
    $("insStartLate").textContent = s.startLate + " / " + s.total;
    $("insEndLate").textContent = s.endLate + " / " + s.total;
  }

  function weakSpot(s) {
    if (s.startLate === 0 && s.endLate === 0) return "You're on time — just keep the streak alive.";
    if (s.endLate > s.startLate)
      return "Running long is the main issue — ending late on " + s.endLate + " of " + s.total + " weeks.";
    if (s.startLate > s.endLate)
      return "Starting late is the main issue — on " + s.startLate + " of " + s.total + " weeks.";
    return "Both starting and ending run late about equally often.";
  }
  function devText(mins) {
    if (mins == null) return "—";
    var r = Math.round(mins);
    if (r === 0) return "on time";
    return (r > 0 ? "+" : "") + r + " min";
  }
  function colorFor(mins) {
    if (mins == null) return "";
    return mins > 0.5 ? "var(--late)" : "var(--ok)";
  }

  function renderStrip() {
    var recs = sortedRecords().slice(-14);
    var card = $("stripCard");
    if (recs.length === 0) { card.hidden = true; return; }
    card.hidden = false;
    var strip = $("strip");
    strip.innerHTML = "";
    recs.forEach(function (r) {
      var a = analyze(r);
      var cls = a.success ? "ok" : (a.partial ? "partial" : "late");
      var label = a.success ? "✓" : (a.partial ? "~" : "✕");
      var cell = document.createElement("div");
      cell.className = "cell " + cls;
      cell.textContent = label;
      cell.title = shortDate(r.date) + " · start " + fmt12(r.start) + " (" +
        deltaLabel(a.startDev) + "), end " + fmt12(r.end) + " (" + deltaLabel(a.endDev) + ")";
      strip.appendChild(cell);
    });
  }

  function renderHistory() {
    var host = $("history");
    host.innerHTML = "";
    if (state.loading) { host.innerHTML = '<p class="empty">Loading…</p>'; return; }
    var recs = sortedRecords().reverse();
    if (recs.length === 0) {
      host.innerHTML = '<p class="empty">No weeks logged yet. Add your first one above.</p>';
      return;
    }
    recs.forEach(function (r) {
      var a = analyze(r);
      var el = document.createElement("div");
      el.className = "entry";

      var d = document.createElement("div");
      d.className = "entry-date";
      d.innerHTML = weekdayDate(r.date);

      var mid = document.createElement("div");
      var times = document.createElement("div");
      times.className = "entry-times";
      times.appendChild(pill("Start " + fmt12(r.start), a.startOnTime, a.startDev));
      times.appendChild(pill("End " + fmt12(r.end), a.endOnTime, a.endDev));
      mid.appendChild(times);
      if (r.notes) {
        var nt = document.createElement("div");
        nt.className = "entry-notes";
        nt.textContent = r.notes;
        mid.appendChild(nt);
      }

      var actions = document.createElement("div");
      actions.className = "entry-actions";
      var edit = miniBtn("✎", "Edit", function () { startEdit(r); });
      var del = miniBtn("🗑", "Delete", function () { confirmDelete(r); });
      actions.appendChild(edit); actions.appendChild(del);

      el.appendChild(d); el.appendChild(mid); el.appendChild(actions);
      host.appendChild(el);
    });
  }

  function pill(text, onTime, dev) {
    var p = document.createElement("span");
    p.className = "pill " + (onTime ? "ok" : "late");
    p.textContent = text;
    p.title = deltaLabel(dev);
    return p;
  }
  function miniBtn(label, title, fn) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "mini-btn"; b.textContent = label; b.title = title;
    b.onclick = fn; return b;
  }

  // ---- Date helpers ---------------------------------------------------------
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function parseYMD(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  }
  function shortDate(s) {
    var d = parseYMD(s); if (!d) return s;
    return MON[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }
  function weekdayDate(s) {
    var d = parseYMD(s); if (!d) return s;
    return MON[d.getMonth()] + " " + d.getDate() + " <span class='yr'>" + d.getFullYear() + "</span>";
  }
  function mostRecentSunday() {
    var d = new Date();
    d.setDate(d.getDate() - d.getDay()); // back up to Sunday
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  // ---- Form -----------------------------------------------------------------
  function resetForm() {
    $("editId").value = "";
    $("formTitle").textContent = "Log a week";
    $("saveBtn").textContent = "Save week";
    $("cancelEditBtn").hidden = true;
    $("entryForm").reset();
    $("date").value = mostRecentSunday();
    $("start").value = cfg.startTarget;
    $("end").value = cfg.endTarget;
    updateHints();
  }
  function startEdit(r) {
    $("editId").value = r.id;
    $("formTitle").textContent = "Edit week";
    $("saveBtn").textContent = "Update week";
    $("cancelEditBtn").hidden = false;
    $("date").value = r.date;
    $("start").value = r.start || "";
    $("end").value = r.end || "";
    $("notes").value = r.notes || "";
    updateHints();
    $("entryForm").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function updateHints() {
    setHint("startHint", toMin($("start").value), START_TARGET);
    setHint("endHint", toMin($("end").value), END_TARGET);
  }
  function setHint(id, mins, target) {
    var el = $(id);
    if (mins == null) { el.textContent = ""; el.className = "hint"; return; }
    var dev = mins - target;
    el.textContent = dev <= 0 ? "✓ " + deltaLabel(dev) : "✕ " + deltaLabel(dev);
    el.className = "hint " + (dev <= 0 ? "ok" : "late");
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var rec = {
      id: $("editId").value,
      date: $("date").value,
      start: $("start").value,
      end: $("end").value,
      notes: $("notes").value.trim(),
    };
    if (!rec.date || !rec.start || !rec.end) { toast("Fill in date, start and end."); return; }
    var btn = $("saveBtn"); btn.disabled = true;
    var op = rec.id ? updateRecord(rec) : addRecord(rec);
    op.then(function () {
      resetForm(); renderAll(); toast(rec.id ? "Week updated" : "Week saved");
    }).catch(function (err) {
      toast("Error: " + err.message);
    }).finally(function () { btn.disabled = false; });
  }

  function confirmDelete(r) {
    if (!window.confirm("Delete the entry for " + shortDate(r.date) + "?")) return;
    deleteRecord(r.id).then(function () { renderAll(); toast("Deleted"); })
      .catch(function (err) { toast("Error: " + err.message); });
  }

  // ---- Settings dialog ------------------------------------------------------
  function openSettings() {
    $("cfgUrl").value = cfg.url;
    $("cfgToken").value = cfg.token;
    $("cfgGoal").value = cfg.goal;
    setCfgStatus("", "");
    $("settingsDialog").showModal();
  }
  function setCfgStatus(msg, cls) {
    var el = $("cfgStatus"); el.textContent = msg; el.className = "cfg-status " + (cls || "");
  }
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
      } else {
        setCfgStatus("✕ " + ((data && data.error) || "Unexpected response."), "late");
      }
    }).catch(function (err) {
      setCfgStatus("✕ Could not reach the Web App. Check the URL and that access is set to \"Anyone\".", "late");
    });
  }
  function saveSettings() {
    saveConfig({
      url: $("cfgUrl").value.trim(),
      token: $("cfgToken").value.trim(),
      goal: clampInt($("cfgGoal").value, 1, 52, 12),
    });
    $("settingsDialog").close();
    resetForm();
    loadRecords().then(renderAll).catch(function (err) { toast("Error: " + err.message); renderAll(); });
  }

  // ---- Toast ----------------------------------------------------------------
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---- Wire up --------------------------------------------------------------
  function init() {
    resetForm();
    $("entryForm").addEventListener("submit", onSubmit);
    $("start").addEventListener("input", updateHints);
    $("end").addEventListener("input", updateHints);
    $("cancelEditBtn").addEventListener("click", resetForm);
    $("refreshBtn").addEventListener("click", function () {
      loadRecords().then(renderAll).catch(function (err) { toast("Error: " + err.message); });
    });
    $("settingsBtn").addEventListener("click", openSettings);
    $("cfgTestBtn").addEventListener("click", testConnection);
    $("cfgSaveBtn").addEventListener("click", saveSettings);
    $("cfgCancelBtn").addEventListener("click", function () { $("settingsDialog").close(); });

    renderAll();
    loadRecords().then(renderAll).catch(function (err) {
      toast("Could not load: " + err.message); renderAll();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
