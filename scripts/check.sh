#!/usr/bin/env bash
# Everything that must be green before a commit: type check and unit tests (memory and Postgres),
# then the ledger on open-ledger when its repo is there.
# Reference XSDs, samples and the ISO 20022 schemas are fetched once when missing (offline:
# those checks are skipped).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .rec
{ [ -d reference/xsd ] && [ -d reference/iso ]; } || scripts/fetch-reference.sh > .rec/fetch.log 2>&1 || echo "==> reference material unavailable (offline?); XSD tests will skip"
# A project-local Postgres (scripts/dev-db.sh, port 5441). The suite runs twice (decision
# 912): emulators on the memory store (the inbox and ledger tests also against Postgres),
# then every emulator's inbox and ledger in Postgres (OPEN_BANKING_STORE=postgres), each
# run on an empty database.
echo "==> typecheck" && npx tsc -p .
fail=0
for store in memory postgres; do
  export DATABASE_URL=$(scripts/dev-db.sh fresh "open_banking_test_$store")
  echo "==> unit tests ($store store)"
  OPEN_BANKING_STORE=$store npm test > ".rec/test-$store.log" 2>&1 && ok=1 || ok=0
  grep -E "^ℹ (tests|pass|fail|skipped)" ".rec/test-$store.log" | sed "s/^/  /"
  if [ $ok = 0 ] || ! grep -qE "^ℹ skipped 0$" ".rec/test-$store.log"; then
    grep -E "✖|Error|expected|actual" ".rec/test-$store.log" | head -60
    fail=1
  fi
done
# Third (decision 927): the ledger contract and an emulator end to end on OpenLedgerLedger,
# against a real open-ledger server (OPEN_LEDGER_DIR, default ../../minka/open-ledger; the
# tests start it on a free port, memory store). Not there: said loudly, not skipped silently.
unset DATABASE_URL
ol_dir=$(cd "${OPEN_LEDGER_DIR:-../../minka/open-ledger}" 2>/dev/null && pwd || echo "${OPEN_LEDGER_DIR:-../../minka/open-ledger}")
if [ -d "$ol_dir/node_modules" ]; then
  echo "==> open-ledger ledger tests ($ol_dir)"
  OPEN_LEDGER_DIR="$ol_dir" OPEN_LEDGER_TESTS=1 node --import tsx --test server/test/ledger.test.ts server/test/open-ledger.e2e.ts > .rec/test-open-ledger.log 2>&1 && ok=1 || ok=0
  grep -E "^ℹ (tests|pass|fail|skipped)" .rec/test-open-ledger.log | sed "s/^/  /"
  if [ $ok = 0 ] || ! grep -qE "^ℹ skipped 0$" .rec/test-open-ledger.log; then
    grep -E "✖|Error|expected|actual" .rec/test-open-ledger.log | head -60
    fail=1
  fi
else
  echo "==> open-ledger not found at $ol_dir (or no node_modules); open-ledger ledger tests not run"
fi
[ $fail = 0 ]
