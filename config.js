/*
 * Optional defaults. You can either edit these values, or leave them blank
 * and configure everything from the in-app Settings (⚙️) panel — settings
 * entered in the app are saved in your browser and override these.
 *
 *   WEB_APP_URL : the "/exec" URL from your Google Apps Script deployment.
 *   SHARED_TOKEN: only needed if you set a SECRET in Code.gs.
 *   GOAL_STREAK : how many consecutive on-time weeks counts as "goal reached".
 *   START_TARGET / END_TARGET: the on-time cutoffs, 24-hour "HH:MM".
 */
window.APP_CONFIG = {
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbxD1v71NZQ72sEEgp-SuS6Gt9MjLzwtM7UFB5G41o1GLBpyh7beO3vx38mx3bleuMRy/exec",
  SHARED_TOKEN: "",
  GOAL_STREAK: 12,
  START_TARGET: "13:30",
  END_TARGET: "14:30",
};
