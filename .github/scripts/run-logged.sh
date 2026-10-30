#!/usr/bin/env bash
# Runs a command; on failure, prints its output and raises a GitHub annotation
# with the last lines so the error shows on the run's summary page.
#   .github/scripts/run-logged.sh "Label" cmd args...
set -uo pipefail
label=$1
shift
log=$(mktemp)
"$@" >"$log" 2>&1
status=$?
cat "$log"
if [ $status -ne 0 ]; then
  msg=$(tail -n 12 "$log" | tr '\n' ' ' | sed -e 's/%/%25/g' | cut -c1-900)
  echo "::error title=${label} failed::${msg}"
fi
exit $status
