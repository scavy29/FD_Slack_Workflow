// Minimal Apps Script runtime mock — enough to exercise every pure logic path
// and the Freshdesk/Slack request shapes, with no network.
const crypto = require('crypto');

const props = {
  FRESHDESK_DOMAIN: 'sandbox',
  FRESHDESK_API_KEY: 'KEY',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_ID: 'A123',
  SHARED_SECRET: 's3cr3t',
  LOG_SHEET_ID: 'sheet1'
};

global.PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in props ? props[k] : null),
  getProperties: () => Object.assign({}, props),
  setProperty: (k, v) => { props[k] = v; },
  deleteProperty: k => { delete props[k]; },
  setProperties: o => Object.assign(props, o)
})};
global.__props = props;

global.Utilities = {
  base64Encode: s => Buffer.from(s).toString('base64'),
  base64EncodeWebSafe: b => Buffer.from(b).toString('base64url'),
  getUuid: () => crypto.randomUUID(),
  newBlob: (data, type, name) => makeBlob(Buffer.from(data), name)
};

function makeBlob(buf, name) {
  return {
    _buf: buf,
    getBytes: () => Array.from(buf),
    getName: () => name,
    setName(n) { name = n; return this; }
  };
}

const cache = {};
global.CacheService = { getScriptCache: () => ({
  get: k => (k in cache ? cache[k] : null),
  put: (k, v) => { cache[k] = v; },
  remove: k => { delete cache[k]; }
})};
global.__clearCache = () => Object.keys(cache).forEach(k => delete cache[k]);

let lockHeld = false;
global.LockService = { getScriptLock: () => ({
  tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
  releaseLock: () => { lockHeld = false; }
})};

global.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: t => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } })
};

global.Logger = { log: (...a) => global.__logs.push(a.join(' ')) };
global.__logs = [];

const triggers = [];
global.ScriptApp = {
  getProjectTriggers: () => triggers,
  deleteTrigger: t => { const i = triggers.indexOf(t); if (i > -1) triggers.splice(i, 1); },
  newTrigger: fn => {
    const add = () => ({ create: () => { triggers.push({ getHandlerFunction: () => fn }); } });
    return { timeBased: () => ({ everyMinutes: add, after: add }) };
  }
};
global.__triggers = triggers;
global.__resetTriggers = () => { triggers.length = 0; };

/* ---- Spreadsheet ---- */
const tabs = {};
function makeSheet(name) {
  const rows = [];              // data rows only
  let header = [];              // row 1, tracked separately
  return {
    _rows: rows,
    get _header() { return header; },
    getName: () => name,
    setFrozenRows() {},
    appendRow: r => rows.push(r.slice()),
    getLastRow: () => rows.length + 1,
    getLastColumn: () => Math.max(header.length, rows.length ? rows[0].length : 0),
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: vals => {
        for (let i = 0; i < nr; i++) {
          const target = (r + i === 1) ? header : (rows[r - 2 + i] = rows[r - 2 + i] || []);
          for (let j = 0; j < nc; j++) target[c - 1 + j] = vals[i][j];
        }
      },
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = (r + i === 1) ? header : (rows[r - 2 + i] || []);
          const slice = [];
          for (let j = 0; j < nc; j++) slice.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(slice);
        }
        return out;
      }
    })
  };
}
global.__tab = n => (tabs[n] = tabs[n] || makeSheet(n));
global.__resetSheets = () => Object.keys(tabs).forEach(k => delete tabs[k]);
global.SpreadsheetApp = { openById: () => ({
  getSheetByName: n => tabs[n] || null,
  insertSheet: n => (tabs[n] = makeSheet(n))
})};

/* ---- UrlFetchApp ----
   Override global.__responder in a test to control what comes back. */
global.__fetches = [];
global.__responder = null;

function defaultResponder(url) {
  if (url.indexOf('freshdesk.com') > -1) {
    return { code: 201, body: JSON.stringify({ id: 45231 }), headers: { 'Content-Type': 'application/json' } };
  }
  return { code: 200, body: JSON.stringify({ ok: true, ts: '1700000000.000100', channel: 'C1' }),
           headers: { 'Content-Type': 'application/json' } };
}

global.UrlFetchApp = { fetch: (url, opts = {}) => {
  global.__fetches.push({ url, opts });
  const r = (global.__responder || defaultResponder)(url, opts) || defaultResponder(url);
  const body = r.body === undefined ? '' : r.body;
  return {
    getResponseCode: () => r.code,
    getContentText: () => body,
    getAllHeaders: () => r.headers || {},
    getBlob: () => makeBlob(Buffer.from(r.raw !== undefined ? r.raw : body), 'blob')
  };
}};
global.__resetFetches = () => { global.__fetches.length = 0; global.__responder = null; };
