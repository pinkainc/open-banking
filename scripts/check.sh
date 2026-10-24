#!/usr/bin/env bash
# Everything that must be green before a commit: type check and unit tests (memory and Postgres).
# Reference XSDs, samples and the ISO 20022 schemas are fetched once when missing (offline:
# those checks are skipped).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .rec
{ [ -d reference/xsd ] && [ -d reference/iso ]; } || scripts/fetch-reference.sh > .rec/fetch.log 2>&1 || echo "==> reference material unavailable (offline?); XSD tests will skip"
# A project-local Postgres (scripts/dev-db.sh, port 5441) with an empty database: the
# inbox tests run against memory and Postgres.
export DATABASE_URL=$(scripts/dev-db.sh fresh open_banking_test)
echo "==> typecheck" && npx tsc -p .
echo "==> unit tests"
npm test > .rec/test.log 2>&1 && ok=1 || ok=0
grep -E "^ℹ (tests|pass|fail|skipped)" .rec/test.log
[ $ok = 1 ] || { grep -E "✖|Error|expected|actual" .rec/test.log | head -60; exit 1; }
