/**
 * Modal.gs — Block Kit view construction and parsing.
 */

var VIEW_CALLBACK_ID = 'create_ticket';

/**
 * The button's action_id, and the only value Router.gs will open a modal for.
 *
 * It lives here because it is a contract between two files that are edited at
 * different times: a launcher already posted in a channel keeps working for
 * as long as the message exists, so renaming this without renaming it in the
 * router breaks every button already in the wild — silently, since Slack just
 * sees an app that does not respond.
 */
var LAUNCH_ACTION_ID = 'open_ticket_modal';

/** The "Create a ticket" message. Posted by postLauncher(). */
function buildLauncherBlocks_() {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Need help from the support team?*\n' +
              'Raise a ticket and you will get the number straight away. ' +
              'A support engineer replies by email.'
      }
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: 'Create a ticket' },
        action_id: LAUNCH_ACTION_ID
      }]
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'You can also type `/newticket` anywhere.' }]
    }
  ];
}

/**
 * The form. Fields map straight onto the mandatory parameters of
 * POST /api/v2/tickets: email identifies the requester, subject and
 * description are what make the ticket usable, priority defaults to Medium.
 */
function buildModal_(ctx) {
  ctx = ctx || {};

  var blocks = [
    input_('subject', 'Subject', {
      type: 'plain_text_input',
      action_id: 'value',
      max_length: MAX_SUBJECT,
      placeholder: plain_('One line the support team will see first'),
      initial_value: ctx.prefillSubject || undefined
    }),

    input_('product', 'Product', {
      type: 'static_select',
      action_id: 'value',
      placeholder: plain_('Choose one'),
      options: PRODUCTS.map(function (name) {
        return { text: plain_(name), value: name };
      })
    }),

    input_('session_ids', 'Session IDs / Build IDs', {
      type: 'plain_text_input',
      action_id: 'value',
      max_length: MAX_SESSION_IDS,
      placeholder: plain_('Paste one or more, comma separated')
    }, {
      optional: true,
      hint: 'Optional, but it is usually the fastest route to an answer.'
    }),

    input_('summary', 'Summary', {
      type: 'plain_text_input',
      action_id: 'value',
      max_length: MAX_SUMMARY,
      placeholder: plain_('Facing issue with login on Chrome')
    }, { hint: 'One short line. The detail goes below.' }),

    input_('details', 'Details', {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      max_length: MAX_DETAILS,
      placeholder: plain_('What happened, what you expected, and any log lines. Paste log text here rather than attaching it.'),
      initial_value: ctx.prefillDetails || undefined
    }),

    input_('steps', 'Steps to reproduce', {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      max_length: MAX_STEPS,
      placeholder: plain_('1. ...\n2. ...\n3. ...')
    }, { optional: true }),

    input_('attachments', 'Attachments', {
      type: 'file_input',
      action_id: 'value',
      max_files: MAX_FILES
    }, {
      optional: true,
      hint: 'Screenshots and recordings. Up to ' + MAX_FILES + ' files, ' +
            formatBytes_(MAX_ATTACH_TOTAL_BYTES) + ' in total. Paste log text into ' +
            'Details rather than attaching it — text is searchable, a file is not.'
    }),

    input_('email', 'Your email', {
      type: 'email_text_input',
      action_id: 'value',
      initial_value: ctx.knownEmail || undefined,
      placeholder: plain_('you@company.com')
    }, { hint: 'Freshdesk sends all ticket updates here.' }),

    input_('cc_emails', 'CC', {
      type: 'plain_text_input',
      action_id: 'value',
      max_length: MAX_CC_INPUT,
      placeholder: plain_('colleague@company.com, manager@company.com')
    }, {
      optional: true,
      hint: 'Optional. Anyone listed is copied on every update. ' +
            'Separate addresses with commas — up to ' + MAX_CC_EMAILS + '.'
    })
  ];

  return {
    type: 'modal',
    callback_id: VIEW_CALLBACK_ID,
    title: plain_('New support ticket'),
    submit: plain_('Create ticket'),
    close: plain_('Cancel'),
    // Where the form was opened from. view_submission payloads carry no
    // channel of their own, so anything we want at submit time rides here.
    private_metadata: JSON.stringify({
      channelId: ctx.channelId || '',
      channelName: ctx.channelName || ''
    }),
    blocks: blocks
  };
}

function plain_(text) {
  return { type: 'plain_text', text: text };
}

/** An input block. opts: {optional, hint}. */
function input_(blockId, label, element, opts) {
  opts = opts || {};
  var block = {
    type: 'input',
    block_id: blockId,
    label: plain_(label),
    element: element
  };
  if (opts.optional) block.optional = true;
  if (opts.hint) block.hint = plain_(opts.hint);
  return block;
}

/* ------------------------------------------------------------------ */
/* Parsing view.state                                                  */
/* ------------------------------------------------------------------ */

/** The element object for a block, whatever its action_id turned out to be. */
function stateElement_(state, blockId) {
  var block = state && state.values && state.values[blockId];
  if (!block) return null;
  if (block.value) return block.value;               // our action_id
  var keys = Object.keys(block);                      // ...or whatever Slack used
  return keys.length ? block[keys[0]] : null;
}

/** Text or selected value for a block. Always a trimmed string. */
function stateValue_(state, blockId) {
  var el = stateElement_(state, blockId);
  if (!el) return '';
  if (el.selected_option) return el.selected_option.value || '';
  return String(el.value || '').trim();
}

/**
 * Files from a file_input block. Slack puts them under `files`, not `value`,
 * and omits the key entirely when the optional input was left empty.
 */
function stateFiles_(state, blockId) {
  var el = stateElement_(state, blockId);
  if (!el || !el.files || !el.files.length) return [];

  return el.files.map(function (f) {
    return {
      id: f.id,
      name: f.name || f.title || 'attachment',
      mimetype: f.mimetype || '',
      size: Number(f.size) || 0,
      // The direct URL. url_private redirects and needs a second hop.
      url_private_download: f.url_private_download || f.url_private || ''
    };
  });
}

/** Keeps the modal open and shows a message under the offending field. */
function modalErrors_(errors) {
  return jsonResponse_({ response_action: 'errors', errors: errors });
}

/**
 * What replaces the form once a submission is accepted.
 *
 * Costs nothing — it is the HTTP response body, not an API call — and it
 * closes the loop for the requester: the form is gone, the request is in, and
 * the ticket number is coming. Silence after a submit reads as a failure, and
 * a Slack connection error reads as one even when the ticket was created.
 */
function buildConfirmationView_() {
  return {
    type: 'modal',
    callback_id: 'ticket_submitted',
    title: { type: 'plain_text', text: 'Request received' },
    close: { type: 'plain_text', text: 'Done' },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':white_check_mark:  *Thanks — your request has been submitted.*' }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Your ticket number will arrive here in Slack in a few moments, ' +
                'and a support engineer will follow up by email.'
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'You can close this window.' }]
      }
    ]
  };
}
