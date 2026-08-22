/**
 * Attach.gs — pushing the modal's files onto a ticket that already exists.
 *
 * Called by Queue.gs, which owns the trigger and the lock. One row at a time,
 * one file per request.
 */

function processAttachmentRow_(row) {
  var rowNum   = row.rowNum;
  var ticketId = rowVal_(row.values, 'freshdesk_ticket_id');
  var userId   = rowVal_(row.values, 'slack_user_id');
  var attempts = Number(rowVal_(row.values, 'attach_attempts') || 0) + 1;

  var files;
  try {
    files = JSON.parse(rowVal_(row.values, 'files_json') || '[]');
  } catch (e) {
    updateRow_(rowNum, { attach_status: 'failed', attach_attempts: attempts,
                         attach_error: 'files_json is not readable' });
    return;
  }

  if (!files.length) {
    updateRow_(rowNum, { attach_status: 'done', attach_attempts: attempts });
    return;
  }

  var remaining = [];   // transient failures, worth another run
  var permanent = [];   // rejected outright — retrying changes nothing
  var attached  = 0;

  for (var i = 0; i < files.length; i++) {
    var file = files[i];

    var got = downloadSlackFile_(file);
    if (!got.ok) {
      // A missing scope looks identical to a transient blip from here, so
      // treat download failures as retryable and let the attempt cap end it.
      remaining.push(file);
      debug_('download failed', got.error);
      continue;
    }

    var put = attachFileToTicket_(ticketId, got.blob);
    if (put.ok) {
      attached++;
    } else if (put.retryable) {
      remaining.push(file);
      debug_('attach retryable', put.error);
    } else {
      permanent.push({ name: file.name, error: put.error });
      debug_('attach permanent failure', put.error);
    }
  }

  var giveUp = attempts >= MAX_ATTACH_ATTEMPTS;
  var done   = remaining.length === 0;

  if (done || giveUp) {
    var status = (permanent.length || remaining.length) ? 'partial' : 'done';
    if (attached === 0) status = 'failed';

    updateRow_(rowNum, {
      attach_status: status,
      attach_attempts: attempts,
      attach_error: truncate_(describeAttachFailures_(permanent, remaining), 500),
      // Clear the Slack file references once we are finished with them —
      // they are download URLs, and the log has a wider audience than the
      // files do.
      files_json: ''
    });

    notifyAttachOutcome_(row, userId, ticketId, attached, permanent, remaining);

  } else {
    // Keep only what still needs doing, so the next run cannot re-upload a
    // file that already succeeded and leave duplicates on the ticket.
    updateRow_(rowNum, {
      attach_status: 'pending',
      attach_attempts: attempts,
      attach_error: truncate_(describeAttachFailures_(permanent, remaining), 500),
      files_json: JSON.stringify(remaining)
    });
  }
}

function describeAttachFailures_(permanent, remaining) {
  var parts = [];
  permanent.forEach(function (p) { parts.push(p.name + ': ' + p.error); });
  remaining.forEach(function (f) { parts.push(f.name + ': not uploaded yet'); });
  return parts.join(' | ');
}

/**
 * Report where the request was raised, not by DM, when we have a thread.
 *
 * This only runs on the fallback route, where files are uploaded after the
 * ticket exists. Whoever is watching the channel has already seen the summary
 * and the ticket number; a late file is part of the same story and belongs in
 * the same thread.
 */
function notifyAttachOutcome_(row, userId, ticketId, attached, permanent, remaining) {
  if (!userId) return;

  var ts = rowVal_(row.values, 'slack_ts');
  var t = { userId: userId };
  var thread = ts ? { channel: rowVal_(row.values, 'channel_id'), ts: ts } : null;

  var failed = permanent.length + remaining.length;

  if (!failed) {
    notify_(t, thread, ':paperclip: ' + attached + ' file' + (attached === 1 ? '' : 's') +
                       ' attached to ticket *#' + ticketId + '*.');
    return;
  }

  var names = permanent.map(function (p) { return p.name; })
                .concat(remaining.map(function (f) { return f.name; }));

  notify_(t, thread,
    ':warning: <@' + userId + '> ' +
    (attached ? attached + ' of ' + (attached + failed) + ' files were'
              : 'your files could not be') +
    ' attached to ticket *#' + ticketId + '*.' +
    '\nStill missing: ' + escapeSlack_(names.join(', ')) +
    '\nThe ticket itself is fine — please reply to the Freshdesk email with these files attached.');
}
