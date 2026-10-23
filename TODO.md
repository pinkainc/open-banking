# TODO

## Done: L0 + L1 (2026-10-23)

Server, 99 node:test cases (all green in `npm run check`), README, `npm run coverage`.
Spec mismatches against the docs mirror fixed: messages-API 404/400 as JSON, DELETE of
a never-existing id 404, bulk delete 200/207/400, empty list 204, `X-Bank-Code`, 413
above 5 MB, `X-Idempotency-Key` 409, heartbeat `AuthorizedUser` = certificate holder
(docs/decisions.md 8, 9, 11, 25-28).

## Done: L2 + L3 (2026-10-23)

Statements and balances (decisions 100–116) and virtual IBANs (200–212), built in
parallel worktrees and merged; `npm run check` 204/204, no skips with the docs mirror.

## Open in L2 / L3

- VIBAN shown in camt.053 / camt.052 of the master account (samples camt.060 and
  camt.053A in `PAYMENT_VIBAN_SEPA`).
- Payment limits (10k daily / 100k monthly / 15k instant) are reported, not enforced.
- camt.053.001.02 and camt.052.001.06 get structural checks only (no published XSD);
  the public ISO 20022 schemas would allow real validation.
- Bank postal address (`PstlAdr`) is missing from statements.
- Sandbox: are statement and VIBAN business errors inbox messages (decisions 100, 200;
  sandbox question 11)? How do INTM balances look?

## Open in L0 / L1

- `X-Idempotency-Key` (decision 28) is documented only for the UK host (docs.lhv.com);
  the EE host detects duplicates by pain.001 `MsgId` alone (mirror `ssot/ee-vs-uk.md`).
  Scope it per host.

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
  and ultimate-debtor fields exist (L6), and `PAYMENT_SWIFT_*` with their own expectations.
- Sandbox recordings: work through the mirror's `ssot/sandbox-questions.md` (repeat
  DELETE, bulk statuses, heartbeat/mq type, idempotency and 413 on the EE host) and
  revise the decisions they settle.

## Next levels

- Pending payments (SCA in the internet bank → PDNG, approve via /_sim), manual review (PDNG NARR).
- SEPA direct debit: pain.008, pain.007, collection notifications.
- JSON services: FX trade offers, contracts, webhooks. EE and UK webhooks are two different
  systems (mirror `ssot/ee-vs-uk.md`); the UK HMAC golden value is in the mirror.
- UK flavour: `/accounts/*` (PascalCase JSON, AWS-style error bodies), CoP, Bacs, messages v2,
  `x-bank-code: LHVEE` routing to EE services.
- Agency account synchronisation (indirect scheme access).
- Verification of payee.
- Duplicate-payment detection (InstrId), daily/monthly limits, code page 1257 conversion.
- Conformance harness: record exchanges against connect.test.lhv.eu once a sandbox
  certificate exists; compare like open-ledger's conformance/ with a divergences file.
- open-ledger as the backing `Ledger` (SDK/HTTP); real rails bridges (SEPA, SEPA Inst,
  UK Faster Payments) behind `Rails`.
- Persistence (Postgres) for inbox and ledger.
