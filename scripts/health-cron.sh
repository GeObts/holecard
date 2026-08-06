#!/usr/bin/env bash
#
# Covalidator uptime probe, run from cron every 15 minutes.
#
# Appends one line per run to health.log. Serving and ingestion are recorded
# separately because they failed independently on 2026-08-05 and may recover
# independently too.
#
# Never truncates. Never rotates. Three days of data is a few hundred lines.
set -uo pipefail

REPO=/home/goya/holecard
LOG="$REPO/health.log"
LOCK="$REPO/.health.lock"

export PATH=/home/goya/.nvm/versions/node/v22.23.1/bin:/usr/local/bin:/usr/bin:/bin
# HEALTH_LOG deliberately NOT exported. The wrapper owns the log; letting the
# script write it too produced duplicate lines.

cd "$REPO" || exit 1

# A probe takes up to ~2 minutes. Cron fires every 15, so overlap should be
# impossible, but a hung run must not stack up behind itself.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) verdict=SKIPPED reason=previous_run_still_active" >> "$LOG"
  exit 0
fi

OUT=$(npx hardhat run scripts/covalidatorHealth.ts --network base 2>&1)
STATUS=$?

# The probe prints one structured `verdict=` line on a completed run. Extract it
# here rather than having the script write the file itself: hardhat does not
# reliably pass env through to the script process, so HEALTH_LOG cannot be
# depended on. The wrapper already has the output, so it owns the log.
LINE=$(grep -m1 "verdict=" <<< "$OUT" || true)

if [ -n "$LINE" ]; then
  echo "$LINE" >> "$LOG"
else
  # Died before reaching a verdict: RPC down, missing key, compile error. Record
  # it so the log has no silent gaps.
  REASON=$(tail -1 <<< "$OUT" | tr -d '\n' | cut -c1-160)
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) verdict=PROBE_ERROR exit=$STATUS reason=${REASON:-unknown}" >> "$LOG"
fi

exit 0
