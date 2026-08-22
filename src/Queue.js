/**
 * Queue.gs — everything that happens after the modal closes.
 *
 * Two triggers feed this:
 *   processQueue      every minute, the safety net
 *   processQueueOnce  a one-off fired at submit time, for speed
 *
 * The one-off is why a ticket number arrives in seconds rather than at the
 * next minute boundary. The recurring one is why a submission still gets its
 * ticket if the one-off never fires.
 */

var WORKER_ONCE = 'processQueueOnce';

/** Stop well before the 6-minute execution ceiling so a run ends cleanly. */
var QUEUE_DEADLINE_MS = 4.5 * 60 * 1000;

/**
 * Ask for the worker to run in a moment. Called on the 3-second path, so it
 * must stay cheap and must never throw.
 *
 * The cache guard bounds trigger creation to one per 20 seconds no matter how
 * many submissions arrive — Apps Script allows only 20 triggers per script,
 * and a burst of submissions would otherwise exhaust them. A skipped kick
 * costs a few seconds of latency, not a ticket: processQueue picks the row up
 * within the minute regardless.
 */
function kickWorker_() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('kick')) return;
    cache.put('kick', '1', 20);

    ScriptApp.newTrigger(WORKER_ONCE).timeBased().after(1000).create();
  } catch (e) {
    debug_('kickWorker_ failed, falling back to the every-minute trigger: ' + e);
  }
}

/** One-off trigger entry point. Clears spent one-offs, then does the work. */
function processQueueOnce() {
  cleanupOnceTriggers_();
  processQueue();
}

/** A one-off trigger survives its own firing, so delete them on sight. */
function cleanupOnceTriggers_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === WORKER_ONCE) {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (e) {
    debug_('cleanupOnceTriggers_ failed: ' + e);
  }
}

/**
 * The worker. Creates tickets first, then uploads attachments — in that
 * order, because a file needs a ticket to attach to, and doing both in one
 * pass means a submission with a screenshot can be completely finished by the
 * time the user looks at their DMs.
 */
function processQueue() {
  var started = Date.now();

  // Runs overlap once a batch takes longer than the trigger interval, and two
  // runs on one row would create the ticket twice.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    debug_('processQueue: another run holds the lock, skipping');
    return;
  }

  try {
    intakeQueuedJobs_();
    createPendingTickets_(started);
    uploadPendingAttachments_(started);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Intake: property store -> Sheet                                     */
/* ------------------------------------------------------------------ */

/**
 * Move submissions from the property store into the Sheet.
 *
 * The submission path writes only properties, because a Sheet write does not
 * reliably fit inside Slack's three seconds. Until this runs, the property IS
 * the record of the submission — which is why it is a property and not a
 * cache entry: CacheService can evict whenever it likes, and an evicted
 * submission is a request the user believes they made and nobody received.
 *
 * The job property is deleted only after its row exists. If this throws
 * halfway, the job is still queued and the next run picks it up; the cost of
 * that is a possible duplicate row, which is visible and fixable, against
 * losing the request entirely, which is neither.
 */
function intakeQueuedJobs_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function (k) { return k.indexOf('job:') === 0; });
  if (!keys.length) return;

  debug_('processQueue: ' + keys.length + ' queued submission(s) to log');

  keys.forEach(function (key) {
    var id = key.slice(4);
    var job;

    try {
      job = JSON.parse(all[key]);
    } catch (e) {
      // Unreadable and unrecoverable; leaving it would retry forever.
      debug_('discarding unreadable job ' + id, truncate_(all[key], 120));
      props.deleteProperty(key);
      return;
    }

    job.bodyKey = id;
    job.description = all['body:' + id] || '';
    job.steps = all['steps:' + id] || '';

    try {
      appendRow_(job);
      props.deleteProperty(key);
    } catch (e) {
      debug_('could not log job ' + id + ', leaving it queued: ' + e);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Ticket creation                                                     */
/* ------------------------------------------------------------------ */

function createPendingTickets_(started) {
  var rows = pendingTicketRows_();
  if (!rows.length) return;

  debug_('processQueue: ' + rows.length + ' ticket(s) to create');

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - started > QUEUE_DEADLINE_MS) {
      debug_('processQueue: deadline reached, ' + (rows.length - i) + ' left for the next run');
      return;
    }
    createTicketForRow_(rows[i]);
  }
}

function createTicketForRow_(row) {
  var rowNum   = row.rowNum;
  var attempts = Number(rowVal_(row.values, 'ticket_attempts') || 0) + 1;
  var bodyKey  = rowVal_(row.values, 'body_key');
  var t        = rowToTicket_(row.values);

  if (!t.description) {
    // The body should always be there; if it is not, the ticket is still
    // worth creating — the subject and the requester are the parts support
    // needs to make contact.
    debug_('body missing for row ' + rowNum + ', creating without it');
    t.description = '(The description could not be recovered. ' +
                    'Please reply to this ticket with the details.)';
  }

  // Post the channel summary first: the outcome is a reply in its thread, so
  // the parent message has to exist before we know the outcome. It also means
  // the channel carries a record of the request even if Freshdesk is down.
  var thread = ensureSummaryPosted_(row, t);

  // Attach at creation where we can, so the ticket is complete the moment it
  // exists. Anything watching for new tickets — a triage bot, an SLA timer,
  // an agent refreshing the queue — then sees every file the requester sent.
  var inline = null;
  if (t.files.length && totalBytes_(t.files) <= MAX_INLINE_ATTACH_BYTES) {
    inline = tryCreateWithAttachments_(t);
  }

  var result = inline ? inline.result : createTicket_(t);
  var submitted = Date.parse(rowVal_(row.values, 'timestamp_iso')) || Date.now();

  if (result.ok) {
    var patch = {
      status: 'created',
      ticket_attempts: attempts,
      freshdesk_ticket_id: result.ticketId,
      http_status: result.httpStatus,
      error: '',
      duration_ms: Date.now() - submitted
    };

    if (inline) {
      // Already on the ticket; nothing left for the attachment pass.
      patch.attach_status = 'done';
      patch.attach_error = '';
      patch.files_json = '';
      t.attachedInline = inline.count;
    }

    updateRow_(rowNum, patch);
    dropBody_(bodyKey);
    notifyCreated_(t, result.ticketId, thread);
    return;
  }

  var giveUp = !result.retryable || attempts >= MAX_TICKET_ATTEMPTS;

  if (!giveUp) {
    // Stays 'pending', so the next run picks it up.
    updateRow_(rowNum, {
      ticket_attempts: attempts,
      http_status: result.httpStatus,
      error: truncate_(result.error, 500)
    });
    debug_('ticket creation retryable, attempt ' + attempts, result.error);
    return;
  }

  updateRow_(rowNum, {
    status: 'failed',
    ticket_attempts: attempts,
    http_status: result.httpStatus,
    error: truncate_(result.error, 500),
    duration_ms: Date.now() - submitted,
    // No ticket means nothing to attach the files to.
    attach_status: t.files.length ? 'failed' : 'none',
    attach_error: t.files.length ? 'ticket was not created' : '',
    files_json: ''
  });
  dropBody_(bodyKey);
  notifyFailed_(t, result.error, thread);

  if (isConfigOutage_(result.httpStatus)) {
    debug_('CONFIG OUTAGE — check the Freshdesk credentials', result.error);
  }
}

/**
 * Post the summary once, and remember where it landed.
 *
 * The ts is written to the row before the ticket is created, so a retryable
 * failure cannot post a second summary on the next run — the channel would
 * otherwise collect one copy per attempt.
 *
 * Returns null when there is nowhere to post: a global shortcut carries no
 * channel, and the app has no chat:write.public so it cannot post to a
 * channel it was never invited to. Callers fall back to a DM.
 */
function ensureSummaryPosted_(row, t) {
  var existing = rowVal_(row.values, 'slack_ts');
  if (existing) return { channel: rowVal_(row.values, 'channel_id'), ts: existing };
  if (!t.channelId) return null;

  var res = postMessage_(t.channelId, summaryFallbackText_(t), buildSummaryBlocks_(t));

  if (!res.ok) {
    debug_('could not post the channel summary', {
      channel: t.channelId,
      error: res.error,
      hint: res.error === 'not_in_channel'
        ? 'invite the bot to that channel, or people will only get a DM'
        : ''
    });
    return null;
  }

  updateRow_(row.rowNum, { slack_ts: res.ts });
  // Slack echoes the resolved channel, which is what a thread_ts must pair with.
  return { channel: res.channel || t.channelId, ts: res.ts };
}

/**
 * Download every file, then create the ticket with all of them attached.
 *
 * Returns null rather than throwing whenever the single-request route cannot
 * be taken — a download that failed, or a body too large to assemble. The
 * caller then creates a plain ticket and the attachment pass picks the files
 * up afterwards. A ticket that is complete a minute late beats no ticket, so
 * this path is never allowed to be the reason one fails.
 */
function tryCreateWithAttachments_(t) {
  var blobs = [];

  for (var i = 0; i < t.files.length; i++) {
    var got = downloadSlackFile_(t.files[i]);
    if (!got.ok) {
      debug_('inline attach abandoned, creating the ticket without it', got.error);
      return null;
    }
    blobs.push(got.blob);
  }

  try {
    return { result: createTicketWithAttachments_(t, blobs), count: blobs.length };
  } catch (e) {
    // Assembling the body puts every byte into script memory, so this is
    // almost always the memory ceiling. probeInlineLimit() finds where that
    // line actually is; MAX_INLINE_ATTACH_BYTES is what to change.
    debug_('inline create failed, falling back to create-then-attach: ' + e);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

function uploadPendingAttachments_(started) {
  var rows = pendingAttachmentRows_();
  if (!rows.length) return;

  debug_('processQueue: ' + rows.length + ' row(s) with files pending');

  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - started > QUEUE_DEADLINE_MS) {
      debug_('processQueue: deadline reached, ' + (rows.length - i) + ' upload(s) left');
      return;
    }
    processAttachmentRow_(rows[i]);
  }
}
