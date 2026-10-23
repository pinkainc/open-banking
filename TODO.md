# TODO

## Done: L0 + L1 (2026-10-23)

Server, 99 node:test cases (all green in `npm run check`), README, `npm run coverage`.
Spec mismatches against the docs mirror fixed: messages-API 404/400 as JSON, DELETE of
a never-existing id 404, bulk delete 200/207/400, empty list 204, `X-Bank-Code`, 413
above 5 MB, `X-Idempotency-Key` 409, heartbeat `AuthorizedUser` = certificate holder
(docs/decisions.md 8, 9, 11, 25-28).

## Open in L0 / L1

- Per-contract service grants: 403 "User has not been granted the requested service"
  (needs a services list per customer in the seed).
- Certificate validity checks with their documented 403 texts (not yet valid, expired,
  "User authentication certificate is different than expected" when the certificate is
  not the one on the contract). Today any certificate from the trusted CA whose code
  is known is accepted.
- gzip/deflate of inbox messages ≥10 MB (`Accept-Encoding`), 500 without it.
- ACWC "Payment processed as European payment" when an automatic instant payment falls
  back to SEPA after being attempted (today the fallback is decided up front, no ACWC).
- Code page 1257 folding of free text echoed into pain.002 / camt.054.
- Bounded memory: inbox tombstones (ids kept so a repeat DELETE is 200) and remembered
  MsgIds / idempotency keys grow without limit.
- Run the PSP use-case samples (`PAYMENT_PSP_USECASES/case1..8`) once agency accounts
  and ultimate-debtor fields exist (L6), and `PAYMENT_SWIFT_*` / `PAYMENT_VIBAN_SEPA` with
  their own expectations.
- Sandbox recordings: work through the mirror's `ssot/sandbox-questions.md` (repeat
  DELETE, bulk statuses, heartbeat/mq type, idempotency and 413 on the EE host) and
  revise the decisions they settle.

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
