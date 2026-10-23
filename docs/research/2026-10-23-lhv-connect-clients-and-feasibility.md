# LHV Connect: who uses it, and whether an open-source compatible server makes sense

Research of 2026-10-23. Sources at the end. Client lists are mostly from 2019–2023; LHV
claims "200+" fintech clients today but names only a handful publicly.

## Why LHV Connect

LHV Connect is the API through which LHV Bank (UK) and LHV Pank (Estonia) serve fintechs,
payment institutions and crypto firms: safeguarding accounts, virtual IBANs, GBP and EUR
instant payments, FX, statements. LHV is a direct member of UK Faster Payments (Bank of
England account since 2019/2020), SEPA Instant and TARGET Instant Payment Settlement (TIPS).
The implementation is closed source; the API is public. That makes it the same situation
as Minka (`../minka/open-ledger`) and S3/MinIO: implement the contract, own the internals.

## Publicly confirmed clients

| Client | Note | Source |
|---|---|---|
| Wise (TransferWise) | First banking-services client (approached LHV 2011, onboarded 2014) | Latitude59, e-Estonia |
| Coinbase | Since 2014; virtual IBANs in Europe, TIPS for instant withdrawals | LHV news |
| Blockchain.com | Among ~200 intermediary clients of the UK branch | Fintech Times |
| Bitstamp | Banking partner since 2019; liquidity for LHV's crypto trading since Nov 2021 | Bitstamp blog, LHV |
| Airwallex | | Latitude59, Mambu |
| Currencycloud (Visa) | | Latitude59, Mambu |
| TrueLayer | | Latitude59 |
| Paysafe | | Mambu, LHV |
| Trustly | | Mambu, LHV |
| Monese | | Mambu, Fintech Times |
| TransferGo | | Fintech Times |
| Railsbank (Railsr) | | Mambu |
| Lightyear | EUR safeguarding + instant EUR (2022) | The Paypers |
| Single.Earth | (2022) | The Paypers |
| B4B Payments | Safeguarding, virtual IBANs | Financial IT |

Infrastructure partners (routes to LHV, not end clients):
- **Tuum**: resells LHV safeguarding, VIBAN and FX through its own API since 2021; became
  LHV Bank's core banking system in 2025.
- **Salt Edge**: UK open banking compliance for LHV Bank (2025).

**Not confirmed by any public source:** Monerium (the user knows it from elsewhere; neither
LHV nor monerium.com/partners mentions it), Revolut, Kraken, Gemini, Bitpanda, Nexo,
Crypto.com, MoonPay, Ramp, Banxa, Payoneer, Paysera, Circle.

## Feasibility of a compatible open-source server

### Why it is feasible, and easier than Minka

- Documentation is public, on one page (https://partners.lhv.ee/en/connect/, ~480k chars).
- Payloads are mostly an open standard, ISO 20022: `pain.001` (.03 being phased out, .09)
  → `pain.002`; `pain.008` direct debit; `camt.060` requests → `camt.052` balances,
  `camt.053` statements; `camt.054` debit/credit notifications. Some XSDs are published,
  including an LHV-specific `pain.001.001.03`. FX, contracts and webhooks are JSON.
- Small surface, about 30 operations (Minka: 146): heartbeat, messages inbox, account
  statement/balance, verification of payee, payment, VIBAN (open, bulk open, modify, info,
  close), agent account synchronize, direct debit collection, FX, merchant payment report,
  contracts, webhooks.
- Async inbox model: requests return `Message-Request-Id`; `GET /messages/next` (200/204),
  confirm with `DELETE /messages/{Message-Response-Id}`; `GET /messages`, `/messages/count`,
  `POST /messages/delete` (≤100 ids); unread messages expire after 5 days.
- Auth is mTLS with client certificates issued by LHV; trivial to emulate with an own CA.
  Some operations additionally need Estonian ID-card / Mobiil-ID / Smart-ID signatures.
  Service providers acting for end-users send `Client-Code` and `Client-Country`.

### Where it differs from Minka

1. **No public sandbox.** `connect.test.lhv.eu` is free but issued per customer on request
   (connect@lhv.ee), with test certificates; probably needs a legal entity with an LHV
   agreement. The Prelive sandbox is decommissioned from 2026-08-01. Without access there is
   no recording of reference exchanges as in `open-ledger/conformance`; the docs are the only
   spec. Read the sandbox terms for reverse-engineering clauses before recording.
2. **No official SDK** to drive scenarios (Minka had `@minka/ledger-sdk`); we write our own
   client from the doc examples, so recordings are less authoritative.
3. **Real money behind the API.** A server alone moves nothing; the question is what sits
   behind the facade.

### Target architecture and products

Connect-compatible facade → core ledger (`open-ledger`) → bridges to schemes or a simulator.
`open-ledger` already has the ledger and 2PC bridge layer.

1. **Local emulator** (LocalStack-style): develop and test an LHV integration without a
   sandbox contract. No licence needed; immediate value.
2. **Same API in front of other banks**: a client written for LHV works with another bank
   through an adapter.
3. **BaaS stack for smaller banks and EMIs**: offer their fintechs an API those fintechs
   already speak. This is the real MinIO analogue.

### Legal notes (not legal advice)

- CJEU C-406/10 *SAS Institute v World Programming*: functionality, programming language
  and data file formats are not protected by copyright, so implementing a compatible
  interface is generally fine.
- The documentation text is protected: the mirror (`../docs.lhv-connect`) stays a local,
  unpushed internal specification; our own docs are written from scratch.
- "LHV" and "Connect" are theirs: the project is described as *compatible with the LHV
  Connect API*, never named after it.

## Sources

- https://www.mambu.com/partner/lhv
- https://latitude59.ee/lhv-bank-a-steadfast-ally-for-fintech-startups/
- https://e-estonia.com/lhv-the-neobank-preferred-by-fintechs/
- https://thefintechtimes.com/regulators-review-payment-infrastructures-lhv-uk-banking-licence-application/
- https://www.lhv.com/about/news/coinbase-and-lhv-bank-celebrate-decade-long-partnership
- https://blog.bitstamp.net/post/bitstamp-partners-with-cutting-edge-lhv-bank-to-offer-crypto-trading/
- https://www.lhv.com/about/news/lhv-becomes-the-first-bank-to-give-fintechs-access-to-instant-pound-and-euro-payments
- https://thepaypers.com/payments/news/lightyear-taps-lhv-for-instant-eur-payments
- https://thepaypers.com/crypto-web3-and-cbdc/news/singleearth-choses-lhv-uk-as-banking-partner
- https://financialit.net/news/payments/b4b-payments-chooses-lhv-banking-services-fuel-international-growth
- https://www.crowdfundinsider.com/2021/10/182305-lhv-uk-the-financial-and-payment-services-platform-teams-up-with-tuum/
- https://tuum.com/news/salt-edge-tuum-and-lhv-bank-partner-to-accelerate-growth-through-secure-open-banking/
- https://monerium.com/partners/
- https://www.lhv.ee/en/faq/crypto/
- https://partners.lhv.ee/en/connect/
