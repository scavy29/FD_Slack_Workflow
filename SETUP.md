# Setup

About an hour end to end. Step 0 needs nothing but a Google account — do it
first, so that when something breaks later you know it is not the plumbing.

---

## 0. Dry run — no credentials needed

Proves clasp auth, push, the deployment, anonymous access and the Apps Script
redirect all work, before Freshdesk or Slack are involved at all.

**Enable the Apps Script API first** at
<https://script.google.com/home/usersettings>. Every `clasp push` fails with an
opaque 403 until you do, and nothing in the error says so.

```bash
cd ~/Desktop/BrowserStack/TicketCreation_Workflow
npm install
npx clasp login
npx clasp create-script --title "Slack Freshdesk Tickets" --type standalone --rootDir src
npm run push
npx clasp open-script
```

> `.clasp.json` is gitignored and created by `create-script`. If one already
> exists, `create-script` refuses — **and exits 0 while doing so**, so it fails
> silently inside a script. Move it aside first.
> `.clasp.json.template` shows the shape if you would rather write it by hand.

In the editor, run **`setupProperties`** with every field left empty. It still
generates `SHARED_SECRET`, which is all the health check needs. Accept the OAuth
prompts — you will see *"Google hasn't verified this app"*; it is your own
script, so *Advanced → Go to … (unsafe)*. Copy the secret from the log.

```bash
npm run deploy:first
echo '<deploymentId>' > .deployment-id     # from the list it prints
```

Confirm in *Deploy → Manage deployments* that the web app is **Execute as: Me**
and **Who has access: Anyone**. Then open in a browser:

```
<EXEC_URL>?s=<SHARED_SECRET>
```

Expected: `{"ok":true,"service":"slack-freshdesk","time":"..."}`.
Without the `?s=` you should get `forbidden`.

> **If "Anyone, even anonymous" is not offered**, your Workspace admin has
> disabled anonymous web apps. Slack cannot reach the endpoint without it.
> That is a hard blocker — raise it now, not later.

---

## 1. Google Sheet

New Sheet, any name. Copy the ID from the URL:
`docs.google.com/spreadsheets/d/`**`<THIS>`**`/edit`.

It will hold requester emails and subjects, so share it with the support team
only. Ticket *descriptions* are never written to it — only their length — because
ticket bodies carry customer data and a Sheet has a much wider access surface
than Freshdesk does.

## 2. Freshdesk

Freshdesk → *Profile settings* → **Your API Key**. You need the key and your
subdomain (the `acme` in `acme.freshdesk.com` — subdomain only, no `https://`).

> Use a **sandbox account** for the first tickets, or your live queue fills with
> "test test test" while you are getting the modal right.

## 3. Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From an app manifest*.
2. Paste `slack-app-manifest.yaml`. Put `https://example.com/placeholder` in
   both URL fields for now — step 5 fixes them.
3. Install to workspace. From *Basic Information* copy the **App ID** (`A…`);
   from *OAuth & Permissions* copy the **Bot User OAuth Token** (`xoxb-…`).

> **`files:read` is what makes attachments work.** Without it Slack answers file
> downloads with an HTML login page and HTTP 200 — the code catches it and tells
> you, but no file will reach Freshdesk until the scope is granted. If your
> workspace requires admin approval for scopes, start that now.

## 4. Fill in the properties

**Do not put credentials in the source files.** In the Apps Script editor open
**Project Settings** (the gear in the left sidebar) → **Script Properties** →
*Add script property*, and add these five:

| Property | Value |
|---|---|
| `FRESHDESK_DOMAIN` | subdomain only — `acme`, not `https://acme.freshdesk.com` |
| `FRESHDESK_API_KEY` | from Freshdesk → Profile settings |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_APP_ID` | `A0123ABCD` |
| `LOG_SHEET_ID` | the Sheet ID from step 1 |

`SHARED_SECRET` is generated for you — you do not add it by hand.

Two more are optional, and exist for one specific reason:

| Property | When you need it |
|---|---|
| `FRESHDESK_GROUP_ID` | Group is mandatory on your account. Run `listGroups()` to print the IDs. |
| `FRESHDESK_EXTRA_FIELDS` | Any other mandatory field — JSON merged into the ticket, e.g. `{"type":"Question"}` |
| `FRESHDESK_TAGS` | Tags to put on every ticket. Comma-separated, and they must **already exist** in Freshdesk. Empty = no tags. |

> **Freshdesk enforces "mandatory on creation" ticket fields at the API**, not
> only in its own web form. A field ticked as required under *Admin → Ticket
> Fields* fails the create call even though the modal never asks about it, and
> the error names a field you did not send — `group_id: It should be a/an
> Positive Integer` is the usual one. Either make the field optional in
> Freshdesk, or supply it with these properties.

> **Tags are opt-in for the same class of reason.** Freshdesk can be set so
> only admins create new tags; an agent API key then fails the *entire* create
> call with `cannot_create_new_tag` rather than skipping the unknown tag. A
> per-channel tag is a new tag by definition, so it can never work under that
> setting — the Slack user and channel are recorded in the ticket description
> footer instead, which needs no permissions and cannot fail.

> **`Config.gs` is not where values go.** Its `PROP` object maps property
> *names* to themselves so the rest of the code can refer to them; pasting a
> real Sheet ID or API key over one of those names breaks the lookup and gets
> the secret committed to git. `verifySetup` checks for this explicitly.

Then run, in order:

```
setupProperties → generates SHARED_SECRET, lists anything still missing
```

and after that:

```
setupSheet      → creates the ticket_log tab and its header row
setupTrigger    → installs processQueue, every minute
verifySetup     → must print "All checks passed"
```

`verifySetup` checks Slack, Freshdesk and the Sheet without creating anything.
Do not continue until it is clean.

> Anyone with **edit** access to the Apps Script project can read every secret.
> Keep that list to two named people, and own the project from a shared account
> rather than a personal one.

## 5. Wire Slack to the deployment

Build `<EXEC_URL>?s=<SHARED_SECRET>` and paste it into **both**:

- *Interactivity & Shortcuts* → Request URL
- *Slash Commands* → `/newticket` → Request URL

Reinstall the app if Slack asks.

## 6. Smoke test

1. `/invite @Support Tickets` in a test channel.
2. Run `/newticket`. The modal should appear in under 3 seconds.
3. Submit with a small screenshot attached.
4. Check, in order:
   - the form is replaced by a "Request received" confirmation, with no error
   - a summary of the request appears in the channel within a few seconds
   - the ticket number arrives as a reply in that message's thread
   - a DM arrives with the ticket number, within a few seconds
   - the Freshdesk ticket exists, tagged `slack` and `ch-<channel>`
   - the description kept its line breaks and is not raw HTML
   - the DM says the file is already attached — no second message
   - the file is on the Freshdesk ticket immediately, and opens correctly
   - the Sheet row reads `created` / `done`

### Put the button in a channel

`/newticket` works anywhere, but nobody discovers a slash command. Post the
button instead — once per channel:

1. **Invite the bot**: `/invite @Support Tickets` in that channel. The app does
   not request `chat:write.public`, so it can only post where it is invited.
2. Add a script property **`LAUNCHER_CHANNEL_ID`** with the channel ID — it is
   at the bottom of the channel's **About** tab, and looks like `C0123ABCD`.
3. Run **`postLauncher`** in the editor.

The editor's Run button cannot pass arguments, which is why the channel comes
from a property. For several channels, change the property and run it again
for each.

Then **pin the message**. The button keeps working for as long as the message
exists, but an unpinned one scrolls away and the form is forgotten again.

There is also a global shortcut and a message shortcut (Slack's ⚡ / message
menus). Raising a ticket from a message prefills Details with that message's
text.

## 7. Check the latency

Slack allows 3 seconds for a modal submission. The submission path makes no
network call, so it should finish in a few hundred milliseconds — but Apps
Script cold starts are the variable, and this is the number to watch.

The `ack_ms` column is how long the request took to record the submission —
everything after it is just returning a response, so it is the 3-second budget
as spent. Run `diagnose()` to see the last five. If it ever approaches 2500 ms, the cold start alone is eating the
allowance. `duration_ms` is submission to ticket created, which is allowed to
be slow.

Run `spikeLatency` a few times to see what a Freshdesk round trip costs from
your account — it no longer sits on the critical path, but it sets how long
the DM takes to arrive.

### The attachment ceiling

Attachments go up **with** the ticket so it is complete the moment it exists,
which means the request body is assembled in script memory rather than
streamed. `MAX_INLINE_ATTACH_BYTES` is set equal to the 25 MB upload cap, so
every permitted submission takes that route.

Measured, not assumed: `probeInlineLimit(25)` built a full 25 MB body in
323 ms. Re-run it if you ever raise `MAX_ATTACH_TOTAL_BYTES`, and keep the
inline limit at or above the upload cap — below it, large submissions silently
go back to appending files one at a time after the ticket exists.

---

## Every deploy after the first

```bash
npm run deploy "what changed"
```

A **new** deployment gets a **new** `/exec` URL and silently breaks Slack —
every request fails and nothing anywhere tells you why. `npm run deploy` always
updates the pinned deployment, so the URL never moves. Do not run
`clasp create-deployment` again after the first time.

### Confirm what is actually live

`npm test` passing and `clasp push` succeeding tell you nothing about which
code Slack is calling. Open the health check and read `build`:

```
<EXEC_URL>?s=<SHARED_SECRET>
```

```json
{"ok":true,"build":"2026-08-20.a","limits":{"maxDescription":3000, ...}}
```

If `build` is not the value in `Config.gs`, the deployment Slack calls is not
the one you deployed to.

**The trap:** every Apps Script project has an automatic **@HEAD** test
deployment, and it is the *first* entry `clasp list-deployments` prints. Pin
that ID by mistake and every `npm run deploy` reports success while Slack goes
on calling untouched code — for as long as it takes you to notice.

Which is why `.deployment-id` accepts the whole `/exec` URL, not just an ID:

```bash
echo 'https://script.google.com/macros/s/AKfyc.../exec' > .deployment-id
```

Copy it from the Slack app config, where it is the URL Slack is definitely
calling. `deploy.sh` extracts the ID and prints the health-check URL for the
deployment it just updated.

## When something breaks

| Symptom | Look at |
|---|---|
| Modal never opens | Slack request URL — secret changed, or a new deployment moved the URL |
| Modal opens, submit does nothing | *Executions* in the editor; `SHARED_SECRET` mismatch |
| Ticket created, no attachment | `files:read` scope; `attach_error` in the Sheet |
| Rows stuck at `pending` | The trigger died — re-run `setupTrigger` |
| Summary not posted, only a DM | The bot is not in that channel. `/invite @Support Tickets` — there is no `chat:write.public`. |
| Form shows a connection error | Something on the submission path is waiting on the network or the Sheet. It must do neither — check `ack_ms`. |
| Anything at all looks wrong | Run `diagnose()` first. Triggers, unfinished work and the last five submissions with timings. |
| Everything 401/403 | Freshdesk key rotated — update the property, no redeploy needed |

Rows with `status: failed` or `attach_status: failed` are the ones a human needs
to look at. Filter on those columns.
