/**
 * Freshdesk.gs — REST v2 client.
 *
 * Two calls are used:
 *   POST /api/v2/tickets        create the ticket (JSON, fast)
 *   PUT  /api/v2/tickets/:id    attach one file (multipart, slow)
 *
 * They are separate on purpose. Slack gives a modal 3 seconds to respond and
 * a 25MB upload does not fit in that, so the ticket is created inline and the
 * files are pushed on afterwards by Attach.gs. See README "Why two calls".
 */

function fdBaseUrl_() {
  return 'https://' + cfg_(PROP.FRESHDESK_DOMAIN) + '.freshdesk.com/api/v2';
}

/** Freshdesk basic auth is the API key as the username, literal "X" as the password. */
function fdAuthHeader_() {
  return 'Basic ' + Utilities.base64Encode(cfg_(PROP.FRESHDESK_API_KEY) + ':X');
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * POST /api/v2/tickets
 *
 * Mandatory per the API: a requester identifier (we always send `email`).
 * `subject` and `description` are what make the ticket usable, so both are
 * required in the modal too.
 */
function createTicket_(t) {
  var payload = buildTicketPayload_(t);

  var res = UrlFetchApp.fetch(fdBaseUrl_() + '/tickets', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: fdAuthHeader_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  return parseFdResponse_(res, 201);
}

/**
 * Create the ticket AND its attachments in one request.
 *
 * The ticket exists complete: nothing appends to it afterwards, so anything
 * watching for new tickets — a triage bot, an SLA timer, an agent refreshing
 * the queue — sees every file the requester sent. That is the whole point of
 * doing it this way rather than creating first and attaching after.
 *
 * Every field goes as a multipart part, which means every value is a string.
 * Nested values use Rails bracket notation, the same as the documented curl.
 */
function createTicketWithAttachments_(t, blobs) {
  var payload = buildTicketPayload_(t);
  var fields = [];

  Object.keys(payload).forEach(function (key) {
    var value = payload[key];

    if (value === null || value === undefined) return;

    // tags: repeated key, one part per entry
    if (Object.prototype.toString.call(value) === '[object Array]') {
      value.forEach(function (v) { fields.push({ name: key + '[]', value: String(v) }); });
      return;
    }

    // custom_fields and friends: custom_fields[cf_region]
    if (typeof value === 'object') {
      Object.keys(value).forEach(function (sub) {
        fields.push({ name: key + '[' + sub + ']', value: String(value[sub]) });
      });
      return;
    }

    fields.push({ name: key, value: String(value) });
  });

  // Convert one blob at a time and release it, so the Java-side blob and the
  // JavaScript byte array are not both held for every file at once.
  var files = [];
  for (var i = 0; i < blobs.length; i++) {
    files.push({
      field: 'attachments[]',
      filename: blobs[i].getName(),
      mimeType: blobs[i].getContentType ? blobs[i].getContentType() : 'application/octet-stream',
      bytes: blobs[i].getBytes()
    });
    blobs[i] = null;
  }

  // buildMultipart_ takes ownership of files[].bytes and nulls them.
  var body = buildMultipart_(fields, files);
  files = null;

  var res = UrlFetchApp.fetch(fdBaseUrl_() + '/tickets', {
    method: 'post',
    contentType: body.contentType,
    headers: { Authorization: fdAuthHeader_() },
    payload: body.payload,
    muteHttpExceptions: true
  });

  return parseFdResponse_(res, 201);
}

/**
 * Exactly what gets POSTed. Separate from createTicket_ so testCreateTicket()
 * can print it without sending anything — when Freshdesk rejects a field, the
 * first question is always "what did we actually send?".
 */
function buildTicketPayload_(t) {
  var payload = {
    email:       String(t.email || '').trim(),
    subject:     truncate_(t.subject, MAX_SUBJECT),
    description: buildDescriptionHtml_(t),
    priority:    PRIORITY[t.priority] || PRIORITY[DEFAULT_PRIORITY],
    status:      FD_STATUS_OPEN,
    source:      FD_SOURCE_PORTAL
  };

  // Omit `tags` entirely when there are none. An empty array is not the same
  // as absent to every API, and there is no reason to find out which this is.
  var tags = buildTags_();
  if (tags.length) payload.tags = tags;

  // Same reasoning. Freshdesk copies these on every reply.
  if (t.ccEmails && t.ccEmails.length) payload.cc_emails = t.ccEmails;

  return applyAccountFields_(payload);
}

/**
 * Add whatever this Freshdesk account insists on that the modal does not ask
 * for. Both properties are optional and absent by default.
 *
 * FRESHDESK_GROUP_ID is called out separately from the generic JSON because
 * a mandatory Group is far and away the common case, and `group_id` must be a
 * number — quoting it produces "It should be a/an Positive Integer", which
 * reads like the value is missing rather than the wrong type.
 */
function applyAccountFields_(payload) {
  var groupId = cfg_(PROP.FRESHDESK_GROUP_ID, '');
  if (groupId) {
    var n = Number(groupId);
    if (n > 0) payload.group_id = n;
    else debug_('FRESHDESK_GROUP_ID is not a positive integer, ignoring', groupId);
  }

  var raw = cfg_(PROP.FRESHDESK_EXTRA_FIELDS, '');
  if (raw) {
    try {
      var extra = JSON.parse(raw);
      Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    } catch (e) {
      // Bad JSON here would otherwise fail every ticket for a reason nobody
      // would connect to a property they set once, weeks ago.
      debug_('FRESHDESK_EXTRA_FIELDS is not valid JSON, ignoring it', truncate_(raw, 120));
    }
  }

  return payload;
}

/** Field names FRESHDESK_EXTRA_FIELDS will add. Reported by the health check. */
function extraFieldKeys_() {
  var raw = cfg_(PROP.FRESHDESK_EXTRA_FIELDS, '');
  if (!raw) return [];
  try { return Object.keys(JSON.parse(raw)); }
  catch (e) { return ['(FRESHDESK_EXTRA_FIELDS is not valid JSON)']; }
}

/* ------------------------------------------------------------------ */
/* Attach                                                              */
/* ------------------------------------------------------------------ */

/**
 * PUT /api/v2/tickets/:id with one file.
 *
 * One file per request, deliberately. The multipart field name Freshdesk
 * expects is `attachments[]` — repeated once per file — and a JavaScript
 * object cannot hold the same key twice, so a single request carrying several
 * files would need a hand-rolled multipart body and ~25MB of byte-array
 * concatenation in script memory. Looping is slower on the wire and much
 * harder to get wrong, and it means one bad file cannot fail the others.
 *
 * Passing a Blob as a payload value is what makes UrlFetchApp encode the
 * request as multipart/form-data; do not set contentType yourself here.
 */
function attachFileToTicket_(ticketId, blob) {
  var res = UrlFetchApp.fetch(fdBaseUrl_() + '/tickets/' + ticketId, {
    method: 'put',
    headers: { Authorization: fdAuthHeader_() },
    payload: { 'attachments[]': blob },
    muteHttpExceptions: true
  });

  return parseFdResponse_(res, 200);
}

/* ------------------------------------------------------------------ */
/* Response handling                                                   */
/* ------------------------------------------------------------------ */

function parseFdResponse_(res, okCode) {
  var code = res.getResponseCode();
  var text = res.getContentText() || '';

  if (code === okCode) {
    var id = null;
    try { id = (JSON.parse(text) || {}).id || null; } catch (e) {}
    return { ok: true, httpStatus: code, ticketId: id, error: null, retryable: false };
  }

  return {
    ok: false,
    httpStatus: code,
    ticketId: null,
    error: describeFdError_(code, text),
    // 429 and 5xx are worth another go; everything else is our fault and
    // retrying just burns quota and produces the same failure.
    retryable: (code === 429 || code >= 500)
  };
}

/** Turn a Freshdesk error body into one line a human can act on. */
function describeFdError_(code, text) {
  var detail = '';
  try {
    var body = JSON.parse(text || '{}');
    if (body.errors && body.errors.length) {
      detail = body.errors.map(function (e) {
        return (e.field ? e.field + ': ' : '') + (e.message || e.code || '');
      }).join('; ');
    } else if (body.description) {
      detail = body.description;
    }
  } catch (e) {
    detail = truncate_(text, 200);
  }

  var hint = {
    400: 'Validation failed',
    401: 'Bad API key — check FRESHDESK_API_KEY',
    403: 'API key lacks permission for this action',
    404: 'Not found — check FRESHDESK_DOMAIN, or the ticket was deleted',
    413: 'Payload too large — the file exceeds the Freshdesk attachment limit',
    415: 'Unsupported media type',
    429: 'Rate limited by Freshdesk'
  }[code] || ('HTTP ' + code);

  if (!detail) return hint;
  if (code === 400) return hint + ' (' + truncate_(detail, 200) + ')' + fdAdviceFor_(detail);
  return hint + ' (' + truncate_(detail, 300) + ')';
}

/**
 * What to actually do about a 400. Freshdesk reports these against the API
 * field, but the cause is nearly always an admin setting somewhere else, so a
 * bare relay of the message sends people looking in the wrong place.
 */
function fdAdviceFor_(detail) {
  if (detail.indexOf('cannot_create_new_tag') > -1) {
    return '. This Freshdesk only allows admins to create new tags, and one ' +
           'unknown tag fails the whole ticket. Either create the tag in ' +
           'Freshdesk first, or clear the FRESHDESK_TAGS script property';
  }

  return '. If that field is mandatory under Freshdesk Admin -> Ticket Fields, ' +
         'either make it optional there or set FRESHDESK_GROUP_ID / ' +
         'FRESHDESK_EXTRA_FIELDS in Script Properties';
}

/** 401/403/404 mean the integration is misconfigured, not that one request was bad. */
function isConfigOutage_(httpStatus) {
  return httpStatus === 401 || httpStatus === 403 || httpStatus === 404;
}

/* ------------------------------------------------------------------ */
/* Field mapping                                                       */
/* ------------------------------------------------------------------ */

/**
 * Freshdesk renders `description` as HTML, so user text must be escaped or a
 * pasted stack trace containing <tags> silently disappears from the ticket —
 * and a crafted one would inject markup.
 *
 * The footer says only where the ticket came from. It used to name the Slack
 * user, their ID and the channel, which is more than an agent needs and puts
 * internal identifiers on a record the requester can read. Who filed it, from
 * where and when is all in the Sheet log, which is the right place for it.
 */
function buildDescriptionHtml_(t) {
  var html = '';

  html += inlineSection_('Product', t.product);
  if (t.sessionIds) html += inlineSection_('Session IDs / Build IDs', t.sessionIds);
  if (t.summary)    html += inlineSection_('Summary', t.summary);

  html += blockSection_('Details', t.description);
  if (t.steps) html += blockSection_('Steps to reproduce', t.steps);

  return html + '<hr><p><small>Created from Slack</small></p>';
}

/** A one-line field: label and value on the same line. */
function inlineSection_(label, value) {
  return '<p><b>' + escapeHtml_(label) + ':</b> ' + escapeHtml_(value) + '</p>';
}

/** A multi-line field: label on its own line, body beneath, breaks preserved. */
function blockSection_(label, value) {
  return '<p><b>' + escapeHtml_(label) + ':</b></p>' +
         '<p>' + textToHtml_(value) + '</p>';
}

/**
 * Tags are opt-in and static, which is not where this started.
 *
 * Freshdesk can be set so that only admins create new tags. Under that
 * setting an agent API key does not silently skip an unknown tag — it fails
 * the entire create call with `cannot_create_new_tag`, so one tag costs you
 * the ticket. A per-channel tag is a new tag by definition and can never work
 * that way, so the channel is recorded in the description footer instead,
 * which needs no permissions and cannot fail.
 *
 * FRESHDESK_TAGS is a comma-separated list of tags that ALREADY EXIST in
 * Freshdesk. Empty (the default) sends no tags at all.
 */
function buildTags_() {
  return cfg_(PROP.FRESHDESK_TAGS, '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(String);
}

/** Agent-facing ticket URL, for the log and internal messages. */
function ticketUrl_(id) {
  return 'https://' + cfg_(PROP.FRESHDESK_DOMAIN) + '.freshdesk.com/a/tickets/' + id;
}
