/**
 * Slack.gs — Slack Web API client and file download.
 */

function slackApi_(method, payload) {
  var res = UrlFetchApp.fetch('https://slack.com/api/' + method, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + cfg_(PROP.SLACK_BOT_TOKEN) },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var body;
  try {
    body = JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    debug_('slackApi_ non-JSON from ' + method, truncate_(res.getContentText(), 200));
    return { ok: false, error: 'invalid_json' };
  }

  if (!body.ok) {
    debug_('slackApi_ ' + method + ' failed', {
      error: body.error,
      detail: slackErrorDetail_(body) || '(none returned)'
    });
  }
  return body;
}

/**
 * Slack names the exact offending field in response_metadata.messages, e.g.
 * "invalid value for field 'max_length' [json-pointer:/view/blocks/1/element]".
 *
 * Without it a bare `invalid_arguments` means hunting through the whole view
 * JSON by hand, so it is worth surfacing everywhere rather than logging the
 * error code alone.
 */
function slackErrorDetail_(body) {
  var messages = body && body.response_metadata && body.response_metadata.messages;
  return (messages && messages.length) ? messages.join('; ') : '';
}

function openView_(triggerId, view) {
  return slackApi_('views.open', { trigger_id: triggerId, view: view });
}

/**
 * `text` is not optional even when blocks are supplied: it is what appears in
 * notifications and on clients that cannot render blocks.
 */
function postMessage_(channel, text, blocks, threadTs) {
  var p = { channel: channel, text: text };
  if (blocks) p.blocks = blocks;
  if (threadTs) p.thread_ts = threadTs;
  return slackApi_('chat.postMessage', p);
}

/** DM a user. Passing a user ID as the channel opens (or reuses) the IM. */
function dmUser_(userId, text, blocks) {
  return postMessage_(userId, text, blocks);
}

/* ------------------------------------------------------------------ */
/* File download                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch a file the user attached in the modal.
 *
 * Two traps here, both of which return HTTP 200 and so look like success:
 *
 *  1. Without a valid bot token and the files:read scope, Slack serves an
 *     HTML sign-in page instead of the file. The bytes are a web page, and
 *     Freshdesk would happily accept them as the "attachment".
 *  2. url_private redirects; url_private_download is the direct one. Use it.
 *
 * So the content type is checked rather than trusted.
 */
function downloadSlackFile_(file) {
  var url = file.url_private_download || file.url_private;
  if (!url) return { ok: false, error: 'file has no download URL' };

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + cfg_(PROP.SLACK_BOT_TOKEN) },
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: 'download threw: ' + e };
  }

  var code = res.getResponseCode();
  if (code !== 200) {
    return { ok: false, error: 'Slack returned HTTP ' + code + ' for ' + file.name };
  }

  var headers = res.getAllHeaders() || {};
  var ctype = String(headers['Content-Type'] || headers['content-type'] || '');

  // The sign-in page tell. A genuine HTML *attachment* would have been
  // uploaded as text/html too, so also require that the file itself did not
  // claim to be HTML before rejecting.
  if (ctype.indexOf('text/html') === 0 && String(file.mimetype || '').indexOf('html') === -1) {
    return {
      ok: false,
      error: 'Slack served a login page instead of "' + file.name +
             '" — the bot token is missing the files:read scope, or cannot see this file'
    };
  }

  var blob = res.getBlob().setName(file.name || 'attachment');
  return { ok: true, blob: blob, bytes: blob.getBytes().length };
}
