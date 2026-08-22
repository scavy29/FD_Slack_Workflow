# Slack → Freshdesk ticket creation

A Slack modal that files a Freshdesk ticket, returns the ticket number
immediately, supports attachments up to 25 MB, and logs every submission to a
Google Sheet. Backend is Google Apps Script throughout.

```bash
npm install && npm run login   # once
npm test                       # 329 checks, no network needed
npm run push                   # test, then push to Apps Script
npm run deploy "what changed"  # test, push, redeploy — URL never moves
```

**[SETUP.md](SETUP.md) is the deployment guide.** Start there.

## How it works

```
  /newticket  or  [Create a ticket] button
        │
        ▼
  views.open ──────────────────────────────► Block Kit modal
                                             subject · product · session ids
                                             summary · details · steps
                                             attachments · email · cc
        │ submit
        ▼
  Apps Script  /exec?s=<secret>        ◄── Slack allows 3 SECONDS
        ├─ validate                        (local only — the one thing that
        ├─ write 2 script properties        can keep the form open)
        ├─ fire a one-off trigger
        └─ replace the form with            no network call, no spreadsheet
           "Request received"
        │
        ▼
  processQueue()  — one-off within seconds, plus every minute as a safety net
        ├─ move the queued submission into the Sheet
        ├─ post the summary INTO THE CHANNEL, keep its ts
        ├─ download every file from Slack   (bot token, files:read)
        ├─ POST /api/v2/tickets             (multipart: ticket AND its files)
        └─ reply in that thread: "Ticket #45231 created · 2 files attached."

  over MAX_INLINE_ATTACH_BYTES, or if a download fails, it falls back to
  create-then-attach: POST the ticket, then PUT one file at a time.
```

## Why the submission path touches nothing

Slack gives a `view_submission` **three seconds**. Miss it and the user sees
*"We had some trouble connecting"* inside the form — while the code carries on
running and files the ticket anyway. That is the worst available outcome: the
ticket exists and the user believes it failed, so they submit it again.

Creating the ticket inline blew the budget, so that moved to a worker. Writing
the Sheet row blew it too on a cold instance — `SpreadsheetApp` is the slowest
service Apps Script offers, and `openById` + `getSheetByName` + `appendRow` is
three round trips before anything is stored.

So the submission path now writes **two script properties** — one key-value
call — and returns. `PropertiesService` is durable, unlike `CacheService`,
which matters because until the worker runs that property *is* the record of
the submission. The worker moves it into the Sheet, creates the ticket and DMs
the number.

The form is replaced with a "Request received" confirmation rather than closed
outright, so the requester can see the submission landed. It stays open for
exactly one other reason — the form itself is invalid, which is local, instant,
and genuinely theirs to fix.

## The form, and what the ticket looks like

| Field | | Becomes |
|---|---|---|
| Subject | required | The ticket subject — the line an agent sees in the queue |
| Product | required | `**Product:** …` — a dropdown, edit `PRODUCTS` in `Config.gs` |
| Session IDs / Build IDs | optional | `**Session IDs / Build IDs:** …` |
| Summary | required | `**Summary:** …` — one line |
| Details | required | `**Details:**` then the body, line breaks preserved |
| Steps to reproduce | optional | `**Steps to reproduce:**` then the body |
| Attachments | optional | Uploaded to the ticket after it is created |
| Your email | required | The Freshdesk requester |
| CC | optional | `cc_emails` — copied on every Freshdesk reply |

Optional fields that are left blank produce no heading at all, so a short
ticket stays short.

**Priority is not a form field.** Every ticket is filed at Low and support
triages from the content — self-assessed priority is not evidence of anything,
and a dropdown mostly teaches people that Urgent gets a faster reply. One
constant, `DEFAULT_PRIORITY`, if that stops being true.

The attachment hint asks for log *text* in Details rather than a log file:
text is searchable in Freshdesk, an attachment is not.

## Where the requester hears back

The channel the form was opened from gets a summary — who raised it, product,
session IDs, the one-line summary, truncated details, and the file count. The
outcome then arrives as a **reply in that message's thread**: the ticket number
and a link, or the failure and what to do about it.

Two consequences worth knowing:

**The summary is posted before the ticket is created.** The outcome has to
thread under something, so the parent must exist first. It also means the
channel carries a visible record of the request even when Freshdesk is down —
which is exactly when one is worth having.

**Its `ts` is written to the Sheet before creation is attempted**, so a
retryable failure cannot post a second summary on the next run. Otherwise the
channel would collect one copy per attempt.

There is no DM as well. A threaded reply in the channel the request came from
is already visible to the requester; a DM on top is the same news twice. The
DM is the fallback for when there is no thread — a global shortcut, a DM with
the bot, or a channel the app was never invited to.

## Attachments arrive with the ticket, not after it

Freshdesk creates a ticket with its attachments in one multipart request, and
that is the route taken by default: the files are downloaded from Slack first,
then ticket and files go up together. The ticket is **complete the moment it
exists** — nothing appends to it afterwards, so anything watching for new
tickets (a triage bot, an SLA timer, an agent refreshing the queue) sees every
file the requester sent.

That costs something. `attachments[]` is a *repeated* multipart field name and
a JavaScript object cannot hold a duplicate key, so the body has to be
assembled by hand in `Multipart.gs` — which means every byte becomes a
JavaScript number, at roughly 8 bytes each in V8. A 10MB upload measures around
90MB of heap. Handing a Blob to `UrlFetchApp` instead streams it without the
bytes ever entering script memory, which is why the fallback exists and why it
has no size ceiling.

`MAX_INLINE_ATTACH_BYTES` is set equal to the 25 MB upload cap, so **every
permitted submission takes the single-request route** and no ticket ever grows
attachments after the fact. That equality is measured, not assumed:
`probeInlineLimit(25)` assembled a full 25 MB body in 323 ms.

The create-then-attach path is still there, and is taken automatically when
assembly throws or a file will not download — a ticket that is complete a
minute late beats no ticket at all. It is a fallback now rather than a routine
route.

Apps Script does not document its memory ceiling, so re-run
`probeInlineLimit(mb)` before raising `MAX_ATTACH_TOTAL_BYTES`, and keep
`MAX_INLINE_ATTACH_BYTES` at or above it. If it ever drops below, large
submissions quietly revert to appending files one at a time.

## Where the description lives

The Sheet stores the length of a description, never the text: ticket bodies
carry customer data and a Sheet has a far wider access surface than Freshdesk.

But the worker creates the ticket in a *later execution* and needs the actual
text. So between submit and create it sits in a Script Property, which is
durable — `CacheService` can evict whenever it likes, and an evicted body is a
lost ticket. The property is deleted the moment the ticket exists.

## Files

| File | Purpose |
|---|---|
| `SETUP.md` | Deployment guide. Read this first. |
| `slack-app-manifest.yaml` | Slack app definition — scopes, command, shortcuts |
| `src/Config.js` | Property keys, Freshdesk constants, limits, Sheet schema |
| `src/Router.js` | `doPost` / `doGet` — auth gate and payload demux |
| `src/Modal.js` | Block Kit view build and `view.state` parsing |
| `src/Submit.js` | `view_submission` — validate, log, close. No network. |
| `src/Queue.js` | The worker: creates tickets, then uploads files |
| `src/Freshdesk.js` | REST v2 client, field mapping, error classification |
| `src/Multipart.js` | Hand-rolled multipart, for the repeated `attachments[]` field |
| `src/Slack.js` | Web API client and authenticated file download |
| `src/Sheet.js` | The log, which is also the attachment queue |
| `src/Attach.js` | Uploading one row's files onto its ticket |
| `src/Setup.js` | One-time setup and `verifySetup` |
| `test/run.js` | 329 offline checks |

## Two things that will bite

**The deployment URL is a credential.** Apps Script does not expose request
headers to `doPost`, so Slack's `X-Slack-Signature` cannot be read and the
standard HMAC verification is not possible on this platform. A 32-byte shared
secret in the query string stands in for it. Never put the URL in a repo, a
Slack message, or a screenshot. `rotateSharedSecret()` when in doubt.

**`files:read` is not optional.** Without that scope Slack answers file
downloads with an HTML login page and HTTP 200. `Slack.js` checks the content
type and refuses it, so you get a clear error rather than a ticket with a web
page attached to it — but the attachments still will not work until the scope
is granted.

## Deliberately not in v1

Internal vs external classification, per-channel access control, `users.info`
email lookup, ticket status updates back into Slack, threaded replies. The
requester types their email, and the Slack user and channel are recorded in the
ticket description footer.
