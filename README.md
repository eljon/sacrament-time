# ⏱️ Sacrament Time Tracker

A tiny web app to track whether sacrament meeting **starts on time (1:30 PM)**
and **ends on time (2:30 PM)** each week. It shows your current streak, longest
streak, success rate, and how close you are to your goal.

- **No build step, no framework, no server of its own** — just static HTML/CSS/JS.
- **The database is a Google Sheet**, reached through a Google Apps Script Web App.
- **No Google Cloud Console, no API keys.**
- **Hosted on GitHub Pages** (or opened straight from a file).

Until you connect a sheet, the app works right away by saving to your browser
(`localStorage`), so you can try it before wiring anything up.

## Using it

The entry card sits at the top. Use the **‹ ›** arrows to move between Sundays
(no calendar to fuss with) — back for previous weeks, forward to return toward
this Sunday. Enter the start and end time and hit **Record it.** The inputs then
collapse into a recorded summary with on-time badges; **Edit** or **Remove**
brings them back.

---

## What it tracks

| Metric | Meaning |
| --- | --- |
| **Current streak** | Consecutive most-recent weeks where meeting both started **and** ended on time. |
| **Longest streak** | Your best run of on-time weeks. |
| **Success rate** | Share of weeks that were fully on time. |
| **Goal progress** | Progress toward an *N*-week on-time streak (default 12, configurable). |
| **Timing insight** | Your typical start/end minutes off target, and how often each runs late — so you can see *how close* you are and *which* end of the meeting needs work. |

"On time" means **at or before** the target: starting by 1:30 and ending by 2:30.
Ending early counts as on time.

---

## Setup

### 1. Create the Google Sheet database

1. Create a new Google Sheet (any name).
2. **Extensions ▸ Apps Script**. Delete the sample `function myFunction() {}`
   and paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. *(Optional)* Set `SECRET` near the top of the script to a passphrase if you
   want to require a token to write. Leave it as `''` for no token.
4. **Deploy ▸ New deployment**. Click the gear ▸ **Web app**. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone*
5. Click **Deploy**, authorize when prompted, and copy the **Web app URL**
   (it ends in `/exec`).

The script creates a `Records` sheet automatically on first use.

### 2. Point the app at your sheet

Open the app, click the **⚙️ Settings** button, paste the `/exec` URL (and the
token if you set one), then **Save**. Use **Test connection** to confirm it
works. Your setup is remembered in the browser.

> Prefer to bake it in? Edit [`config.js`](config.js) and set `WEB_APP_URL`
> (and `SHARED_TOKEN` / `GOAL_STREAK`) there instead.

### 3. Host on GitHub Pages

1. Push this repository to GitHub.
2. **Settings ▸ Pages** → *Build and deployment* → **Deploy from a branch**.
3. Choose your branch and the **`/ (root)`** folder, then **Save**.
4. Your app appears at `https://<user>.github.io/<repo>/` within a minute or two.

Because everything is static, you can also just open `index.html` locally.

---

## How the Sheet talks to the browser

The Apps Script exposes two endpoints:

- `GET  ?action=list` → `{ ok: true, records: [...] }`
- `POST` with a JSON body `{ action: "add" | "update" | "delete", ... }`

The browser posts with `Content-Type: text/plain` on purpose — that avoids a
CORS preflight that Apps Script can't answer, and Google serves the response
with permissive CORS headers, so the round trip works from any origin.

Each row is one Sunday: `id`, `date` (`YYYY-MM-DD`), `start` (`HH:MM`),
`end` (`HH:MM`), `notes`, `created`. Logging the same Sunday twice overwrites
the earlier entry.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup and layout. |
| `styles.css` | Styling (light/dark, responsive). |
| `app.js` | All app logic: stats, storage, rendering. |
| `config.js` | Optional defaults (URL, token, goal, targets). |
| `apps-script/Code.gs` | The Google Apps Script backend to paste into your sheet. |

---

## Changing the targets

Start/end targets and the goal streak live in `config.js`:

```js
window.APP_CONFIG = {
  GOAL_STREAK: 12,
  START_TARGET: "13:30",  // 1:30 PM
  END_TARGET:   "14:30",  // 2:30 PM
};
```
