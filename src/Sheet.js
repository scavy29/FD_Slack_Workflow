/**
 * Sheet.gs — the Google Sheet log.
 *
 * The log is also the work queue: a row with status 'pending' is a ticket not
 * created yet, and attach_status 'pending' is a file not uploaded yet. One
 * store, so a row can never disagree with a queue about what happened.
 */

/**
 * Resolved once per execution.
 *
 * sheet_() is called by every append and every update, and each call was
 * costing an openById, a getSheetByName and a header read. On the submission
 * path — where Slack allows three seconds in total — that was the single
 * most expensive thing happening. An Apps Script execution is a fresh
 * process, so caching for its lifetime is safe.
 */
var _sheet = null;

function sheet_() {
  if (_sheet) return _sheet;

  var ss = SpreadsheetApp.openById(cfg_(PROP.LOG_SHEET_ID));
  var sh = ss.getSheetByName(SHEET_NAME);

  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  } else {
    ensureHeaders_(sh);
  }

  _sheet = sh;
  return sh;
}

/**
 * Keep the header row in step with HEADERS.
 *
 * Safe when columns were APPENDED: existing rows keep their positions and
 * simply have a blank in the new column.
 *
 * Not safe when a column was inserted or reordered, and this cannot repair
 * that — the rows in the sheet were written at the old positions, so every
 * read after the insertion point is off by one. It says so loudly instead of
 * pretending the rewrite fixed anything.
 */
function ensureHeaders_(sh) {
  var width = Math.max(sh.getLastColumn(), HEADERS.length);
  var current = sh.getRange(1, 1, 1, width).getValues()[0];

  var shared = 0;
  while (shared < HEADERS.length && current[shared] === HEADERS[shared]) shared++;
  if (shared === HEADERS.length) return;               // already current

  // Everything the sheet already had still lines up: this is an append.
  var appendOnly = !String(current[shared] || '');

  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);

  if (appendOnly) {
    debug_('ticket_log: added ' + HEADERS.slice(shared).join(', '));
    return;
  }

  debug_('ticket_log: COLUMN POSITIONS CHANGED at "' + HEADERS[shared] + '". ' +
         'Rows written before this point were stored at the old positions and ' +
         'will now be read one or more columns out — the header row has been ' +
         'corrected, but existing rows have NOT been moved. Only ever append to ' +
         'HEADERS. Check diagnose() output against the sheet before trusting it.');
}

/* ------------------------------------------------------------------ */
/* The description                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ticket bodies live in Script Properties between submit and create, not in
 * the Sheet.
 *
 * The Sheet is shared with whoever needs to read the log, and a ticket
 * description routinely contains customer data — so the Sheet keeps only the
 * character count. But the worker creates the ticket in a later execution and
 * needs the actual text, so it has to be somewhere durable: CacheService can
 * evict at any time, and losing a body means losing the ticket.
 *
 * The property is deleted the moment the ticket exists.
 */
function saveBody_(key, text) {
  PropertiesService.getScriptProperties().setProperty('body:' + key, String(text || ''));
}

function loadBody_(key) {
  if (!key) return '';
  return PropertiesService.getScriptProperties().getProperty('body:' + key) || '';
}

/**
 * Steps to reproduce gets its own key rather than sharing the Details one.
 * A property value caps at 9KB and Details can already be 3000 characters —
 * 9000 bytes if they are all three-byte characters. There is no room to put
 * anything else beside it.
 */
function loadSteps_(key) {
  if (!key) return '';
  return PropertiesService.getScriptProperties().getProperty('steps:' + key) || '';
}

/** Drop everything held for one submission. */
function dropBody_(key) {
  if (!key) return;
  try {
    PropertiesService.getScriptProperties().deleteProperty('body:' + key);
    PropertiesService.getScriptProperties().deleteProperty('steps:' + key);
  } catch (e) {
    debug_('dropBody_ failed: ' + e);
  }
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/**
 * Record a queued submission in the Sheet.
 *
 * Called by the worker, not by the submission path — see queueSubmission_ in
 * Submit.gs for why. `t.bodyKey` names the property already holding the
 * description; `t.receivedIso` is when the user actually pressed Submit,
 * which is what the log should show rather than when the worker got to it.
 */
function appendRow_(t) {
  var bodyKey = t.bodyKey || Utilities.getUuid();
  if (!t.bodyKey) {
    saveBody_(bodyKey, t.description);
    if (t.steps) {
      PropertiesService.getScriptProperties().setProperty('steps:' + bodyKey, String(t.steps));
    }
  }

  var row = {
    timestamp_iso:     t.receivedIso || nowIso_(),
    slack_user_id:     t.userId || '',
    slack_user_name:   t.userName || '',
    requester_email:   t.email || '',
    cc_emails:         (t.ccEmails || []).join(', '),
    channel_id:        t.channelId || '',
    channel_name:      t.channelName || '',
    subject:           truncate_(t.subject, MAX_SUBJECT),
    product:           t.product || '',
    session_ids:       truncate_(t.sessionIds || '', MAX_SESSION_IDS),
    // One line, and no more sensitive than the subject already in this sheet.
    // Details and Steps are the parts that stay out; only their length is kept.
    summary:           truncate_(t.summary || '', MAX_SUMMARY),
    priority:          t.priority || DEFAULT_PRIORITY,
    description_chars: t.descriptionChars !== undefined
                         ? t.descriptionChars
                         : String(t.description || '').length,
    file_count:        (t.files || []).length,
    file_bytes:        totalBytes_(t.files),
    status:            'pending',
    ticket_attempts:   0,
    attach_status:     (t.files || []).length ? 'pending' : 'none',
    attach_attempts:   0,
    files_json:        (t.files || []).length ? JSON.stringify(t.files) : '',
    body_key:          bodyKey,
    // Measured on the submission path, carried here by the job. This is the
    // Slack 3-second budget as spent — if it creeps towards 2500ms the cold
    // start alone is eating the allowance.
    ack_ms:            t.ackMs === undefined ? '' : t.ackMs
  };

  try {
    var sh = sheet_();
    sh.appendRow(HEADERS.map(function (h) {
      return row[h] === undefined ? '' : row[h];
    }));
    return sh.getLastRow();
  } catch (e) {
    dropBody_(bodyKey);   // nothing will ever read it now
    throw e;
  }
}

/** Patch named columns on one row. Reads and writes the row once each. */
function updateRow_(rowNum, patch) {
  var sh = sheet_();
  var range = sh.getRange(rowNum, 1, 1, HEADERS.length);
  var values = range.getValues()[0];

  Object.keys(patch).forEach(function (k) {
    values[col_(k) - 1] = patch[k] === undefined || patch[k] === null ? '' : patch[k];
  });

  range.setValues([values]);
}

/** Submissions with no ticket yet. */
function pendingTicketRows_() {
  return scanRows_(function (row) {
    return row[col_('status') - 1] === 'pending';
  });
}

/** Tickets that exist but whose files are not on them yet. */
function pendingAttachmentRows_() {
  return scanRows_(function (row) {
    return row[col_('attach_status') - 1] === 'pending' &&
           !!row[col_('freshdesk_ticket_id') - 1];
  });
}

function scanRows_(match) {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (match(values[i])) out.push({ rowNum: i + 2, values: values[i] });
  }
  return out;
}

/** Rebuild the ticket from a logged row, pulling the body back out of storage. */
function rowToTicket_(values) {
  var files = [];
  try { files = JSON.parse(rowVal_(values, 'files_json') || '[]'); } catch (e) {}

  var key = rowVal_(values, 'body_key');

  return {
    userId:      rowVal_(values, 'slack_user_id'),
    userName:    rowVal_(values, 'slack_user_name'),
    email:       rowVal_(values, 'requester_email'),
    ccEmails:    parseEmailList_(rowVal_(values, 'cc_emails')).emails,
    channelId:   rowVal_(values, 'channel_id'),
    channelName: rowVal_(values, 'channel_name'),
    subject:     rowVal_(values, 'subject'),
    product:     rowVal_(values, 'product'),
    sessionIds:  rowVal_(values, 'session_ids'),
    summary:     rowVal_(values, 'summary'),
    priority:    rowVal_(values, 'priority') || DEFAULT_PRIORITY,
    description: loadBody_(key),
    steps:       loadSteps_(key),
    files:       files
  };
}

/** Read a named column out of a raw row array. */
function rowVal_(values, name) {
  return values[col_(name) - 1];
}

function totalBytes_(files) {
  return (files || []).reduce(function (sum, f) { return sum + (Number(f.size) || 0); }, 0);
}
