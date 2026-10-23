# TODO

## Unfinished in the L0 + L1 run (stopped by the context guard)

The server code for L0 and L1 is written and smoke-tested by hand over mTLS (heartbeat,
403 for an unknown certificate, handshake refusal without one, an internal payment
→ pain.002 + camt.054 in the inbox). Not yet done:

1. Tests (node:test), using `server/test/helpers.ts` (written; its pain.001 writer
   produces files that pass both published XSDs):
   - `mtls.test.ts`: real HTTPS with certs from `CERTS_DIR=$tmp scripts/dev-ca.sh`
     (no cert, foreign CA, unknown code → 403, non-numeric serialNumber → 403).
   - `auth.test.ts`: service-provider header rules (docs/decisions.md 1-5).
   - `inbox.test.ts`: order, next until DELETE, idempotent DELETE, count, list
     (default 10, max 100, JSON shape), GET by id, bulk delete (≤100), Filter-Response-Type,
     5-day expiry with ManualClock, heartbeat/mq.
   - `payments.test.ts`: internal (ACSC + DBIT + CRDT in the creditor's inbox, balances),
     external (ACSP then ACSC + DBIT), rails reject (RJCT, funds released), no funds,
     duplicate MsgId / PmtInfId, wrong NbOfTxs / CtrlSum, foreign or unknown debtor
     account, corrupted file, non-XML → 400, pain.001.001.03 → pain.002.001.03, sunset,
     invalid Prtry, PART, camt.054.001.08, XSD-validate every pain.002.001.10 and camt.054
     produced, run the published samples (reference/samples, STRICT_IBAN off).
   - `sim.test.ts`: fund, incoming credit → camt.054 CRDT, create customer.
2. `npm run check` green, commit L0 and L1.
3. README.md in the open-ledger style (status table by level, run with the dev CA,
   curl examples).

## Next levels

- Account statements and balances: camt.060 requests → camt.053 / camt.052 (.08 and older).
- Pending payments (SCA in the internet bank → PDNG, approve via /_sim), manual review (PDNG NARR).
- Virtual IBAN services (viban open/bulk/modify/info/close, status notifications).
- SEPA direct debit: pain.008, pain.007, collection notifications.
- JSON services: FX trade offers, contracts, webhooks (notifications/subscriptions).
- Agency account synchronisation (indirect scheme access).
- Verification of payee.
- Duplicate-payment detection (InstrId), daily/monthly limits, code page 1257 conversion.
- Conformance harness: record exchanges against connect.test.lhv.eu once a sandbox
  certificate exists; compare like open-ledger's conformance/ with a divergences file.
- open-ledger as the backing `Ledger` (SDK/HTTP); real rails bridges (SEPA, SEPA Inst,
  UK Faster Payments) behind `Rails`.
- Persistence (Postgres) for inbox and ledger.
