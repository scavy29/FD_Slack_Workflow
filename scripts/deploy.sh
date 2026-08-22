#!/usr/bin/env bash
#
# Redeploy WITHOUT changing the web app URL.
#
# A *new* deployment gets a *new* /exec URL and silently breaks Slack, so this
# always updates the deployment pinned in .deployment-id.
#
# The subtler failure this guards against: pinning the WRONG deployment. Every
# Apps Script project has an automatic @HEAD test deployment, and it is the
# first entry `clasp list-deployments` prints — pin that by mistake and every
# deploy succeeds while Slack keeps calling untouched code. So .deployment-id
# accepts the full /exec URL as well as a bare ID, because the URL is the one
# thing you can copy straight from the Slack app config and cannot get wrong.
set -euo pipefail
cd "$(dirname "$0")/.."

ID_FILE=".deployment-id"
DESC="${1:-deploy $(date -u +%Y-%m-%dT%H:%MZ)}"

if [ ! -f "$ID_FILE" ]; then
  echo "No $ID_FILE. First deploy? npm run deploy:first"
  exit 1
fi

RAW="$(tr -d '[:space:]' < "$ID_FILE")"
DEPLOYMENT_ID="$(printf '%s' "$RAW" \
  | sed -E 's#^https?://script\.google\.com/macros/s/([^/]+)/exec.*$#\1#')"

if [ -z "$DEPLOYMENT_ID" ]; then
  echo "Could not read a deployment ID from $ID_FILE"; exit 1
fi

npm test
clasp push -f
clasp redeploy "$DEPLOYMENT_ID" -d "$DESC"

BUILD="$(sed -n "s/^var BUILD = '\(.*\)';/\1/p" src/Config.js)"
cat <<MSG

Deployed build ${BUILD} to ${DEPLOYMENT_ID}

Confirm that is the deployment Slack actually calls — open this and check
"build" matches. If it does not, .deployment-id points at the wrong deployment:

  https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec?s=<SHARED_SECRET>
MSG
