#!/usr/bin/env bash
# Everything that must be green before a commit: type check and unit tests.
# Reference XSDs and samples are fetched once when missing (offline: those tests skip).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .rec
[ -d reference/xsd ] || scripts/fetch-reference.sh > .rec/fetch.log 2>&1 || echo "==> reference material unavailable (offline?); XSD tests will skip"
echo "==> typecheck" && npx tsc -p .
echo "==> unit tests"
npm test > .rec/test.log 2>&1 && ok=1 || ok=0
grep -E "^ℹ (tests|pass|fail|skipped)" .rec/test.log
[ $ok = 1 ] || { grep -E "✖|Error|expected|actual" .rec/test.log | head -60; exit 1; }
