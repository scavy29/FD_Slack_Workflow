require('./mock');
const fs = require('fs');
for (const f of ['Config','Util','Multipart','Freshdesk','Slack','Modal','Sheet','Router','Submit','Attach','Queue','Setup'])
  eval(fs.readFileSync(__dirname + '/../src/' + f + '.js', 'utf8'));

// sheet_() caches its handle for the lifetime of an execution. Apps Script
// gives every run a fresh process; this suite does not, so drop the handle
// whenever the fake spreadsheet is replaced.
const resetSheets = () => { global.__resetSheets(); _sheet = null; };

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  cond ? (pass++, console.log('  PASS ' + name))
       : (fail++, console.log('  FAIL ' + name, extra === undefined ? '' : extra));
};
const MB = 1024 * 1024;
const file = (name, size, extra) => Object.assign(
  { id: 'F' + name, name, mimetype: 'image/png', size,
    url_private_download: 'https://files.slack.com/' + name }, extra || {});

console.log('\n-- validation --');
const good = {
  subject: 'Login is broken', product: 'Automate', summary: 'Cannot log in',
  sessionIds: '', description: 'x'.repeat(20), steps: '',
  email: 'a@b.com', files: []
};
check('accepts a valid submission', validate_(good) === null);
check('rejects short subject', !!validate_(Object.assign({}, good, { subject: 'hi' })).subject);
check('rejects a missing product', !!validate_(Object.assign({}, good, { product: '' })).product);
check('rejects a product not on the list',
  !!validate_(Object.assign({}, good, { product: 'Not A Product' })).product);
check('accepts every listed product',
  PRODUCTS.every(p => validate_(Object.assign({}, good, { product: p })) === null));
check('rejects a short summary', !!validate_(Object.assign({}, good, { summary: 'hi' })).summary);
check('rejects short details', !!validate_(Object.assign({}, good, { description: 'help' })).details);
check('session ids are optional', validate_(Object.assign({}, good, { sessionIds: '' })) === null);
check('steps are optional', validate_(Object.assign({}, good, { steps: '' })) === null);
check('rejects malformed email', !!validate_(Object.assign({}, good, { email: 'nope' })).email);
check('rejects email with no domain dot', !!validate_(Object.assign({}, good, { email: 'a@b' })).email);
check('rejects too many files',
  !!validate_(Object.assign({}, good, { files: Array.from({length: 11}, (_, i) => file('f' + i, 10)) })).attachments);
check('rejects over the 25MB total',
  !!validate_(Object.assign({}, good, { files: [file('big.zip', 26 * MB)] })).attachments);
check('accepts exactly 25MB',
  validate_(Object.assign({}, good, { files: [file('edge.zip', 25 * MB)] })) === null);
check('oversize message names the real total',
  validate_(Object.assign({}, good, { files: [file('a', 20 * MB), file('b', 10 * MB)] }))
    .attachments.indexOf('30.0 MB') > -1);

console.log('\n-- CC addresses --');
check('a plain list parses', parseEmailList_('a@x.com, b@y.com').emails.join() === 'a@x.com,b@y.com');
check('semicolons work too', parseEmailList_('a@x.com; b@y.com').emails.length === 2);
check('newlines work too', parseEmailList_('a@x.com\nb@y.com').emails.length === 2);
check('a trailing comma is not an empty address',
  parseEmailList_('a@x.com,').emails.length === 1);
check('duplicates collapse, case-insensitively',
  parseEmailList_('a@x.com, A@X.com').emails.length === 1);
// Slack rewrites a pasted address into a mailto link.
check('a Slack mailto link is unwrapped',
  parseEmailList_('<mailto:a@x.com|a@x.com>').emails.join() === 'a@x.com');
check('the requester is not CCd on their own ticket',
  parseEmailList_('a@x.com, me@x.com', 'me@x.com').emails.join() === 'a@x.com');
check('exclusion ignores case', parseEmailList_('ME@x.com', 'me@x.com').emails.length === 0);
check('a bad address is reported, not silently dropped',
  parseEmailList_('a@x.com, notanemail').invalid.join() === 'notanemail');
check('empty input is empty, not an error',
  parseEmailList_('').emails.length === 0 && parseEmailList_('').invalid.length === 0);

check('CC is optional', validate_(Object.assign({}, good, { ccRaw: '' })) === null);
check('a good CC list passes',
  validate_(Object.assign({}, good, { ccRaw: 'a@x.com, b@y.com' })) === null);
check('a bad CC address names the offender',
  (validate_(Object.assign({}, good, { ccRaw: 'a@x.com, oops' })).cc_emails || '')
    .indexOf('oops') > -1);
check('too many addresses rejected',
  !!validate_(Object.assign({}, good, {
    ccRaw: Array.from({ length: MAX_CC_EMAILS + 1 }, (_, i) => 'a' + i + '@x.com').join(',')
  })).cc_emails);
check('validation leaves the parsed list on the ticket', (function () {
  const t = Object.assign({}, good, { ccRaw: 'a@x.com , b@y.com' });
  validate_(t);
  return t.ccEmails.join() === 'a@x.com,b@y.com';
})());

const ccTicket = { email: 'me@x.com', subject: 'Login is broken', product: 'Automate',
                   summary: 'Cannot log in', description: 'd', priority: 'Low',
                   userId: 'U1', files: [] };
global.__resetFetches();
createTicket_(Object.assign({}, ccTicket, { ccEmails: ['a@x.com', 'b@y.com'] }));
check('cc_emails sent to Freshdesk',
  JSON.parse(global.__fetches[0].opts.payload).cc_emails.join() === 'a@x.com,b@y.com');
global.__resetFetches();
createTicket_(ccTicket);
check('cc_emails omitted entirely when empty',
  JSON.parse(global.__fetches[0].opts.payload).cc_emails === undefined);

global.__resetFetches();
global.__responder = () => ({ code: 201, body: '{"id":45231}' });
createTicketWithAttachments_(Object.assign({}, ccTicket, { ccEmails: ['a@x.com', 'b@y.com'] }),
                             [Utilities.newBlob('A', 'image/png', 'x.png')]);
check('cc_emails repeat as multipart parts',
  (Buffer.from(global.__fetches[0].opts.payload).toString('latin1')
    .match(/name="cc_emails\[\]"/g) || []).length === 2);

check('CC shown on the channel summary',
  JSON.stringify(buildSummaryBlocks_({ userId: 'U1', subject: 's', product: 'Percy',
    summary: 'x', email: 'me@x.com', ccEmails: ['a@x.com'], files: [] }))
    .indexOf('*CC:*') > -1);
check('no CC line when there are none',
  JSON.stringify(buildSummaryBlocks_({ userId: 'U1', subject: 's', product: 'Percy',
    summary: 'x', email: 'me@x.com', ccEmails: [], files: [] }))
    .indexOf('*CC:*') === -1);

console.log('\n-- description layout --');
const full = buildDescriptionHtml_({
  product: 'App Automate',
  sessionIds: 'abc123, def456',
  summary: 'Facing issue with login on Chrome',
  description: 'Tom & Jerry <script>alert(1)</script>\nsecond line',
  steps: '1. Open the app\n2. Tap login',
  userName: 'D&V', userId: 'U1', channelName: 'support'
});
check('product labelled in bold', full.indexOf('<b>Product:</b> App Automate') > -1);
check('session ids labelled', full.indexOf('<b>Session IDs / Build IDs:</b> abc123, def456') > -1);
check('summary labelled', full.indexOf('<b>Summary:</b> Facing issue with login') > -1);
check('details on its own line', full.indexOf('<b>Details:</b></p><p>') > -1);
check('steps on its own line', full.indexOf('<b>Steps to reproduce:</b></p><p>') > -1);
check('sections in the order the form asks for them',
  full.indexOf('Product:') < full.indexOf('Session IDs') &&
  full.indexOf('Session IDs') < full.indexOf('Summary:') &&
  full.indexOf('Summary:') < full.indexOf('Details:') &&
  full.indexOf('Details:') < full.indexOf('Steps to reproduce:'));
check('script tag neutralised', full.indexOf('<script>') === -1, full.slice(0, 80));
check('newline in details became <br>', full.indexOf('second line') > -1 && full.indexOf('<br>') > -1);
check('ampersand escaped in the body', full.indexOf('Tom &amp; Jerry') > -1);
check('footer says only where it came from', full.indexOf('Created from Slack') > -1);
// The requester can read the ticket; internal identifiers do not belong on it.
check('footer does NOT name the slack user', full.indexOf('D&amp;V') === -1);
check('footer does NOT carry the slack user id', full.indexOf('U1') === -1);
check('footer does NOT name the channel', full.indexOf('#support') === -1);

const bare = buildDescriptionHtml_({ product: 'Percy', summary: 'x', description: 'y' });
check('empty session ids leave no empty heading', bare.indexOf('Session IDs') === -1);
check('empty steps leave no empty heading', bare.indexOf('Steps to reproduce') === -1);

console.log('\n-- create ticket request --');
global.__resetFetches();
const created = createTicket_({
  email: 'a@b.com', subject: 'Login is broken', product: 'Automate',
  summary: 'Cannot log in', description: 'detail here',
  priority: 'High', userId: 'U1', userName: 'dv', channelName: 'support', files: []
});
const req = global.__fetches[0];
const sent = JSON.parse(req.opts.payload);
check('201 parsed into a ticket id', created.ok && created.ticketId === 45231);
check('posts to /api/v2/tickets', req.url === 'https://sandbox.freshdesk.com/api/v2/tickets');
check('sends JSON', req.opts.contentType === 'application/json');
check('basic auth is apikey:X', req.opts.headers.Authorization ===
  'Basic ' + Buffer.from('KEY:X').toString('base64'));
check('email sent as requester', sent.email === 'a@b.com');
check('priority High mapped to 3', sent.priority === 3);
check('priority defaults to Low when unset',
  (function () {
    global.__resetFetches();
    createTicket_({ email: 'a@b.com', subject: 's', product: 'Percy',
                    summary: 'x', description: 'd', userId: 'U', files: [] });
    return JSON.parse(global.__fetches[0].opts.payload).priority === PRIORITY[DEFAULT_PRIORITY];
  })());
check('status Open = 2', sent.status === 2);
check('source Portal = 2', sent.source === 2);
check('no tags sent by default', sent.tags === undefined);
global.__resetFetches();
createTicket_({ email: 'a@b.com', subject: 'y'.repeat(400), product: 'Automate',
                summary: 'x', description: 'd', priority: 'Low', userId: 'U1', files: [] });
check('subject truncated to 255',
  JSON.parse(global.__fetches[0].opts.payload).subject.length <= 255);

console.log('\n-- account-specific mandatory fields --');
// Freshdesk enforces "mandatory on creation" ticket fields at the API, so a
// field the modal never asks about can still fail the call.
global.__resetFetches();
const baseTicket = { email: 'a@b.com', subject: 'Login is broken', product: 'Automate',
                     summary: 'Cannot log in', description: 'd',
                     priority: 'Low', userId: 'U1', files: [] };
createTicket_(baseTicket);
check('no group_id sent when the property is unset',
  JSON.parse(global.__fetches[0].opts.payload).group_id === undefined);

PropertiesService.getScriptProperties().setProperty('FRESHDESK_GROUP_ID', '42');
global.__resetFetches();
createTicket_(baseTicket);
check('group_id sent when set', JSON.parse(global.__fetches[0].opts.payload).group_id === 42);
check('group_id sent as a NUMBER, not a string',
  typeof JSON.parse(global.__fetches[0].opts.payload).group_id === 'number');

PropertiesService.getScriptProperties().setProperty('FRESHDESK_GROUP_ID', 'not-a-number');
global.__resetFetches();
createTicket_(baseTicket);
check('non-numeric group_id ignored rather than sent',
  JSON.parse(global.__fetches[0].opts.payload).group_id === undefined);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_GROUP_ID', '');

PropertiesService.getScriptProperties().setProperty(
  'FRESHDESK_EXTRA_FIELDS', '{"type":"Question","custom_fields":{"cf_region":"APAC"}}');
global.__resetFetches();
createTicket_(baseTicket);
let extraSent = JSON.parse(global.__fetches[0].opts.payload);
check('extra fields merged into the payload', extraSent.type === 'Question');
check('nested extra fields survive', extraSent.custom_fields.cf_region === 'APAC');
check('extra fields do not clobber the basics', extraSent.email === 'a@b.com' && extraSent.status === 2);

PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '{broken json');
global.__resetFetches();
const stillWorks = createTicket_(baseTicket);
check('bad JSON ignored rather than failing every ticket', stillWorks.ok === true);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '');

check('optional properties are not reported missing', missingProperties_().length === 0);

console.log('\n-- tags --');
// Freshdesk can be set so only admins create tags. An agent key then fails
// the WHOLE create call on one unknown tag, so tags are opt-in and static.
PropertiesService.getScriptProperties().setProperty('FRESHDESK_TAGS', 'slack, escalations');
global.__resetFetches();
createTicket_(baseTicket);
const tagged = JSON.parse(global.__fetches[0].opts.payload);
check('configured tags sent', tagged.tags.join(',') === 'slack,escalations');
check('whitespace around tags trimmed', tagged.tags[1] === 'escalations');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_TAGS', ' , ,');
global.__resetFetches();
createTicket_(baseTicket);
check('a property of only separators sends no tags',
  JSON.parse(global.__fetches[0].opts.payload).tags === undefined);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_TAGS', '');
check('who filed it is still recorded, in the log rather than the ticket',
  HEADERS.indexOf('slack_user_id') > -1 && HEADERS.indexOf('channel_name') > -1);

console.log('\n-- error classification --');
const err = (code, body) => {
  global.__resetFetches();
  global.__responder = () => ({ code, body: body || '{}' });
  return createTicket_({ email: 'a@b.com', subject: 's', product: 'Automate',
                         summary: 'x', description: 'd', priority: 'Low', userId: 'U', files: [] });
};
check('400 is not retryable', err(400).retryable === false);
check('401 is not retryable', err(401).retryable === false);
check('404 is not retryable', err(404).retryable === false);
check('413 is not retryable', err(413).retryable === false);
check('429 is retryable', err(429).retryable === true);
check('500 is retryable', err(500).retryable === true);
check('503 is retryable', err(503).retryable === true);
check('401/403/404 flagged as config outage',
  isConfigOutage_(401) && isConfigOutage_(403) && isConfigOutage_(404) && !isConfigOutage_(429));
check('field error surfaced to the user',
  err(400, JSON.stringify({ errors: [{ field: 'email', message: 'is invalid' }] }))
    .error.indexOf('email: is invalid') > -1);
// The exact failure that hit us: group_id rejected though we never sent it.
const groupErr = err(400, JSON.stringify({ errors: [
  { field: 'group_id', message: 'It should be a/an Positive Integer', code: 'datatype_mismatch' }] })).error;
check('a 400 points at Freshdesk ticket-field settings',
  groupErr.indexOf('Admin -> Ticket Fields') > -1);
check('a 400 names the property that fixes it',
  groupErr.indexOf('FRESHDESK_GROUP_ID') > -1);
check('non-400 errors stay terse', err(500).error.indexOf('Admin -> Ticket Fields') === -1);
// A tag rejection is not a mandatory-field problem, and saying so sends
// people to the wrong settings page.
const tagErr = err(400, JSON.stringify({ errors: [
  { field: 'tags', message: 'cannot_create_new_tag: slack', code: 'invalid_value' }] })).error;
check('a tag rejection explains the admin-only tag setting',
  tagErr.indexOf('only allows admins to create new tags') > -1);
check('a tag rejection names FRESHDESK_TAGS', tagErr.indexOf('FRESHDESK_TAGS') > -1);
check('a tag rejection does NOT mislead about mandatory fields',
  tagErr.indexOf('Admin -> Ticket Fields') === -1);
check('413 explains the size limit', err(413).error.indexOf('too large') > -1);

console.log('\n-- multipart assembly --');
const mp = buildMultipart_(
  [{ name: 'subject', value: 'Login is broken' },
   { name: 'tags[]', value: 'slack' },
   { name: 'tags[]', value: 'escalations' }],
  [{ field: 'attachments[]', filename: 'a.png', mimeType: 'image/png', bytes: [1, 2, 3] },
   { field: 'attachments[]', filename: 'b.log', mimeType: 'text/plain', bytes: [4, 5] }],
  'BOUND');
const raw = Buffer.from(mp.payload).toString('latin1');
check('content type names the boundary',
  mp.contentType === 'multipart/form-data; boundary=BOUND');
// 3 fields + 2 files + the closing delimiter.
check('one boundary per part plus the terminator', raw.split('--BOUND').length === 7);
check('body ends with the closing boundary', raw.trim().endsWith('--BOUND--'));
check('field part well formed',
  raw.indexOf('Content-Disposition: form-data; name="subject"\r\n\r\nLogin is broken\r\n') > -1);
// The whole reason this file exists: a repeated field name, which an object
// literal cannot express.
check('repeated field name sent twice',
  (raw.match(/name="tags\[\]"/g) || []).length === 2);
check('both tag values present',
  raw.indexOf('\r\n\r\nslack\r\n') > -1 && raw.indexOf('\r\n\r\nescalations\r\n') > -1);
check('file part carries filename and type',
  raw.indexOf('name="attachments[]"; filename="a.png"\r\nContent-Type: image/png') > -1);
check('two attachment parts', (raw.match(/name="attachments\[\]"/g) || []).length === 2);
check('file bytes survive verbatim',
  mp.payload.join(',').indexOf('1,2,3') > -1 && mp.payload.join(',').indexOf('4,5') > -1);
check('CRLF after each file body', raw.indexOf('\u0001\u0002\u0003\r\n--BOUND') > -1);

// A quote or newline in a filename would close the header early and let the
// rest be read as multipart syntax.
const evil = buildMultipart_([], [{ field: 'attachments[]', bytes: [0],
  filename: 'a"\r\nContent-Disposition: form-data; name="email', mimeType: 'text/plain' }], 'B');
const evilRaw = Buffer.from(evil.payload).toString('latin1');
check('quotes stripped from filenames', evilRaw.indexOf('filename="a"') === -1);
// The text may survive inside the quoted filename; what must not survive is
// the CRLF that would turn it into a header line of its own.
check('injected header cannot start a new line',
  (evilRaw.match(/\r\nContent-Disposition/g) || []).length === 1);
check('quotes inside the filename cannot close it', evilRaw.indexOf('name="email') === -1);
check('the whole filename stays on the one header line',
  evilRaw.split('\r\n')[1].indexOf('filename=') > -1 &&
  evilRaw.split('\r\n')[2].indexOf('Content-Type:') === 0);
check('empty inputs still produce a valid body',
  Buffer.from(buildMultipart_([], [], 'B').payload).toString('latin1') === '--B--\r\n');

// Peak memory decides whether 25MB assembles at all, so the source bytes must
// not still be reachable once they are in the body.
const owned = [{ field: 'attachments[]', filename: 'a.bin',
                 mimeType: 'application/octet-stream', bytes: [9, 9, 9] }];
const ownedBody = buildMultipart_([], owned, 'B');
check('caller reference to file bytes is released', owned[0].bytes === null);
check('but the bytes did reach the body',
  Buffer.from(ownedBody.payload).toString('latin1').indexOf('\u0009\u0009\u0009') > -1);

console.log('\n-- create with attachments (one request) --');
global.__resetFetches();
global.__responder = () => ({ code: 201, body: '{"id":45231}' });
const withFiles = createTicketWithAttachments_(
  { email: 'a@b.com', subject: 'Login is broken', product: 'Automate',
    summary: 'Cannot log in', description: 'detail', priority: 'Low',
    userId: 'U1', files: [] },
  [Utilities.newBlob('AAA', 'image/png', 'one.png'),
   Utilities.newBlob('BBB', 'image/png', 'two.png')]);
const cwaReq = global.__fetches[0];
const cwaRaw = Buffer.from(cwaReq.opts.payload).toString('latin1');
check('one request, not one per file', global.__fetches.length === 1);
check('ticket id parsed', withFiles.ok && withFiles.ticketId === 45231);
check('posts to /tickets', cwaReq.url.endsWith('/api/v2/tickets'));
check('multipart content type', cwaReq.opts.contentType.indexOf('multipart/form-data') === 0);
check('both files in the one body',
  cwaRaw.indexOf('filename="one.png"') > -1 && cwaRaw.indexOf('filename="two.png"') > -1);
check('ticket fields ride along',
  cwaRaw.indexOf('name="subject"') > -1 && cwaRaw.indexOf('name="email"') > -1);
check('numbers sent as strings', cwaRaw.indexOf('name="status"\r\n\r\n2\r\n') > -1);
check('description built the same as the JSON route',
  cwaRaw.indexOf('<b>Product:</b> Automate') > -1);

PropertiesService.getScriptProperties().setProperty('FRESHDESK_TAGS', 'slack, urgent');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '{"custom_fields":{"cf_region":"APAC"}}');
global.__resetFetches();
createTicketWithAttachments_({ email: 'a@b.com', subject: 's', product: 'Percy',
  summary: 'x', description: 'd', priority: 'Low', userId: 'U', files: [] },
  [Utilities.newBlob('A', 'image/png', 'x.png')]);
const tagRaw = Buffer.from(global.__fetches[0].opts.payload).toString('latin1');
check('array fields become repeated parts',
  (tagRaw.match(/name="tags\[\]"/g) || []).length === 2);
check('nested fields use bracket notation',
  tagRaw.indexOf('name="custom_fields[cf_region]"\r\n\r\nAPAC') > -1);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_TAGS', '');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '');

console.log('\n-- attach request (fallback route) --');
global.__resetFetches();
global.__responder = () => ({ code: 200, body: '{}' });
const blob = Utilities.newBlob('binary-content', 'image/png', 'shot.png');
const putRes = attachFileToTicket_(45231, blob);
const putReq = global.__fetches[0];
check('attach succeeded on 200', putRes.ok);
check('PUTs to the ticket', putReq.url === 'https://sandbox.freshdesk.com/api/v2/tickets/45231');
check('uses PUT', putReq.opts.method === 'put');
check('field name is attachments[]', 'attachments[]' in putReq.opts.payload);
check('sends the blob, not a string', typeof putReq.opts.payload['attachments[]'].getBytes === 'function');
check('no contentType set (UrlFetchApp must choose multipart)',
  putReq.opts.contentType === undefined);

console.log('\n-- slack file download --');
global.__resetFetches();
global.__responder = () => ({ code: 200, body: '<html>Sign in to Slack</html>',
                              headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const login = downloadSlackFile_(file('shot.png', 1000));
check('login page rejected, not attached as the file', !login.ok);
check('rejection names the missing scope', login.error.indexOf('files:read') > -1);

global.__resetFetches();
global.__responder = () => ({ code: 200, raw: 'PNGDATA', headers: { 'Content-Type': 'image/png' } });
const dl = downloadSlackFile_(file('shot.png', 7));
check('real file downloads', dl.ok && dl.bytes === 7);
check('uses url_private_download', global.__fetches[0].url === 'https://files.slack.com/shot.png');
check('sends the bot token', global.__fetches[0].opts.headers.Authorization === 'Bearer xoxb-test');

global.__resetFetches();
global.__responder = () => ({ code: 404, body: 'nope' });
check('404 reported, not silently empty', !downloadSlackFile_(file('gone.png', 1)).ok);

console.log('\n-- modal --');
const view = buildModal_({ channelId: 'C1', channelName: 'support', knownEmail: 'a@b.com' });
const byId = {};
view.blocks.forEach(b => { byId[b.block_id] = b; });
check('callback_id set', view.callback_id === VIEW_CALLBACK_ID);
check('has every field the form asks for',
  !!(byId.subject && byId.product && byId.session_ids && byId.summary &&
     byId.details && byId.steps && byId.attachments && byId.email));
check('product is a dropdown of the listed products',
  byId.product.element.type === 'static_select' &&
  byId.product.element.options.map(o => o.value).join() === PRODUCTS.join());
check('product is required', byId.product.optional === undefined);
check('summary is required', byId.summary.optional === undefined);
check('details is required', byId.details.optional === undefined);
check('details is multiline', byId.details.element.multiline === true);
check('steps is optional', byId.steps.optional === true);
check('steps is multiline', byId.steps.element.multiline === true);
check('session ids optional', byId.session_ids.optional === true);
check('priority is not asked for', byId.priority === undefined);
check('fields in the order the ticket reads',
  view.blocks.map(b => b.block_id).join() ===
  'subject,product,session_ids,summary,details,steps,attachments,email,cc_emails');
check('attachments block is optional', byId.attachments.optional === true);
check('attachments uses file_input', byId.attachments.element.type === 'file_input');
check('file_input capped at 10', byId.attachments.element.max_files === 10);
check('hint states the size limit', byId.attachments.hint.text.indexOf('25.0 MB') > -1);
check('email prefilled when known', byId.email.element.initial_value === 'a@b.com');
check('private_metadata carries the channel',
  JSON.parse(view.private_metadata).channelName === 'support');
check('email left blank when unknown',
  buildModal_({}).blocks.find(b => b.block_id === 'email').element.initial_value === undefined);

console.log('\n-- slack view limits (views.open rejects the lot if any is broken) --');
const inputs = view.blocks.filter(b => b.type === 'input');
check('no field length exceeds what Slack accepts',
  [MAX_SUBJECT, MAX_SUMMARY, MAX_SESSION_IDS, MAX_DETAILS, MAX_STEPS]
    .every(n => n >= 1 && n <= SLACK_MAX_INPUT));
// Details is held in a 9KB script property between submit and create.
check('details fits a script property even in three-byte characters',
  MAX_DETAILS * 3 <= 9 * 1024);
check('steps has its own property, so it need not share the headroom',
  MAX_STEPS * 3 <= 9 * 1024);
check('every max_length within 1..3000',
  inputs.every(b => b.element.max_length === undefined ||
    (b.element.max_length >= 1 && b.element.max_length <= SLACK_MAX_INPUT)),
  inputs.map(b => b.block_id + ':' + b.element.max_length).join(' '));
check('every placeholder within 150 chars',
  inputs.every(b => !b.element.placeholder || b.element.placeholder.text.length <= 150));
check('every label within 2000 chars', inputs.every(b => b.label.text.length <= 2000));
check('every hint within 2000 chars',
  inputs.every(b => !b.hint || b.hint.text.length <= 2000));
check('modal title within 24 chars', view.title.text.length <= 24);
check('submit label within 24 chars', view.submit.text.length <= 24);
check('close label within 24 chars', view.close.text.length <= 24);
check('private_metadata within 3000 chars', view.private_metadata.length <= 3000);
check('at most 100 blocks', view.blocks.length <= 100);
check('every block_id unique',
  new Set(view.blocks.map(b => b.block_id)).size === view.blocks.length);

check('slack error detail extracted when present',
  slackErrorDetail_({ response_metadata: { messages: ['invalid value for field max_length'] } })
    .indexOf('max_length') > -1);
check('slack error detail empty when absent', slackErrorDetail_({ error: 'x' }) === '');

console.log('\n-- the in-channel launcher --');
// The button and the router are edited at different times, and a launcher
// already posted in a channel keeps working for as long as the message
// exists. A rename on one side alone breaks every button in the wild, and
// Slack shows nothing at all when it happens.
const launcher = buildLauncherBlocks_();
const btn = launcher.find(b => b.type === 'actions').elements[0];
check('launcher offers a button', btn.type === 'button');
check('button action_id is the shared constant', btn.action_id === LAUNCH_ACTION_ID);

// The editor's Run button passes no arguments, so the channel has to be
// reachable without one.
global.__resetFetches();
postLauncher();
check('no channel and no property: explains, does not throw',
  global.__fetches.length === 0 &&
  global.__logs.join(' ').indexOf('LAUNCHER_CHANNEL_ID') > -1);

PropertiesService.getScriptProperties().setProperty('LAUNCHER_CHANNEL_ID', 'C_FROM_PROP');
global.__resetFetches();
postLauncher();
check('falls back to the script property',
  JSON.parse(global.__fetches[0].opts.payload).channel === 'C_FROM_PROP');
global.__resetFetches();
postLauncher('C_EXPLICIT');
check('an explicit argument still wins',
  JSON.parse(global.__fetches[0].opts.payload).channel === 'C_EXPLICIT');
check('the posted message carries the button',
  JSON.stringify(JSON.parse(global.__fetches[0].opts.payload).blocks)
    .indexOf(LAUNCH_ACTION_ID) > -1);
PropertiesService.getScriptProperties().setProperty('LAUNCHER_CHANNEL_ID', '');
check('the optional property is not reported missing',
  missingProperties_().indexOf('LAUNCHER_CHANNEL_ID') === -1);

global.__resetFetches();
const opened = handleBlockActions_({
  api_app_id: 'A123',
  user: { id: 'U1' },
  channel: { id: 'C1', name: 'support' },
  trigger_id: 'T1',
  actions: [{ action_id: LAUNCH_ACTION_ID }]
});
const viewsOpen = global.__fetches.filter(f => f.url.indexOf('views.open') > -1);
check('clicking it opens the form', viewsOpen.length === 1);
check('the form knows which channel it came from',
  JSON.parse(JSON.parse(viewsOpen[0].opts.payload).view.private_metadata).channelName === 'support');
check('the click itself posts nothing', opened.getContent() === '');

global.__resetFetches();
handleBlockActions_({ api_app_id: 'A123', user: { id: 'U1' }, trigger_id: 'T1',
                      actions: [{ action_id: 'something_else' }] });
check('other buttons ignored', global.__fetches.length === 0);

// Raising a ticket from a conversation should not mean retyping it.
global.__resetFetches();
handleShortcut_({ api_app_id: 'A123', user: { id: 'U1' },
                  channel: { id: 'C1', name: 'support' }, trigger_id: 'T1',
                  message: { text: 'the build died at 3am' } });
const shortcutView = JSON.parse(global.__fetches[0].opts.payload).view;
check('message shortcut prefills Details, the field that exists now',
  shortcutView.blocks.find(b => b.block_id === 'details').element.initial_value
    === 'the build died at 3am');
check('slash command still prefills Subject',
  buildModal_({ prefillSubject: 'hi there' }).blocks
    .find(b => b.block_id === 'subject').element.initial_value === 'hi there');

console.log('\n-- parsing view.state --');
const state = { values: {
  subject:     { value: { type: 'plain_text_input', value: '  Login is broken  ' } },
  product:     { value: { type: 'static_select', selected_option: { value: 'Percy' } } },
  attachments: { value: { type: 'file_input', files: [
    { id: 'F1', name: 'a.png', mimetype: 'image/png', size: 120,
      url_private: 'https://x/redirect', url_private_download: 'https://x/direct' }
  ]}}
}};
check('text trimmed', stateValue_(state, 'subject') === 'Login is broken');
check('select value read', stateValue_(state, 'product') === 'Percy');
check('missing block is empty string', stateValue_(state, 'nope') === '');
check('files parsed', stateFiles_(state, 'attachments').length === 1);
check('prefers url_private_download over url_private',
  stateFiles_(state, 'attachments')[0].url_private_download === 'https://x/direct');
check('skipped optional file input yields []',
  stateFiles_({ values: {} }, 'attachments').length === 0);
check('empty files array yields []',
  stateFiles_({ values: { attachments: { value: { type: 'file_input', files: [] } } } }, 'attachments').length === 0);
check('unexpected action_id still parsed',
  stateValue_({ values: { subject: { other_id: { value: 'hi' } } } }, 'subject') === 'hi');

console.log('\n-- sheet --');
resetSheets(); global.__resetFetches();
const rowNum = appendRow_({ userId: 'U1', userName: 'dv', email: 'a@b.com',
  channelId: 'C1', channelName: 'support', subject: 'Login is broken',
  product: 'Percy', sessionIds: 'sess-1', summary: 'Cannot log in',
  description: 'sensitive customer detail', steps: 'secret repro steps',
  priority: 'High',
  files: [file('a.png', 100), file('b.png', 200)] });
const stored = __tab('ticket_log')._rows[0];
check('first data row is row 2', rowNum === 2);
check('row width matches headers', stored.length === HEADERS.length);
check('details TEXT not stored',
  stored.join('|').indexOf('sensitive customer detail') === -1);
check('steps TEXT not stored', stored.join('|').indexOf('secret repro steps') === -1);
check('product, session ids and summary ARE stored, for reporting',
  stored[col_('product') - 1] === 'Percy' &&
  stored[col_('session_ids') - 1] === 'sess-1' &&
  stored[col_('summary') - 1] === 'Cannot log in');
check('description length IS stored', stored[col_('description_chars') - 1] === 25);
check('file count and bytes recorded',
  stored[col_('file_count') - 1] === 2 && stored[col_('file_bytes') - 1] === 300);
check('status starts pending', stored[col_('status') - 1] === 'pending');
check('attach_status pending when files present', stored[col_('attach_status') - 1] === 'pending');
check('files_json retained for the worker',
  JSON.parse(stored[col_('files_json') - 1]).length === 2);
updateRow_(rowNum, { status: 'created', freshdesk_ticket_id: 45231 });
check('updateRow patches named columns',
  __tab('ticket_log')._rows[0][col_('status') - 1] === 'created');
check('updateRow leaves other columns alone',
  __tab('ticket_log')._rows[0][col_('subject') - 1] === 'Login is broken');
resetSheets();
appendRow_({ userId: 'U1', subject: 's', product: 'Automate', summary: 'x',
             description: 'd', priority: 'Low', files: [] });
check('attach_status none when no files',
  __tab('ticket_log')._rows[0][col_('attach_status') - 1] === 'none');

console.log('\n-- schema migration --');
// The bug this guards: slack_ts was added in the MIDDLE of HEADERS, so every
// row already in the sheet was read one column out. status came back as the
// attempt count and the ticket id as an HTTP status, with nothing erroring.
// A frozen snapshot of the schema. New columns go on the END of this list;
// changing an existing position silently misreads every row already written.
const SCHEMA = [
  'timestamp_iso', 'slack_user_id', 'slack_user_name', 'requester_email',
  'channel_id', 'channel_name', 'subject', 'product', 'session_ids', 'summary',
  'priority', 'description_chars', 'file_count', 'file_bytes', 'status',
  'ticket_attempts', 'freshdesk_ticket_id', 'http_status', 'error',
  'attach_status', 'attach_attempts', 'attach_error', 'files_json', 'body_key',
  'ack_ms', 'duration_ms', 'slack_ts', 'cc_emails'
];
check('no existing column has moved',
  HEADERS.slice(0, SCHEMA.length).join() === SCHEMA.join(),
  '\n    expected: ' + SCHEMA.join() + '\n    actual:   ' + HEADERS.join());
check('anything newer was appended, not inserted', HEADERS.length >= SCHEMA.length);
check('no duplicate column names', new Set(HEADERS).size === HEADERS.length);

console.log('\n-- the product list --');
check('within Slack\'s 100 options', PRODUCTS.length <= 100);
check('every label within Slack\'s 75 characters', PRODUCTS.every(p => p.length <= 75));
check('no duplicates', new Set(PRODUCTS).size === PRODUCTS.length);
check('nothing blank or padded', PRODUCTS.every(p => p && p === p.trim()));
// The chosen value is written verbatim into the ticket and into the reporting
// column, so a typo here is permanent in the data.
check('no double letters that look like typos',
  PRODUCTS.every(p => !/([a-z])\1{2,}|iia|aii/i.test(p)), PRODUCTS.join(' | '));

resetSheets();
const sh = __tab('ticket_log');
// A sheet written by the previous schema: same columns, minus the newest.
const oldHeaders = HEADERS.slice(0, -1);
sh.getRange(1, 1, 1, oldHeaders.length).setValues([oldHeaders]);
const oldRow = oldHeaders.map(h => 'v_' + h);
sh.appendRow(oldRow);

ensureHeaders_(sh);
check('the new column is appended', sh._header.join() === HEADERS.join());
check('an existing row still reads correctly afterwards',
  rowVal_(sh._rows[0], 'status') === 'v_status' &&
  rowVal_(sh._rows[0], 'freshdesk_ticket_id') === 'v_freshdesk_ticket_id');
const newest = HEADERS[HEADERS.length - 1];
check('and the new column reads empty rather than shifting',
  rowVal_(sh._rows[0], newest) === undefined || rowVal_(sh._rows[0], newest) === '');
resetSheets();

console.log('\n-- submit: acknowledge fast, work later --');
const submission = (viewId, files) => ({
  user: { id: 'U1', username: 'dv' },
  view: {
    id: viewId, callback_id: VIEW_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId: 'C1', channelName: 'support' }),
    state: { values: {
      subject:     { value: { value: 'Login is broken' } },
      product:     { value: { selected_option: { value: 'Automate' } } },
      session_ids: { value: { value: 'sess-abc' } },
      summary:     { value: { value: 'Cannot log in' } },
      details:     { value: { value: 'It fails every time I try.' } },
      steps:       { value: { value: '1. open\n2. click login' } },
      email:       { value: { value: 'a@b.com' } },
      attachments: { value: { type: 'file_input', files: files || [] } }
    }}
  }
});

// Freshdesk answers 201 to a create and 200 to an attach; conflating them
// makes a successful upload look like a permanent failure.
const SLACK_OK = { code: 200, body: '{"ok":true,"ts":"1700000000.000100","channel":"C1"}' };

const liveResponder = (url, opts) => {
  if (url.indexOf('files.slack.com') > -1)
    return { code: 200, raw: 'DATA', headers: { 'Content-Type': 'image/png' } };
  if (url.indexOf('freshdesk') > -1)
    return opts.method === 'put' ? { code: 200, body: '{}' } : { code: 201, body: '{"id":45231}' };
  return SLACK_OK;
};

const fresh = () => {
  resetSheets(); global.__resetFetches(); global.__clearCache(); global.__resetTriggers();
  Object.keys(__props).forEach(k => { if (/^(job|body):/.test(k)) delete __props[k]; });
  global.__responder = liveResponder;
};
const jobKeys = () => Object.keys(__props).filter(k => k.indexOf('job:') === 0);

fresh();
let out = handleViewSubmission_(submission('V1'), Date.now());
const ack = JSON.parse(out.getContent());
check('the form is replaced, not left showing an error', ack.response_action === 'update');
check('a confirmation view comes back', ack.view && ack.view.type === 'modal');
check('confirmation says an update is coming',
  JSON.stringify(ack.view.blocks).indexOf('ticket number will arrive') > -1);
check('confirmation cannot be resubmitted', ack.view.submit === undefined);
check('confirmation can be dismissed', ack.view.close.text === 'Done');
check('confirmation title within 24 chars', ack.view.title.text.length <= 24);

// The whole point: Slack allows 3s, so this path waits on nothing.
check('NO network call on the 3-second path', global.__fetches.length === 0);
check('NO spreadsheet touched on the 3-second path',
  __tab('ticket_log')._rows.length === 0);

check('submission queued as a property', jobKeys().length === 1);
const job = JSON.parse(__props[jobKeys()[0]]);
check('ack time recorded, so the 3s budget is measurable', typeof job.ackMs === 'number');
check('description queued under its own key',
  __props['body:' + job.id] === 'It fails every time I try.');
// A property value caps at 9KB; a long description must not share the key.
check('description text is not inside the job metadata',
  __props[jobKeys()[0]].indexOf('It fails every time') === -1);
check('files queued with the job', job.files.length === 0);
check('worker kicked for immediate processing',
  __triggers.some(t => t.getHandlerFunction() === 'processQueueOnce'));

global.__resetFetches();
processQueue();
let logRow = __tab('ticket_log')._rows[0];
check('worker logs the submission', !!logRow);
check('logged against submission time, not worker time',
  logRow[col_('timestamp_iso') - 1] === job.receivedIso);
check('ack time carried through into the log', logRow[col_('ack_ms') - 1] === job.ackMs);
check('description length logged',
  logRow[col_('description_chars') - 1] === job.descriptionChars);
check('product logged for reporting', logRow[col_('product') - 1] === 'Automate');
check('summary logged', logRow[col_('summary') - 1] === 'Cannot log in');
check('priority always Low', logRow[col_('priority') - 1] === 'Low');
check('description text still kept out of the sheet',
  logRow.join('|').indexOf('It fails every time') === -1);
check('job property cleared once the row exists', jobKeys().length === 0);
check('worker creates the ticket', logRow[col_('status') - 1] === 'created');
check('ticket id logged', logRow[col_('freshdesk_ticket_id') - 1] === 45231);
check('attempt counted', logRow[col_('ticket_attempts') - 1] === 1);
check('queued description consumed by the ticket',
  JSON.parse(global.__fetches.filter(f => f.url.indexOf('freshdesk') > -1)[0].opts.payload)
    .description.indexOf('It fails every time') > -1);
check('body deleted once the ticket exists',
  __props['body:' + logRow[col_('body_key') - 1]] === undefined);
check('duration measured from submission, not from the worker',
  typeof logRow[col_('duration_ms') - 1] === 'number');

const posts = global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1)
  .map(f => JSON.parse(f.opts.payload));
check('two channel messages: the summary and its reply', posts.length === 2);

const summary = posts[0];
const reply = posts[1];
check('summary goes to the channel the form was opened from', summary.channel === 'C1');
check('summary posted before the ticket exists — nothing to thread under yet',
  summary.thread_ts === undefined);
check('summary names the requester',
  JSON.stringify(summary.blocks).indexOf('<@U1>') > -1);
check('summary shows the product', JSON.stringify(summary.blocks).indexOf('Automate') > -1);
check('summary shows the one-line summary',
  JSON.stringify(summary.blocks).indexOf('Cannot log in') > -1);
check('summary carries fallback text for notifications',
  summary.text.indexOf('New support ticket') > -1);
check('summary ts recorded on the row',
  logRow[col_('slack_ts') - 1] === '1700000000.000100');

check('the outcome is a reply in that thread', reply.thread_ts === '1700000000.000100');
check('reply carries the ticket number', reply.text.indexOf('#45231') > -1);
check('reply does not link to the agent ticket, which guests cannot open',
  reply.text.indexOf('/a/tickets/') === -1);
check('no DM as well — the thread already told everyone',
  posts.every(p => p.channel !== 'U1'));

global.__resetFetches();
processQueue();
check('a finished row is not processed again', global.__fetches.length === 0);


global.__resetFetches();
out = handleViewSubmission_(submission('V1'), Date.now());
check('duplicate submission of the same view suppressed', jobKeys().length === 0);
check('duplicate still gets a clean response',
  JSON.parse(out.getContent()).response_action !== 'errors');

// A retryable failure must not post a second summary on the next run, or the
// channel collects one copy per attempt.
const failFreshdesk = url => url.indexOf('freshdesk') > -1 ? { code: 500, body: 'boom' } : SLACK_OK;
fresh();
global.__responder = failFreshdesk;
handleViewSubmission_(submission('V8'), Date.now());
processQueue();
const firstRun = global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1)
  .map(f => JSON.parse(f.opts.payload));
check('summary posted once on the first attempt', firstRun.length === 1);
check('and it is the summary, not a reply', firstRun[0].thread_ts === undefined);

global.__resetFetches();
global.__responder = failFreshdesk;      // __resetFetches clears it
processQueue();
check('a retry still failing posts nothing at all',
  global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1).length === 0);

// And when it finally succeeds, the outcome threads under the original
// summary rather than starting a second one.
global.__resetFetches();
processQueue();
const recovered = global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1)
  .map(f => JSON.parse(f.opts.payload));
check('recovery posts exactly one message', recovered.length === 1);
check('it threads under the original summary',
  recovered[0].thread_ts === '1700000000.000100');
check('never a second summary',
  __tab('ticket_log')._rows[0][col_('slack_ts') - 1] === '1700000000.000100');

console.log('\n-- submit with attachments: complete at creation --');
fresh();
handleViewSubmission_(submission('V2', [file('a.png', 100), file('b.png', 200)]), Date.now());
check('files queued, still nothing sent', global.__fetches.length === 0);
check('file metadata rides with the job',
  JSON.parse(__props[jobKeys()[0]]).files[0].name === 'a.png');
processQueue();
logRow = __tab('ticket_log')._rows[0];
check('ticket created with its files', logRow[col_('status') - 1] === 'created');
check('nothing left for the attachment pass', logRow[col_('attach_status') - 1] === 'done');
check('no follow-up work queued', logRow[col_('files_json') - 1] === '');

const fdCalls = global.__fetches.filter(f => f.url.indexOf('freshdesk') > -1);
check('ONE Freshdesk call, not create-then-attach-per-file', fdCalls.length === 1);
check('it is the create', fdCalls[0].url.endsWith('/api/v2/tickets'));
check('carrying both files',
  (Buffer.from(fdCalls[0].opts.payload).toString('latin1').match(/filename=/g) || []).length === 2);
check('no PUT at all', global.__fetches.every(f => f.opts.method !== 'put'));

const msgs = global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1)
  .map(f => JSON.parse(f.opts.payload));
check('summary plus one reply — nothing arrives later', msgs.length === 2);
check('summary counts the files', JSON.stringify(msgs[0].blocks).indexOf('2 files') > -1);
check('reply gives the ticket number', msgs[1].text.indexOf('#45231') > -1);
check('reply says the files are already attached',
  msgs[1].text.indexOf('2 files attached') > -1);
check('reply promises no follow-up', msgs[1].text.indexOf('Uploading') === -1);

console.log('\n-- attachments too large to assemble: falls back --');
// The inline limit now equals the upload cap, so no permitted submission can
// exceed it. Lower it for this one case to prove the fallback still works —
// it is what protects a future raise of the upload cap, and an assembly that
// throws.
const realInlineLimit = MAX_INLINE_ATTACH_BYTES;
MAX_INLINE_ATTACH_BYTES = 50;
fresh();
handleViewSubmission_(submission('V6', [file('huge.zip', 100)]), Date.now());
processQueue();
logRow = __tab('ticket_log')._rows[0];
check('ticket still created', logRow[col_('status') - 1] === 'created');
check('files handed to the attachment pass in the same run',
  logRow[col_('attach_status') - 1] === 'done');
check('create-then-attach used instead',
  global.__fetches.filter(f => f.opts.method === 'put').length === 1);
check('requester told the files are following, in the thread',
  global.__fetches.filter(f => f.url.indexOf('chat.postMessage') > -1)
    .map(f => JSON.parse(f.opts.payload))
    .some(m => m.thread_ts && m.text.indexOf('Uploading 1 file') > -1));
MAX_INLINE_ATTACH_BYTES = realInlineLimit;

// The invariant that keeps every real ticket on the good route.
check('every permitted upload can be assembled in one request',
  MAX_INLINE_ATTACH_BYTES >= MAX_ATTACH_TOTAL_BYTES);

console.log('\n-- a file that will not download: ticket still gets made --');
fresh();
global.__responder = (url, opts) => {
  if (url.indexOf('files.slack.com') > -1) return { code: 500, body: 'boom' };
  if (url.indexOf('freshdesk') > -1)
    return opts.method === 'put' ? { code: 500, body: 'boom' } : { code: 201, body: '{"id":45231}' };
  return SLACK_OK;
};
handleViewSubmission_(submission('V7', [file('a.png', 100)]), Date.now());
processQueue();
logRow = __tab('ticket_log')._rows[0];
check('a failed download does not block the ticket', logRow[col_('status') - 1] === 'created');
check('the file stays queued for another attempt',
  logRow[col_('attach_status') - 1] === 'pending');

console.log('\n-- ticket creation failures --');
fresh();
global.__responder = url => url.indexOf('freshdesk') > -1
  ? { code: 400, body: JSON.stringify({ errors: [{ field: 'email', message: 'is invalid' }] }) }
  : SLACK_OK;
handleViewSubmission_(submission('V3', [file('a.png', 100)]), Date.now());
processQueue();
logRow = __tab('ticket_log')._rows[0];
check('a 400 fails the row immediately', logRow[col_('status') - 1] === 'failed');
check('failure reason logged', String(logRow[col_('error') - 1]).indexOf('email') > -1);
check('no orphan attachment job when the ticket failed',
  logRow[col_('attach_status') - 1] === 'failed' && logRow[col_('files_json') - 1] === '');
check('body cleaned up on permanent failure',
  __props['body:' + logRow[col_('body_key') - 1]] === undefined);
check('failure reported in the thread, not by a broken modal',
  global.__fetches.some(f => f.url.indexOf('chat.postMessage') > -1 &&
    JSON.parse(f.opts.payload).thread_ts === '1700000000.000100' &&
    JSON.parse(f.opts.payload).text.indexOf('could not be created') > -1));

fresh();
global.__responder = url => url.indexOf('freshdesk') > -1
  ? { code: 500, body: 'boom' } : SLACK_OK;
handleViewSubmission_(submission('V5'), Date.now());
processQueue();
logRow = __tab('ticket_log')._rows[0];
check('a 500 leaves the row pending for another go', logRow[col_('status') - 1] === 'pending');
check('body kept while a retry is still possible',
  __props['body:' + logRow[col_('body_key') - 1]] !== undefined);
processQueue(); processQueue();
logRow = __tab('ticket_log')._rows[0];
check('gives up at the attempt cap',
  logRow[col_('status') - 1] === 'failed' &&
  logRow[col_('ticket_attempts') - 1] === MAX_TICKET_ATTEMPTS);

console.log('\n-- validation rejects before anything is written --');
fresh();
const bad = submission('V4');
bad.view.state.values.email.value.value = 'not-an-email';
out = handleViewSubmission_(bad, Date.now());
check('errors returned to the modal',
  JSON.parse(out.getContent()).response_action === 'errors');
check('nothing logged for an invalid submission', __tab('ticket_log')._rows.length === 0);
check('nothing queued for an invalid submission', jobKeys().length === 0);
check('no worker kicked for an invalid submission', __triggers.length === 0);
check('no network call at all', global.__fetches.length === 0);

console.log('\n-- attachment worker --');
function seedPending(files, opts) {
  resetSheets();
  appendRow_({ userId: 'U1', subject: 's', product: 'Automate', summary: 'x',
               description: 'd', priority: 'Low', files });
  updateRow_(2, Object.assign({ status: 'created', freshdesk_ticket_id: 45231 }, opts || {}));
  return __tab('ticket_log')._rows[0];
}

seedPending([file('a.png', 10)]);
check('pending row picked up', pendingAttachmentRows_().length === 1);
updateRow_(2, { attach_status: 'done' });
check('completed row not picked up again', pendingAttachmentRows_().length === 0);
seedPending([file('a.png', 10)], { freshdesk_ticket_id: '' });
check('row with no ticket id skipped', pendingAttachmentRows_().length === 0);

seedPending([file('a.png', 10), file('b.png', 20)]);
global.__resetFetches();
global.__responder = url => url.indexOf('files.slack.com') > -1
  ? { code: 200, raw: 'DATA', headers: { 'Content-Type': 'image/png' } }
  : { code: 200, body: '{}' };
processQueue();
let r = __tab('ticket_log')._rows[0];
check('both files attached', r[col_('attach_status') - 1] === 'done');
check('file references cleared once done', r[col_('files_json') - 1] === '');
check('one PUT per file',
  global.__fetches.filter(f => f.opts.method === 'put').length === 2);
check('user told the files landed',
  global.__fetches.some(f => f.url.indexOf('chat.postMessage') > -1 &&
    JSON.parse(f.opts.payload).text.indexOf('2 files attached') > -1));

seedPending([file('a.png', 10), file('b.png', 20)]);
global.__resetFetches();
global.__responder = url => {
  if (url.indexOf('files.slack.com/b.png') > -1) return { code: 500, body: 'boom' };
  if (url.indexOf('files.slack.com') > -1) return { code: 200, raw: 'DATA', headers: { 'Content-Type': 'image/png' } };
  return { code: 200, body: '{}' };
};
processQueue();
r = __tab('ticket_log')._rows[0];
check('row stays pending while a file is outstanding', r[col_('attach_status') - 1] === 'pending');
check('attach attempt counted', r[col_('attach_attempts') - 1] === 1);
check('only the failed file is queued again - no duplicate uploads',
  JSON.parse(r[col_('files_json') - 1]).map(f => f.name).join() === 'b.png');
check('no premature success message',
  !global.__fetches.some(f => f.url.indexOf('chat.postMessage') > -1));

seedPending([file('huge.zip', 10)]);
global.__resetFetches();
global.__responder = url => url.indexOf('files.slack.com') > -1
  ? { code: 200, raw: 'DATA', headers: { 'Content-Type': 'image/png' } }
  : { code: 413, body: '{}' };
processQueue();
r = __tab('ticket_log')._rows[0];
check('413 not retried', r[col_('attach_status') - 1] === 'failed');
check('permanent error explained in the log',
  String(r[col_('attach_error') - 1]).indexOf('huge.zip') > -1);
check('user told to reply by email instead',
  global.__fetches.some(f => f.url.indexOf('chat.postMessage') > -1 &&
    JSON.parse(f.opts.payload).text.indexOf('reply to the Freshdesk email') > -1));

seedPending([file('a.png', 10)], { attach_attempts: MAX_ATTACH_ATTEMPTS - 1 });
global.__resetFetches();
global.__responder = () => ({ code: 500, body: 'boom' });
processQueue();
r = __tab('ticket_log')._rows[0];
check('gives up at the attach attempt cap', r[col_('attach_status') - 1] === 'failed');
check('attempt cap clears the queue entry', r[col_('files_json') - 1] === '');

resetSheets(); global.__resetFetches();
processQueue();
check('empty queue does nothing', global.__fetches.length === 0);

console.log('\n-- request routing and auth --');
check('wrong app id rejected', checkAppId_('A999') === false);
check('right app id accepted', checkAppId_('A123') === true);
check('missing app id tolerated (slash commands omit it)', checkAppId_('') === true);
check('secret compare is length-safe', safeEquals_('s3cr3t', 's3cr3t') && !safeEquals_('s3cr3t', 's3cr3'));
check('health check needs the secret',
  doGet({ parameter: {} }).getContent() === 'forbidden');
const health = JSON.parse(doGet({ parameter: { s: 's3cr3t' } }).getContent());
check('health check answers with the secret', health.ok === true);
check('health check reports the build', typeof health.build === 'string' && health.build.length > 0);
check('health check reports the live limits, to expose a stale deployment',
  health.limits.maxDetails === MAX_DETAILS &&
  health.limits.maxAttachBytes === MAX_ATTACH_TOTAL_BYTES);
check('health check lists the products the live form offers',
  health.limits.products.join() === PRODUCTS.join());
check('health check reports groupId as null when unset', health.account.groupId === null);
check('health check reports no extra fields when unset', health.account.extraFields.length === 0);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_GROUP_ID', '42');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '{"type":"Question"}');
const health2 = JSON.parse(doGet({ parameter: { s: 's3cr3t' } }).getContent());
check('health check echoes the group the code can actually see', health2.account.groupId === '42');
check('health check names the extra fields', health2.account.extraFields.join() === 'type');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '{oops');
check('health check flags unparseable extra fields',
  JSON.parse(doGet({ parameter: { s: 's3cr3t' } }).getContent())
    .account.extraFields[0].indexOf('not valid JSON') > -1);
PropertiesService.getScriptProperties().setProperty('FRESHDESK_GROUP_ID', '');
PropertiesService.getScriptProperties().setProperty('FRESHDESK_EXTRA_FIELDS', '');
check('doPost without the secret is silently dropped',
  doPost({ parameter: {} }).getContent() === '');

console.log('\n-- config guardrails --');
check('every PROP entry maps a name to itself',
  Object.keys(PROP).every(n => PROP[n] === n));
check('all properties present in the mock', missingProperties_().length === 0);
check('a missing property points at Script Properties',
  describeMissingProperty_('LOG_SHEET_ID').indexOf('Script Properties') > -1);
check('a missing property explains what it is',
  describeMissingProperty_('FRESHDESK_DOMAIN').indexOf('acme.freshdesk.com') > -1);
// The failure mode that actually happened: a Sheet ID pasted over the NAME in
// Config.gs, producing "Missing script property: 1BsrXTKY..." and no clue why.
check('a value pasted over a property name is diagnosed as such',
  describeMissingProperty_('1BsrXTKYTUM_N3X-ZyMzHo110YVOKCGkJIIBBwVBYjes')
    .indexOf('VALUE where a property NAME belongs') > -1);
check('that diagnosis says where the value should go',
  describeMissingProperty_('1BsrXTKY').indexOf('Script Properties') > -1);
check('cfg_ returns the fallback rather than throwing',
  cfg_('NOT_A_REAL_PROP', 'dflt') === 'dflt');
check('cfg_ throws with guidance when there is no fallback', (function () {
  try { cfg_('NOT_A_REAL_PROP'); return false; }
  catch (e) { return String(e).indexOf('Config error') > -1; }
})());

console.log('\n-- helpers --');
check('bytes formatted for humans',
  formatBytes_(500) === '500 B' && formatBytes_(2048) === '2 KB' && formatBytes_(25 * MB) === '25.0 MB');
check('slack mrkdwn escaped', escapeSlack_('a<b>&c') === 'a&lt;b&gt;&amp;c');

console.log('\n' + (fail ? 'FAILED: ' + fail + ' of ' + (pass + fail)
                          : 'ALL ' + pass + ' CHECKS PASSED'));
process.exit(fail ? 1 : 0);
