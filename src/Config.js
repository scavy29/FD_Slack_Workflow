/**
 * Config.gs — settings, secrets access, static maps.
 *
 * No secret is hard-coded here. Everything sensitive lives in Script
 * Properties (Project Settings -> Script Properties); Setup.gs seeds them.
 */

/**
 * Bump this whenever you push a change you need to prove is live.
 *
 * doGet returns it, so hitting the exec URL in a browser answers "is the code
 * Slack is calling the code I just pushed?" — otherwise pure guesswork, and
 * the reason a deployment pointing at the wrong ID can burn an afternoon.
 */
var BUILD = '2026-08-22.g';

/**
 * The NAMES of the script properties — not their values.
 *
 * Every entry here is deliberately a name mapped to itself. Do not paste a
 * real domain, key or Sheet ID into this object: the values live in
 * Project Settings -> Script Properties, and nothing secret belongs in a file
 * that gets pushed and committed.
 */
var PROP = {
  FRESHDESK_DOMAIN:  'FRESHDESK_DOMAIN',
  FRESHDESK_API_KEY: 'FRESHDESK_API_KEY',
  SLACK_BOT_TOKEN:   'SLACK_BOT_TOKEN',
  SLACK_APP_ID:      'SLACK_APP_ID',
  SHARED_SECRET:     'SHARED_SECRET',
  LOG_SHEET_ID:      'LOG_SHEET_ID',

  // Optional. See OPTIONAL_PROPS below.
  FRESHDESK_GROUP_ID:     'FRESHDESK_GROUP_ID',
  FRESHDESK_EXTRA_FIELDS: 'FRESHDESK_EXTRA_FIELDS',
  FRESHDESK_TAGS:         'FRESHDESK_TAGS',
  LAUNCHER_CHANNEL_ID:    'LAUNCHER_CHANNEL_ID'
};

/**
 * Properties the integration runs without.
 *
 * Both exist for the same reason: Freshdesk enforces "mandatory on creation"
 * ticket fields at the API, not only in its own web form. A field marked
 * required under Admin -> Ticket Fields fails the create call even though the
 * caller never mentioned it — the error names a field you did not send, which
 * is baffling until you know. Rather than grow the modal every time someone
 * ticks a box in Freshdesk, supply the value here.
 */
var OPTIONAL_PROPS = ['FRESHDESK_GROUP_ID', 'FRESHDESK_EXTRA_FIELDS', 'FRESHDESK_TAGS',
                      'LAUNCHER_CHANNEL_ID'];

/** Human-readable description of each property, used by the setup helpers. */
var PROP_HELP = {
  FRESHDESK_DOMAIN:  'Subdomain only — "acme" for acme.freshdesk.com, no https://',
  FRESHDESK_API_KEY: 'Freshdesk -> Profile settings -> Your API Key',
  SLACK_BOT_TOKEN:   'xoxb-... from OAuth & Permissions',
  SLACK_APP_ID:      'A0123ABCD, from the app\'s Basic Information page',
  SHARED_SECRET:     'Generated for you by setupProperties()',
  LOG_SHEET_ID:      'The Sheet ID from its URL: /spreadsheets/d/<THIS>/edit',
  FRESHDESK_GROUP_ID: 'Optional. Numeric group to route tickets to — run listGroups() to find it',
  FRESHDESK_EXTRA_FIELDS: 'Optional. JSON merged into the ticket payload, e.g. {"type":"Question"}',
  FRESHDESK_TAGS: 'Optional. Comma-separated tags that ALREADY EXIST in Freshdesk. Empty = send none',
  LAUNCHER_CHANNEL_ID: 'Optional. Channel to post the "Create a ticket" button into when postLauncher is run from the editor'
};

function cfg_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(describeMissingProperty_(key));
  }
  return v;
}

/**
 * Turn a failed lookup into a message that says what to actually do.
 *
 * The interesting case is the second one. If the key we looked up is not one
 * of the names in PROP, then PROP itself has been edited — someone has pasted
 * a value over a name, and the error would otherwise read
 * "Missing script property: 1BsrXTKY..." which points nowhere useful.
 */
function describeMissingProperty_(key) {
  for (var name in PROP) {
    if (PROP[name] === key) {
      return 'Missing script property: ' + key + '. ' + (PROP_HELP[name] || '') +
             '\nSet it in Project Settings -> Script Properties, then run verifySetup().';
    }
  }

  return 'Config error: PROP holds a VALUE where a property NAME belongs ("' +
         String(key).slice(0, 40) + '").\n' +
         'PROP maps names to themselves — restore it to e.g. ' +
         'LOG_SHEET_ID: \'LOG_SHEET_ID\' in Config.gs, and put the real value ' +
         'in Project Settings -> Script Properties instead.';
}

/* ------------------------------------------------------------------ */
/* Freshdesk constants                                                 */
/* ------------------------------------------------------------------ */

/** Freshdesk priority values. */
var PRIORITY = { Low: 1, Medium: 2, High: 3, Urgent: 4 };

/**
 * Every ticket is filed at Low.
 *
 * Not a form field: self-assessed priority is not evidence of anything, and a
 * dropdown mostly teaches people that Urgent gets a faster reply. Support
 * triages from the content. Change this one constant if that stops being true.
 */
var DEFAULT_PRIORITY = 'Low';

/** The Product dropdown. Order here is the order shown. */
var PRODUCTS = [
  'Live',
  'Automate',
  'App Live',
  'App Automate',
  'Percy',
  'App Percy',
  'Test Management',
  'Test Reporting & Analytics',
  'Accessibility Testing',
  'Low Code Automation',
  'App Accessibility',
  'Accessibility Automation',
  'Automate Self Hosted',
  'Other'
];

var FD_STATUS_OPEN   = 2;   // 2 Open, 3 Pending, 4 Resolved, 5 Closed
var FD_SOURCE_PORTAL = 2;   // 1 Email, 2 Portal, 3 Phone, 7 Chat, 9 Feedback, 10 Outbound

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Slack's own ceiling for a plain_text_input: max_length must be between 1
 * and 3000. Exceeding it does not truncate — views.open rejects the whole
 * modal with `invalid_arguments` and the user sees no form at all.
 */
var SLACK_MAX_INPUT = 3000;

var MAX_SUBJECT     = 255;
var MAX_CC_EMAILS   = 10;     // Freshdesk's own limit is higher; this is a sanity bound
var MAX_CC_INPUT    = 500;    // characters in the CC field
var MAX_SUMMARY     = 255;
var MAX_SESSION_IDS = 500;
var MAX_STEPS       = 2000;

/**
 * Freshdesk would take far more than this, but the modal is the only way text
 * gets in and Slack will not accept an input longer than SLACK_MAX_INPUT.
 * Raising it past 3000 breaks the form.
 *
 * It is also close to another ceiling: Details is held in a Script Property
 * between submit and ticket creation, and a property value caps at 9KB. 3000
 * characters is 9000 bytes even if every one of them is three bytes wide, so
 * this fits — but only just. Steps to reproduce gets its own property for the
 * same reason rather than sharing one.
 */
var MAX_DETAILS = SLACK_MAX_INPUT;

/**
 * Total attachment budget, all files in one ticket combined.
 *
 * Freshdesk's public docs say 20MB; this account is provisioned at 25MB.
 * If an upload starts failing with HTTP 413, this number is the first thing
 * to check — lower it rather than guessing at the API.
 */
var MAX_ATTACH_TOTAL_BYTES = 25 * 1024 * 1024;

/** Slack's file_input caps at 10 files; keep them in step. */
var MAX_FILES = 10;

/**
 * Total attachment bytes we will assemble into a single create request, so
 * the ticket arrives complete rather than growing attachments afterwards.
 *
 * Set equal to the upload cap, which means EVERY submission takes the
 * single-request route: the ticket and all of its files are created together,
 * and nothing is ever appended to a ticket that already exists.
 *
 * That equality is measured, not assumed. Assembling the body by hand puts
 * every byte into script memory as a JavaScript number — roughly 8 bytes
 * each — and Apps Script does not document where it gives up. probeInlineLimit
 * built a full 25MB body in 323ms on this project, so there is room.
 *
 * Re-run probeInlineLimit() before raising MAX_ATTACH_TOTAL_BYTES, and keep
 * this at or above it. If it ever falls below, submissions over this size
 * quietly go back to create-then-attach, which works but appends files to a
 * ticket that already exists — the thing this was changed to avoid.
 */
var MAX_INLINE_ATTACH_BYTES = MAX_ATTACH_TOTAL_BYTES;

/** Give up on a file after this many attempts, then tell the user. */
var MAX_ATTACH_ATTEMPTS = 4;

/** Give up on creating a ticket after this many attempts. */
var MAX_TICKET_ATTEMPTS = 3;

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

var SHEET_NAME = 'ticket_log';

/**
 * One row per submission, appended, never rewritten in place except to
 * update the status columns. `description_text` is deliberately absent:
 * ticket bodies carry customer data and a Sheet has a far wider access
 * surface than Freshdesk. Only the length is kept.
 */
var HEADERS = [
  'timestamp_iso',        // submission received, UTC
  'slack_user_id',
  'slack_user_name',
  'requester_email',
  'channel_id',
  'channel_name',
  'subject',
  'product',
  'session_ids',
  'summary',              // one line, no more sensitive than the subject
  'priority',
  'description_chars',    // Details + Steps: length only, never the text
  'file_count',
  'file_bytes',
  'status',               // pending | created | failed
  'ticket_attempts',
  'freshdesk_ticket_id',
  'http_status',
  'error',
  'attach_status',        // none | pending | done | partial | failed
  'attach_attempts',
  'attach_error',
  'files_json',           // Slack file refs the worker needs; cleared when done
  'body_key',             // Script Property holding the description; see Sheet.gs
  'ack_ms',               // request in -> submission recorded; the Slack 3s budget
  'duration_ms',          // submission to ticket created
  'slack_ts',             // the summary message; replies thread under it
  'cc_emails'             // appended, per the rule below
];

/**
 * ONLY EVER APPEND TO HEADERS.
 *
 * col_() maps a name to a position, and rows already in the sheet were
 * written at the positions of the schema in force at the time. Insert a
 * column in the middle and every existing row is read one place out — status
 * comes back as the attempt count, the ticket id as an HTTP code — and
 * nothing errors, because every column is just a value.
 *
 * Appending is safe: old rows simply have a blank in the new column.
 */

/** 1-based column index by header name. */
function col_(name) {
  var i = HEADERS.indexOf(name);
  if (i === -1) throw new Error('Unknown column: ' + name);
  return i + 1;
}
