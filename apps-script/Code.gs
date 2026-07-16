/**
 * Sacrament Time Tracker — Google Apps Script backend.
 *
 * This turns a Google Sheet into a tiny JSON database for the web app.
 * There is no Google Cloud project, no API key, and no server to run.
 *
 * SETUP
 *   1. Create (or open) a Google Sheet.
 *   2. Extensions ▸ Apps Script. Delete the sample code, paste this file.
 *   3. (Optional) set SECRET below to a passphrase and enter the same value
 *      in the app's Settings ▸ "Shared token" field.
 *   4. Deploy ▸ New deployment ▸ type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the Web app URL that ends in "/exec".
 *   5. Paste that URL into the app's Settings (⚙️) panel.
 *
 * When you change the code, use Deploy ▸ Manage deployments ▸ Edit ▸
 * "New version" so the live URL picks up your changes.
 */

var SHEET_NAME = 'Records';
var SECRET = ''; // leave '' to allow anyone with the URL to write; set a value to require a token
var HEADERS = ['id', 'date', 'start', 'end', 'notes', 'created'];

function doGet(e) {
  try {
    if (SECRET && (!e || !e.parameter || e.parameter.token !== SECRET)) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    return json_({ ok: true, records: readAll_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = {};
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
    if (SECRET && body.token !== SECRET) return json_({ ok: false, error: 'unauthorized' });

    switch (body.action) {
      case 'add':    return json_({ ok: true, record: addRecord_(body) });
      case 'update': return json_({ ok: true, record: updateRecord_(body) });
      case 'delete': return json_({ ok: true, id: deleteRecord_(body.id) });
      default:       return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ---- storage ------------------------------------------------------------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  // keep every column as plain text so "13:30" and "2026-07-12" are not
  // silently converted into Sheets date/time values
  sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
  return sh;
}

function readAll_() {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0] && !r[1]) continue;
    out.push({
      id: String(r[0]),
      date: asDate_(r[1]),
      start: asTime_(r[2]),
      end: asTime_(r[3]),
      notes: r[4] == null ? '' : String(r[4]),
      created: r[5] == null ? '' : String(r[5]),
    });
  }
  return out;
}

function addRecord_(b) {
  var sh = getSheet_();
  var id = Utilities.getUuid();
  // one entry per Sunday: overwrite an existing row for the same date
  var existing = findRowByDate_(sh, b.date);
  if (existing > 0) {
    sh.getRange(existing, 1, 1, HEADERS.length)
      .setValues([[sh.getRange(existing, 1).getValue(), b.date, b.start, b.end, b.notes || '', new Date().toISOString()]]);
    return rowToObj_(sh, existing);
  }
  sh.appendRow([id, b.date, b.start, b.end, b.notes || '', new Date().toISOString()]);
  return rowToObj_(sh, sh.getLastRow());
}

function updateRecord_(b) {
  var sh = getSheet_();
  var row = findRowById_(sh, b.id);
  if (row < 0) throw new Error('record not found: ' + b.id);
  sh.getRange(row, 2, 1, 4).setValues([[b.date, b.start, b.end, b.notes || '']]);
  return rowToObj_(sh, row);
}

function deleteRecord_(id) {
  var sh = getSheet_();
  var row = findRowById_(sh, id);
  if (row < 0) throw new Error('record not found: ' + id);
  sh.deleteRow(row);
  return id;
}

/* ---- helpers ------------------------------------------------------------- */

function findRowById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function findRowByDate_(sh, date) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var dates = sh.getRange(2, 2, last - 1, 1).getValues();
  for (var i = 0; i < dates.length; i++) if (asDate_(dates[i][0]) === String(date)) return i + 2;
  return -1;
}

function rowToObj_(sh, row) {
  var r = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  return { id: String(r[0]), date: asDate_(r[1]), start: asTime_(r[2]), end: asTime_(r[3]), notes: String(r[4] || '') };
}

function asDate_(v) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function asTime_(v) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(v).trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
