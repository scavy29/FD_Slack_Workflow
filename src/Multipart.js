/**
 * Multipart.gs — hand-rolled multipart/form-data.
 *
 * WHY THIS EXISTS
 *
 * UrlFetchApp builds multipart for you when a payload value is a Blob, and
 * that is what the two-step attach path uses. It cannot express what Freshdesk
 * wants for several files, though: the field name is `attachments[]` repeated
 * once per file, and a JavaScript object cannot hold the same key twice.
 *
 * So a create-with-attachments request has to be assembled byte by byte.
 *
 * THE COST, WHICH IS REAL
 *
 * UrlFetchApp streams a Blob without the bytes ever entering script memory.
 * Assembling a body by hand means every byte becomes a JavaScript number
 * first, and V8 spends roughly 8 bytes on each one — so a 10MB upload costs
 * something like 80MB of heap, twice over while copying. That is why the
 * caller checks MAX_INLINE_ATTACH_BYTES before coming here, and why it has a
 * fallback when this throws.
 */

/**
 * @param {Array} fields  [{name, value}] — repeat a name to send it twice
 * @param {Array} files   [{field, filename, mimeType, bytes}]
 * @return {{contentType: string, payload: Array<number>}}
 */
function buildMultipart_(fields, files, boundary) {
  var CRLF = '\r\n';
  boundary = boundary || '----AppsScriptBoundary' + Utilities.getUuid().replace(/-/g, '');

  var parts = [];

  (fields || []).forEach(function (f) {
    parts.push(asciiBytes_(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="' + headerSafe_(f.name) + '"' + CRLF +
      CRLF +
      String(f.value === undefined || f.value === null ? '' : f.value) + CRLF));
  });

  (files || []).forEach(function (f) {
    parts.push(asciiBytes_(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="' + headerSafe_(f.field) + '"' +
      '; filename="' + headerSafe_(f.filename || 'attachment') + '"' + CRLF +
      'Content-Type: ' + headerSafe_(f.mimeType || 'application/octet-stream') + CRLF +
      CRLF));
    parts.push(f.bytes);

    // Take ownership. The assembled body will hold a second copy of every
    // byte, and whether both copies exist at once is what decides if a 25MB
    // upload fits. Callers must not read f.bytes afterwards.
    f.bytes = null;

    parts.push(asciiBytes_(CRLF));
  });

  parts.push(asciiBytes_('--' + boundary + '--' + CRLF));

  return {
    contentType: 'multipart/form-data; boundary=' + boundary,
    payload: concatBytes_(parts)
  };
}

/**
 * A quote or a line break in a filename would end the header early and let
 * the rest of the name be read as multipart syntax. Strip them rather than
 * escape them: no legitimate filename needs one, and a mangled name is a far
 * better outcome than a corrupted request body.
 */
function headerSafe_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 200);
}

function asciiBytes_(s) {
  return Utilities.newBlob(s).getBytes();
}

/**
 * One pass into a pre-sized array, releasing each part as it is consumed.
 *
 * Two things matter here and both are about peak memory rather than speed:
 *
 *   - pre-sizing, because concat or push.apply reallocate repeatedly, and a
 *     reallocation at these sizes means holding two copies of the whole body
 *   - dropping each part once copied, so the source bytes and the finished
 *     body are never both fully resident
 *
 * Together they roughly halve the peak, which is the difference between a
 * 25MB upload assembling and throwing.
 */
function concatBytes_(parts) {
  var total = 0, i, j;
  for (i = 0; i < parts.length; i++) total += parts[i].length;

  var out = new Array(total);
  var at = 0;

  for (i = 0; i < parts.length; i++) {
    var p = parts[i];
    for (j = 0; j < p.length; j++) out[at++] = p[j];
    parts[i] = null;   // the only remaining reference; let it go
  }
  return out;
}
