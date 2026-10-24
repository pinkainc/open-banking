#!/usr/bin/env bash
# Downloads the public XML schemas and sample messages of the LHV Connect
# documentation into reference/ (git-ignored: they are not ours to redistribute), and the
# ISO 20022 schemas of the message versions LHV publishes no XSD for (reference/iso/, from
# the iso20022.org message archive: camt.053.001.02, camt.052.001.06, decision 550; the Bacs
# pain.009/.012/.011/.008.001.11/.002.001.14/.007.001.11 of G "LHV uses the standard version",
# decision 748).
# The server validates pain.001, pain.008, pain.007, camt.060 and the VIBAN requests against these schemas when
# they are present, and the tests run the sample payments through the server (and check every
# AGENT_ACCOUNT_SYNC answer against account.agent.sync.xsd). Checksums are pinned in
# scripts/reference.sha256; a changed file is reported, not silently used.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
base=https://partners.lhv.ee/assets/files
out="$root/reference"
iso=https://www.iso20022.org/sites/default/files/documents/messages
mkdir -p "$out/xsd" "$out/samples" "$out/iso"

xsd="pain.001.001.03 pain.001.001.09 pain.002.001.10 supl.001.001.01 pain.008.001.08 pain.007.001.09 camt.054.001.02 camt.054.001.08
camt.060.001.03 camt.060.001.05 camt.053.001.08 camt.052.001.08
viban.common viban.open.request viban.open.response viban.bulk.request viban.bulk.response
viban.modify.request viban.modify.response viban.info.request viban.info.response
viban.close.request viban.close.response viban.status.notification
account.agent.sync"
samples="PAYMENT_INTERNAL/PAYMENT_PAIN.001.xml PAYMENT_INTERNAL/PAYMENT_PAIN.002A.xml
PAYMENT_INTERNAL/CREDIT_DEBIT_NOTIFICATION_CAMT.054A.xml PAYMENT_INTERNAL/CREDIT_DEBIT_NOTIFICATION_CAMT.054B.xml
PAYMENT_SEPA/PAYMENT_PAIN.001.xml PAYMENT_SEPA/PAYMENT_PAIN.002A.xml PAYMENT_SEPA/PAYMENT_PAIN.002B.xml
PAYMENT_SEPA_INST/PAYMENT_PAIN.001.xml PAYMENT_SEPA_INST/PAYMENT_PAIN.002A.xml
PAYMENT_MULTI/PAYMENT_PAIN.001.xml PAYMENT_MULTI/PAYMENT_PAIN.002A.xml PAYMENT_MULTI/PAYMENT_PAIN.002B.xml
PAYMENT_VIBAN_SEPA/ACCOUNT_STATEMENT_CAMT.060.xml PAYMENT_VIBAN_SEPA/ACCOUNT_STATEMENT_CAMT.053A.xml
PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.001.xml PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.002A.xml PAYMENT_VIBAN_SEPA/PAYMENT_PAIN.002B.xml
PAYMENT_VIBAN_SEPA/CREDIT_DEBIT_NOTIFICATION_CAMT.054A.xml
DIRECT_DEBIT_SEPA/DIRECT_DEBIT_PAIN.008.xml"
# The partner site's PSP use cases 1-8 (psp-use-cases.test.ts, decision 955).
for n in 1 2 3 4 5 6 7 8; do
  for f in pain.001.xml pain.002_ACSP.xml pain.002_ACSC.xml CAMT.054.001.02.xml; do samples="$samples PAYMENT_PSP_USECASES/case${n}_$f"; done
done
isoxsd="camt.053.001.02 camt.052.001.06
pain.009.001.07 pain.012.001.07 pain.011.001.07 pain.008.001.11 pain.002.001.14 pain.007.001.11"

fetch() { # url file
  [ -s "$2" ] && return 0
  curl -fsSL --retry 2 -o "$2.tmp" "$1" && mv "$2.tmp" "$2"
}
for x in $xsd; do fetch "$base/XSD/$x.xsd" "$out/xsd/$x.xsd"; done
for s in $samples; do fetch "$base/samples/$s" "$out/samples/${s//\//__}"; done
for x in $isoxsd; do fetch "$iso/${x%%.*}/schemas/$x.xsd" "$out/iso/$x.xsd"; done

cd "$out"
if [ -f "$root/scripts/reference.sha256" ]; then
  shasum -a 256 -c --quiet "$root/scripts/reference.sha256" || { echo "reference files differ from the pinned checksums" >&2; exit 1; }
else
  find xsd samples iso -type f | sort | xargs shasum -a 256 > "$root/scripts/reference.sha256"
  echo "pinned checksums in scripts/reference.sha256"
fi
echo "reference material in $out"
