#!/usr/bin/env bash
# Downloads the public XML schemas and sample messages of the LHV Connect
# documentation into reference/ (git-ignored: they are not ours to redistribute).
# The server validates pain.001, camt.060 and the VIBAN requests against these schemas when
# they are present, and the tests run the sample payments through the server. Checksums are pinned in
# scripts/reference.sha256; a changed file is reported, not silently used.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
base=https://partners.lhv.ee/assets/files
out="$root/reference"
mkdir -p "$out/xsd" "$out/samples"

xsd="pain.001.001.03 pain.001.001.09 pain.002.001.10 supl.001.001.01 camt.054.001.02 camt.054.001.08
camt.060.001.03 camt.060.001.05 camt.053.001.08 camt.052.001.08
viban.common viban.open.request viban.open.response viban.bulk.request viban.bulk.response
viban.modify.request viban.modify.response viban.info.request viban.info.response
viban.close.request viban.close.response viban.status.notification"
samples="PAYMENT_INTERNAL/PAYMENT_PAIN.001.xml PAYMENT_INTERNAL/PAYMENT_PAIN.002A.xml
PAYMENT_INTERNAL/CREDIT_DEBIT_NOTIFICATION_CAMT.054A.xml PAYMENT_INTERNAL/CREDIT_DEBIT_NOTIFICATION_CAMT.054B.xml
PAYMENT_SEPA/PAYMENT_PAIN.001.xml PAYMENT_SEPA/PAYMENT_PAIN.002A.xml PAYMENT_SEPA/PAYMENT_PAIN.002B.xml
PAYMENT_SEPA_INST/PAYMENT_PAIN.001.xml PAYMENT_SEPA_INST/PAYMENT_PAIN.002A.xml
PAYMENT_MULTI/PAYMENT_PAIN.001.xml PAYMENT_MULTI/PAYMENT_PAIN.002A.xml PAYMENT_MULTI/PAYMENT_PAIN.002B.xml
PAYMENT_VIBAN_SEPA/ACCOUNT_STATEMENT_CAMT.060.xml PAYMENT_VIBAN_SEPA/ACCOUNT_STATEMENT_CAMT.053A.xml
PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.001.xml PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.002A.xml PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.002B.xml
PAYMENT_VIBAN_SEPA/CREDIT_DEBIT_NOTIFICATION_CAMT.054A.xml"

fetch() { # url file
  [ -s "$2" ] && return 0
  curl -fsSL --retry 2 -o "$2.tmp" "$1" && mv "$2.tmp" "$2"
}
for x in $xsd; do fetch "$base/XSD/$x.xsd" "$out/xsd/$x.xsd"; done
for s in $samples; do fetch "$base/samples/$s" "$out/samples/${s//\//__}"; done

cd "$out"
if [ -f "$root/scripts/reference.sha256" ]; then
  shasum -a 256 -c --quiet "$root/scripts/reference.sha256" || { echo "reference files differ from the pinned checksums" >&2; exit 1; }
else
  find xsd samples -type f | sort | xargs shasum -a 256 > "$root/scripts/reference.sha256"
  echo "pinned checksums in scripts/reference.sha256"
fi
echo "reference material in $out"
