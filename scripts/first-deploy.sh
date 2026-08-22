#!/usr/bin/env bash
# One-time: create the initial web app deployment. Run ONCE.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .deployment-id ]; then
  echo "Already pinned: $(cat .deployment-id) — use 'npm run deploy' instead."; exit 1
fi
npm test
clasp push -f
clasp create-deployment -d "initial deployment"
echo; clasp list-deployments; echo
echo "Pin it:   echo '<deploymentId>' > .deployment-id"
