# Slack App Installation Request — Freshdesk Ticket Creation

> **Before you publish:** replace every `<PLACEHOLDER>` below, then delete this line.

| | |
| --- | --- |
| **App name** | Support Tickets |
| **Status** | Pending IT / Security approval |
| **Requested by** | `<YOUR NAME>`, `<TEAM>` |
| **Business owner** | `<MANAGER / TEAM LEAD>` |
| **Workspace** | `<SLACK WORKSPACE>` |
| **Install scope** | Single workspace, bot user only |
| **Permissions requested** | `commands`, `chat:write`, `files:read` |
| **Systems touched** | Slack, Google Apps Script (our Workspace tenant), Freshdesk |
| **New vendors introduced** | None — all three are already in use |
| **Date raised** | `<DATE>` |

---

## At a glance

We are asking for approval to install a custom, internally built Slack app called **Support Tickets** into the `<SLACK WORKSPACE>` workspace.

It adds a `/newticket` command that opens a short form. On submit, it creates a ticket in our existing Freshdesk account and DMs the requester their ticket number. That is the entire feature set.

**It requests three bot permissions. It reads no messages, no channel lists and no user directory, and stores no Slack data beyond what is needed to file and log one ticket.**

The app is built and working in a personal development workspace. This request is to move it into the company workspace so the support team can use it.

### What we need from you

1. Approval to create and install the app with the three scopes in [Permissions requested](#permissions-requested-and-why).
2. An administrator to perform the installation, if workspace policy requires it. We will provide the app manifest and can walk through the configuration.
3. Confirmation of any **log retention period** we should apply to the Google Sheet.

---

## Why we want it

- Support requests currently arrive in Slack as messages and get lost. There is no queue, no ownership, and no record of what was asked or when.
- Asking people to leave Slack and use the Freshdesk portal is the reason they do not raise tickets in the first place. Meeting them where they already are is the whole point.
- Every request becomes a tracked Freshdesk ticket with an owner and an SLA, and the requester gets a ticket number immediately rather than wondering whether anyone saw their message.
- Submissions are logged to a Google Sheet, so we can see volume, response patterns and failures without querying Freshdesk.

---

## What the app actually does

| Step | What happens |
| --- | --- |
| **1. Open** | A user runs `/newticket`, or clicks a "Create a ticket" button posted in a support channel. |
| **2. Form** | Slack shows a short form: subject, product, summary and details are required; session or build IDs, steps to reproduce and file attachments are optional. It also asks for the requester's email address, and optionally addresses to copy on the ticket. |
| **3. Submit** | Slack sends the form to our Google Apps Script endpoint. It validates the input, records the submission, and replaces the form with a "Request received" confirmation. No other system is contacted at this point. |
| **4. Create** | A background job creates the ticket in Freshdesk over its REST API and DMs the requester their ticket number. |
| **5. Attach** | If files were attached, the same job downloads them from Slack and sends them to Freshdesk with the ticket, so the ticket is complete when it is created. |

The app does **not** read channel history, does **not** respond to messages, does **not** subscribe to any Slack events, and has no Home tab.

---

## How it is built

There is no new infrastructure and no new vendor. The backend is a Google Apps Script web app running inside our own Google Workspace tenant.

| Component | Detail |
| --- | --- |
| Slack app | Custom app, bot user only. Not distributed, not on the Slack Marketplace, not org-wide. |
| Backend | Google Apps Script web app, owned by a company Google account, in our Workspace tenant. |
| Ticketing | Our existing Freshdesk account, via its documented REST v2 API. |
| Logging | A Google Sheet in our Workspace, shared with the support team only. |
| Hosting cost | None. No servers, containers or third-party hosting are involved. |
| Source code | Held in our Git repository and reviewed like any other internal code. |

### Data flow

```
Slack  →  Google Apps Script (our tenant)  →  Freshdesk API
                    └→  Google Sheet (our tenant)
```

All three endpoints are systems we already use and already have agreements with. No data is sent anywhere else, and nothing crosses into a system that is new to the company.

---

## Permissions requested, and why

The app calls exactly **three** Slack API methods across its whole lifetime: `views.open` (show the form), `chat.postMessage` (DM the requester) and `auth.test` (a setup-time health check). The permission list is derived from those three calls and nothing else.

| Scope | What it allows | Why this app needs it |
| --- | --- | --- |
| `commands` | Register and receive the `/newticket` slash command. | This is how a user opens the form. Slack sends us the command text, the user ID and the channel ID; it grants no access to anything else. |
| `chat:write` | Post messages as the bot. | Used to DM the requester their ticket number, and to post the optional "Create a ticket" button into a support channel the bot has been invited to. It does not permit reading any message. |
| `files:read` | Download files a user attaches to the form. | Required by Slack's file upload form element. Without it the form still submits, but Slack returns a sign-in page instead of the file and no attachment reaches Freshdesk. |

### Permissions we deliberately did not request

We reviewed the code against the scope list and removed three scopes that were in an earlier draft but are never used. Noted here so the review has the full picture of what was considered.

| Scope | Would have allowed | Why it is not needed |
| --- | --- | --- |
| `channels:read`, `groups:read` | Listing channels and reading their metadata. | The channel ID and name already arrive inside the slash command and interactivity payloads. We never call `conversations.info`, so we never need to read channel lists. |
| `users:read`, `users:read.email` | Reading the user directory and members' email addresses. | The requester types their own email into the form. We never look anyone up in the directory. |
| `chat:write.public` | Posting into channels the bot has not joined. | The bot only sends DMs and posts into channels it has been explicitly invited to. |

> **On `files:read`**
>
> This is the broadest of the three, so it is worth being precise. The scope permits reading file content and metadata for files the app can see. In practice the app only ever downloads files a user has just attached to its own form, using the URL Slack hands us in that submission, and it does so once — the file is streamed straight to Freshdesk and never written to disk or to the log.
>
> If your review would prefer the app not handle attachments at all, we can remove the upload field and drop this scope entirely. Requesters would then attach screenshots by replying to the Freshdesk email instead. We would rather keep it, because a support ticket without the screenshot usually costs a round trip.

---

## What data is handled, and where it goes

| Data | Where it goes | Retention |
| --- | --- | --- |
| Subject, product, summary, details, steps | Freshdesk ticket | Per existing Freshdesk retention policy. |
| Requester email address, and any CC addresses | Freshdesk ticket, and the Google Sheet log | Typed by the requester. Kept in the log for support reporting. |
| Slack user ID, username, channel name | Google Sheet log only | Identifies who raised the request and from where. Deliberately not written onto the ticket itself, which the requester can read. |
| Attached files | Freshdesk ticket | Passed straight through. Never stored by the integration. |
| Ticket description text | Google Apps Script property store, briefly | Deleted the moment the ticket exists — normally within seconds. |

> **Ticket descriptions are deliberately kept out of the log**
>
> The Google Sheet records the *character count* of each description, never the text. Ticket bodies routinely contain customer detail, and a spreadsheet has a much wider and less controlled access surface than Freshdesk does.
>
> The one exception is the few seconds between a form being submitted and the ticket being created, when the text sits in the Apps Script property store so the background job can pick it up. It is deleted as soon as the ticket exists.

The Google Sheet log is append-only and is currently kept indefinitely. **If your team has a standard retention period for operational logs containing email addresses, tell us what it is and we will apply it.**

---

## Security model

The Apps Script web app must be reachable by Slack, which on this platform means it is deployed as publicly addressable. The controls below exist because of that.

| Control | Implementation |
| --- | --- |
| Transport | HTTPS only, end to end. Google, Slack and Freshdesk all enforce TLS. |
| Endpoint authentication | A 32-byte random shared secret is required in the request URL. It is checked before any part of the request is parsed. Requests without it are dropped silently. |
| App identity | The Slack application ID on every request must match ours. |
| Credential storage | The Slack bot token and Freshdesk API key are held in Apps Script Script Properties. They are never in source code and never in the Git repository. |
| Freshdesk access | A standard **agent** API key, not an administrator key. It can create tickets; it cannot administer the account. |
| Duplicate protection | Repeated submissions of the same form are suppressed, so a retry or a double click cannot file the same ticket twice. |
| Response surface | The endpoint returns no data. A caller learns nothing from it. |

### Known limitation: Slack request signatures cannot be verified

> **We are raising this ourselves rather than leaving your team to find it.**
>
> Slack signs every request with an `X-Slack-Signature` header. **Google Apps Script does not expose HTTP request headers to server-side code**, so that signature cannot be read and the standard verification step is not available on this platform.
>
> The shared secret in the URL stands in for it. The practical consequence is that **the deployment URL is itself a credential**: anyone holding the full URL could submit a forged form and cause a Freshdesk ticket to be created.
>
> **Worst case** is nuisance ticket creation with a spoofed requester email address. It grants no read access to Slack, no read access to Freshdesk, and no route to any other system. The URL is treated as a secret, is not committed to the repository, and can be rotated in about two minutes.
>
> **If you consider that residual risk unacceptable**, the fix is well understood: put a small signature-verifying proxy in front of the endpoint so the real Slack signature is checked before anything reaches Apps Script. We are happy to build that if it is a condition of approval — say so and we will treat it as in scope.

### Who can access what

- Edit access to the Apps Script project will be limited to **two named people**. Anyone with edit access can read the stored credentials, so this list is kept deliberately short and reviewed if someone changes team.
- The project is owned by a **company account**, not a personal one.
- The Google Sheet log is shared with the support team only.
- The Slack app is installed by the workspace administrator and can be uninstalled by them at any time without our involvement.

---

## Proposed rollout

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 1 | Support team only, one channel | ~20 tickets filed. Every one appears in Freshdesk and in the log, with no duplicates. |
| 2 | Internal teams that raise support requests | One week with no failures needing manual repair. |
| 3 | All internal channels where support is requested | — |

**Rollback:** uninstalling the Slack app stops the integration immediately and completely. Tickets already created are unaffected, and no Slack or Freshdesk configuration needs to be undone. There is nothing to migrate and nothing left running.

---

## Appendix A — Every Slack API call the app makes

| Method | Scope used | Purpose |
| --- | --- | --- |
| `views.open` | none required | Display the ticket form after `/newticket` or a button click. |
| `chat.postMessage` | `chat:write` | DM the requester their ticket number and the attachment result. |
| `auth.test` | none required | Setup-time check that the token works. Not called during normal use. |
| file download | `files:read` | Fetch a file the user attached to the form, once, to forward to Freshdesk. |

There are no other calls, no Slack Events API subscriptions, and no background polling of Slack.

---

## Questions

Happy to walk through the code, the Slack app configuration or the data flow with your team, and to make changes as a condition of approval.

**Contact:** `<YOUR NAME>` — `<EMAIL>`
