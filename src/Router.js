/**
 * Router.gs — the single HTTP entry point.
 *
 * SECURITY NOTE, read before changing anything here:
 * Apps Script does not expose request headers to doPost, so Slack's
 * X-Slack-Signature CANNOT be verified — the standard HMAC check is simply
 * not available on this platform. What stands in for it:
 *
 *   1. a 32-byte shared secret in the query string, checked before we parse
 *      anything at all, and
 *   2. api_app_id matching our own app.
 *
 * That makes the deployment URL a credential. It must never appear in a
 * repo, a Slack message, or a screenshot. Rotating it is a two-minute job:
 * rotateSharedSecret(), then update both URLs in the Slack app config.
 */

function doPost(e) {
  var started = Date.now();

  try {
    // ---- Gate 1: shared secret --------------------------------------
    if (!safeEquals_((e && e.parameter && e.parameter.s) || '', cfg_(PROP.SHARED_SECRET))) {
      debug_('REJECT: bad or missing shared secret');
      return emptyResponse_();
    }

    // ---- Slack URL verification handshake (setup only) --------------
    if (e.postData && e.postData.type === 'application/json') {
      var body = JSON.parse(e.postData.contents || '{}');
      if (body.type === 'url_verification') {
        return jsonResponse_({ challenge: body.challenge });
      }
    }

    // ---- Interactivity: button clicks and modal submissions ---------
    if (e.parameter.payload) {
      var payload = JSON.parse(e.parameter.payload);
      if (!checkAppId_(payload.api_app_id)) return emptyResponse_();

      switch (payload.type) {
        case 'block_actions':   return handleBlockActions_(payload);
        case 'view_submission': return handleViewSubmission_(payload, started);
        case 'shortcut':
        case 'message_action':  return handleShortcut_(payload);
        case 'view_closed':     return emptyResponse_();
        default:
          debug_('Unhandled interactivity type', payload.type);
          return emptyResponse_();
      }
    }

    // ---- Slash command ----------------------------------------------
    if (e.parameter.command) {
      if (!checkAppId_(e.parameter.api_app_id)) return emptyResponse_();
      return handleSlashCommand_(e.parameter);
    }

    debug_('Unrecognised request shape');
    return emptyResponse_();

  } catch (err) {
    // Never return a stack trace to Slack.
    debug_('doPost fatal: ' + err + '\n' + (err && err.stack));
    return emptyResponse_();
  }
}

/** Health check. Confirms the deployment is live without touching Slack or Freshdesk. */
function doGet(e) {
  if (!safeEquals_((e && e.parameter && e.parameter.s) || '', cfg_(PROP.SHARED_SECRET))) {
    return ContentService.createTextOutput('forbidden');
  }
  // The limits are here on purpose: they are the cheapest way to tell a live
  // deployment from a stale one. maxDescription reading 20000 rather than
  // 3000, for instance, means Slack is calling an older version than the one
  // you just pushed.
  return jsonResponse_({
    ok: true,
    service: 'slack-freshdesk',
    build: BUILD,
    time: nowIso_(),
    limits: {
      maxSubject: MAX_SUBJECT,
      maxDetails: MAX_DETAILS,
      maxSteps: MAX_STEPS,
      maxFiles: MAX_FILES,
      maxAttachBytes: MAX_ATTACH_TOTAL_BYTES,
      products: PRODUCTS
    },
    // Neither of these is a secret, and they are the only way to tell
    // "I set the property" apart from "the running code can see the
    // property" — which are not the same thing, and look identical from
    // Slack.
    account: {
      groupId: cfg_(PROP.FRESHDESK_GROUP_ID, '') || null,
      extraFields: extraFieldKeys_(),
      tags: buildTags_()
    }
  });
}

function checkAppId_(appId) {
  var expected = cfg_(PROP.SLACK_APP_ID, '');
  if (expected && appId && !safeEquals_(appId, expected)) {
    debug_('REJECT: app_id mismatch', appId);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Opening the modal                                                   */
/* ------------------------------------------------------------------ */

function handleSlashCommand_(p) {
  openTicketModal_(p.trigger_id, {
    userId: p.user_id,
    channelId: p.channel_id,
    channelName: p.channel_name,
    prefillSubject: (p.text || '').trim()
  });
  return emptyResponse_();   // empty 200 = the command posts nothing itself
}

function handleBlockActions_(payload) {
  var action = (payload.actions && payload.actions[0]) || {};
  if (action.action_id !== LAUNCH_ACTION_ID) return emptyResponse_();

  openTicketModal_(payload.trigger_id, {
    userId: payload.user.id,
    channelId: (payload.channel && payload.channel.id) || '',
    channelName: (payload.channel && payload.channel.name) || ''
  });
  return emptyResponse_();
}

function handleShortcut_(payload) {
  openTicketModal_(payload.trigger_id, {
    userId: payload.user.id,
    channelId: (payload.channel && payload.channel.id) || '',
    channelName: (payload.channel && payload.channel.name) || '',
    // Message shortcut: seed Details with the message text, so raising a
    // ticket from a conversation does not mean retyping it.
    prefillDetails: (payload.message && payload.message.text) || ''
  });
  return emptyResponse_();
}

/**
 * Slack invalidates a trigger_id 3 seconds after issuing it, so this path
 * does exactly one Slack call and nothing else — no Sheet, no Freshdesk.
 */
function openTicketModal_(triggerId, ctx) {
  var res = openView_(triggerId, buildModal_(ctx));

  // A failed views.open is invisible to the user: the form just never
  // appears. Say so, rather than leaving them clicking a dead button.
  if (!res.ok) {
    var detail = slackErrorDetail_(res);
    debug_('views.open failed', { error: res.error, detail: detail });

    dmUser_(ctx.userId,
      ':warning: Could not open the ticket form (' + (res.error || 'unknown error') + ').' +
      // Pass the detail through. It is not pretty, but it names the broken
      // field, and the alternative is the user relaying "it did not work".
      (detail ? '\n>' + escapeSlack_(truncate_(detail, 300)) : '') +
      '\nPlease try again — if it keeps happening, email support directly.');
  }
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function emptyResponse_() {
  return ContentService.createTextOutput('');
}
