/**
 * Util.gs — small helpers with no Apps Script service dependencies beyond
 * Utilities, so they are all directly testable.
 */

function nowIso_() {
  return new Date().toISOString();
}

/** Constant-time-ish string compare, so the shared secret cannot be probed. */
function safeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Escape for embedding in Freshdesk's HTML description. */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text -> HTML, preserving line breaks. Escapes first. */
function textToHtml_(s) {
  return escapeHtml_(s).replace(/\r\n|\r|\n/g, '<br>');
}

function truncate_(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Deliberately permissive. Freshdesk is the authority on whether an address
 * is real; this only catches typos like a missing @ before we spend an API
 * call on it.
 */
function isValidEmail_(email) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(email || '').trim());
}

/** Human-readable bytes, for messages to the user. */
function formatBytes_(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Slack mrkdwn is not markdown: only these three need neutralising. */
function escapeSlack_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function debug_(msg, extra) {
  try {
    console.log(String(msg) + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  } catch (e) {
    console.log(String(msg));
  }
}

/**
 * Turn whatever someone typed into a CC field into a list of addresses.
 *
 * People paste "a@x.com, b@y.com", or with semicolons, or one per line, or
 * with a trailing comma. All of those mean the same thing, so accept them all
 * rather than making the form the place they find out otherwise.
 *
 * Returns {emails, invalid}: valid addresses, deduplicated and with `exclude`
 * removed, plus anything that did not look like an address at all, so the
 * caller can name the offending one instead of rejecting the whole field.
 */
function parseEmailList_(raw, exclude) {
  var seen = {};
  var emails = [];
  var invalid = [];

  String(raw || '').split(/[,;\s]+/).forEach(function (part) {
    // Slack turns a pasted address into <mailto:a@b.com|a@b.com>.
    var value = part.trim()
      .replace(/^<mailto:/i, '')
      .replace(/^</, '')
      .replace(/>$/, '');
    if (value.indexOf('|') > -1) value = value.split('|')[0];
    if (!value) return;

    if (!isValidEmail_(value)) {
      invalid.push(value);
      return;
    }

    var key = value.toLowerCase();
    if (key === String(exclude || '').trim().toLowerCase()) return;   // already the requester
    if (seen[key]) return;
    seen[key] = true;
    emails.push(value);
  });

  return { emails: emails, invalid: invalid };
}
