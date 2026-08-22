/**
 * Submit.gs — the view_submission path.
 *
 * Slack gives this THREE SECONDS. Miss it and the user sees "We had some
 * trouble connecting" inside the modal — even when everything worked, because
 * the code carries on running after Slack has stopped listening. That is the
 * worst possible outcome: a ticket is created and the user believes it failed.
 *
 * So nothing here talks to Freshdesk or Slack. The submission is validated,
 * written down, and the modal is closed. Queue.gs does the rest a second or
 * two later and DMs the result.
 *
 * The rule for this file: no network call, and exactly one Sheet write.
 */

function handleViewSubmission_(payload, started) {
  var view = payload.view || {};
  if (view.callback_id !== VIEW_CALLBACK_ID) return emptyResponse_();

  var meta = {};
  try { meta = JSON.parse(view.private_metadata || '{}'); } catch (e) {}

  var t = {
    userId:      payload.user.id,
    userName:    payload.user.username || payload.user.name || payload.user.id,
    channelId:   meta.channelId || '',
    channelName: meta.channelName || '',
    subject:     stateValue_(view.state, 'subject'),
    product:     stateValue_(view.state, 'product'),
    sessionIds:  stateValue_(view.state, 'session_ids'),
    summary:     stateValue_(view.state, 'summary'),
    description: stateValue_(view.state, 'details'),
    steps:       stateValue_(view.state, 'steps'),
    email:       stateValue_(view.state, 'email'),
    ccRaw:       stateValue_(view.state, 'cc_emails'),
    // Not asked for. See DEFAULT_PRIORITY in Config.gs.
    priority:    DEFAULT_PRIORITY,
    files:       stateFiles_(view.state, 'attachments')
  };

  // ---- Validate. This is the ONLY thing that should ever keep the modal
  // ---- open, and it is all local: no call can be slow or flaky here.
  var errors = validate_(t);
  if (errors) return modalErrors_(errors);

  // ---- Suppress duplicates.
  // Slack retries a submission it thinks timed out, and an impatient double
  // click sends two. Either would otherwise file two tickets.
  var cache = CacheService.getScriptCache();
  var idemKey = 'idem:' + t.userId + ':' + view.id;
  if (cache.get(idemKey)) {
    debug_('Duplicate submission suppressed', idemKey);
    return jsonResponse_({ response_action: 'clear' });
  }
  cache.put(idemKey, '1', 600);

  try {
    queueSubmission_(t, started);
    kickWorker_();

  } catch (err) {
    // We could not even write the submission down. This one the user does
    // need to see: their text is still in the form, and retrying is the right
    // move. Every other failure is reported by DM instead.
    debug_('could not queue submission: ' + err + '\n' + (err && err.stack));
    return modalErrors_({
      subject: 'Could not submit just now — please press Create ticket again in a moment.'
    });
  }

  // Replace the form with a confirmation rather than closing it outright, so
  // the requester sees that the submission landed and knows what comes next.
  return jsonResponse_({ response_action: 'update', view: buildConfirmationView_() });
}

/**
 * Write the submission to the Script Property store and return.
 *
 * This used to append a row to the Sheet. SpreadsheetApp is the slowest
 * service Apps Script offers — openById, getSheetByName and appendRow are
 * three round trips before anything is written — and on a cold instance that
 * was enough to push the response past Slack's three-second limit. Slack then
 * shows "We had some trouble connecting" while the code carries on and files
 * the ticket anyway, which is the most confusing outcome available.
 *
 * PropertiesService is a key-value store and a single setProperties call is
 * one round trip. The Sheet row is written by the worker instead, which has
 * six minutes rather than three seconds.
 *
 * Two keys, not one: a property value caps at 9KB, and a 3000-character
 * description in a multi-byte script would fill that on its own.
 */
function queueSubmission_(t, started) {
  var id = Utilities.getUuid();

  var job = {
    id: id,
    receivedIso: nowIso_(),
    userId: t.userId,
    userName: t.userName,
    channelId: t.channelId,
    channelName: t.channelName,
    subject: t.subject,
    ccEmails: t.ccEmails || [],
    product: t.product,
    sessionIds: t.sessionIds,
    summary: t.summary,
    email: t.email,
    priority: t.priority,
    descriptionChars: String(t.description || '').length +
                      String(t.steps || '').length,
    files: t.files,
    // Measured just before the write, so it excludes the write itself and the
    // response. Close enough to be the number worth watching.
    ackMs: Date.now() - started
  };

  var write = {};
  write['job:' + id] = JSON.stringify(job);
  write['body:' + id] = String(t.description || '');
  if (t.steps) write['steps:' + id] = String(t.steps);

  PropertiesService.getScriptProperties().setProperties(write, false);
  debug_('queued job ' + id + ' in ' + job.ackMs + 'ms');
  return id;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validate_(t) {
  var errors = {};

  if (!t.subject || t.subject.length < 5) {
    errors.subject = 'Please give a subject of at least 5 characters.';
  }
  // Slack will not submit an unselected required select, so this only fires
  // if the options list changed under a form someone had open.
  if (!t.product || PRODUCTS.indexOf(t.product) === -1) {
    errors.product = 'Please choose a product.';
  }
  if (!t.summary || t.summary.length < 5) {
    errors.summary = 'Please give a one-line summary of at least 5 characters.';
  }
  if (!t.description || t.description.length < 15) {
    errors.details = 'Please describe the issue in a little more detail (at least 15 characters).';
  }
  if (!isValidEmail_(t.email)) {
    errors.email = 'Please enter a valid email address.';
  }

  var cc = parseEmailList_(t.ccRaw, t.email);
  if (cc.invalid.length) {
    // Name the one that is wrong. "Invalid email" against a field holding six
    // addresses is a guessing game.
    errors.cc_emails = 'This does not look like an email address: ' +
                       truncate_(cc.invalid[0], 60);
  } else if (cc.emails.length > MAX_CC_EMAILS) {
    errors.cc_emails = 'Please list at most ' + MAX_CC_EMAILS + ' addresses.';
  }
  t.ccEmails = cc.emails;

  if (t.files.length > MAX_FILES) {
    errors.attachments = 'Please attach at most ' + MAX_FILES + ' files.';
  } else {
    var bytes = totalBytes_(t.files);
    if (bytes > MAX_ATTACH_TOTAL_BYTES) {
      errors.attachments =
        'Those files total ' + formatBytes_(bytes) + '. The limit is ' +
        formatBytes_(MAX_ATTACH_TOTAL_BYTES) + ' — please remove some and try again.';
    }
  }

  return Object.keys(errors).length ? errors : null;
}

/* ------------------------------------------------------------------ */
/* The channel summary, and the thread under it                        */
/* ------------------------------------------------------------------ */

/**
 * What the channel sees the moment a form is submitted.
 *
 * Posted before the ticket is created, deliberately: the outcome is a reply
 * in this message's thread, so the parent has to exist first. It also means
 * the channel shows the request even when Freshdesk is down, which is the
 * moment a visible record is worth most.
 *
 * Details is truncated. The whole point is something scannable in a busy
 * channel — the full text is on the ticket, and a wall of pasted log lines
 * in the channel helps nobody.
 */
function buildSummaryBlocks_(t) {
  var lines = [];

  lines.push('*Product:* ' + escapeSlack_(t.product || '—'));
  if (t.sessionIds) lines.push('*Session IDs / Build IDs:* ' + escapeSlack_(t.sessionIds));
  lines.push('*Summary:* ' + escapeSlack_(t.summary || t.subject));
  if (t.ccEmails && t.ccEmails.length) {
    lines.push('*CC:* ' + escapeSlack_(t.ccEmails.join(', ')));
  }

  var blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':memo: *New support ticket* — ' + escapeSlack_(truncate_(t.subject, 150)) +
              '\nRaised by <@' + t.userId + '>'
      }
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }
  ];

  if (t.description) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Details:*\n' + escapeSlack_(truncate_(t.description, 600)) }
    });
  }

  var context = [];
  if (t.files && t.files.length) {
    context.push(':paperclip: ' + t.files.length + ' file' +
                 (t.files.length === 1 ? '' : 's') + ' (' + formatBytes_(totalBytes_(t.files)) + ')');
  }
  context.push('Updates go to ' + escapeSlack_(t.email));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }] });

  return blocks;
}

/** Notification text, and the fallback for clients that cannot render blocks. */
function summaryFallbackText_(t) {
  return 'New support ticket: ' + truncate_(t.summary || t.subject, 150);
}

/* ------------------------------------------------------------------ */
/* Messages to the requester                                           */
/* ------------------------------------------------------------------ */

/**
 * Reply in the summary's thread when there is one, otherwise DM.
 *
 * Not both. A threaded reply in the channel the request came from is already
 * visible to the requester and to whoever is watching the channel; adding a
 * DM on top is the same news twice. The DM matters when there is no thread —
 * a global shortcut, a DM with the bot, or a channel the app cannot post to.
 */
function notify_(t, thread, text) {
  if (thread && thread.ts) {
    var res = postMessage_(thread.channel, text, null, thread.ts);
    if (res.ok) return;
    debug_('thread reply failed, falling back to a DM', res.error);
  }
  dmUser_(t.userId, text);
}

function notifyCreated_(t, ticketId, thread) {
  var text = ':white_check_mark: Ticket *#' + ticketId + '* created — *' +
             escapeSlack_(truncate_(t.subject, 120)) + '*';

  if (t.attachedInline) {
    // Already on the ticket, so promise nothing further.
    text += '\n:paperclip: ' + t.attachedInline + ' file' +
            (t.attachedInline === 1 ? '' : 's') + ' attached.';

  } else if (t.files.length) {
    text += '\n:paperclip: Uploading ' + t.files.length + ' file' +
            (t.files.length === 1 ? '' : 's') + ' (' + formatBytes_(totalBytes_(t.files)) +
            ') — I will confirm here when they are attached.';
  }

  text += '\nA support engineer will reply by email to ' + escapeSlack_(t.email) + '.';

  notify_(t, thread, text);
}

function notifyFailed_(t, error, thread) {
  notify_(t, thread,
    ':x: <@' + t.userId + '> your ticket could not be created.\n>' +
    escapeSlack_(truncate_(error, 600)) +
    '\nNothing was lost on your side — please try again, and if it keeps failing, ' +
    'email support directly so you are not blocked.');
}
