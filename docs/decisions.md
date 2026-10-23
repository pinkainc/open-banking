# Decisions where the published documentation is silent

Each entry: what the docs leave open, what this server does, and why. Revisit when
recordings against the reference sandbox exist.

| # | Topic | Choice |
| --- | --- | --- |
| 1 | Client identity | Certificate subject `serialNumber` (must be numeric, else 403 "Certificate has invalid SERIALNUMBER field") is the customer's registration code; without it, the subject CN. |
| 2 | No or untrusted client certificate | Refused in the TLS handshake (`requestCert` + `rejectUnauthorized`), not with an HTTP status. |
| 3 | 403 body | `<Errors><Error><ErrorCode>FORBIDDEN</ErrorCode><Description>…</Description></Error></Errors>`, the documented error document, with the documented messages (ASCII quotes). |
| 4 | Client-Country matching | Code and country must both match. The docs' service-provider sample pairs code 100100 with both EE and UK; read as a typo. |
| 5 | Inbox ownership | One inbox per customer (code + country), shared by every access path (own certificate, any service provider). |
| 6 | Message headers | `Message-Response-Id`, `Message-Response-Type`, `Message-Request-Id` (absent on camt.054), plus `Client-Code` / `Client-Country`, since the list JSON says those fields "match the headers". |
| 7 | `GET /messages?limit` | Default 10, values above 100 are clamped to 100; non-positive or non-integer is 400. |
| 8 | Unknown message id | Follows the GitBook pages: `GET /messages/{id}` and `DELETE` of an id that never existed for this caller (unknown or another customer's) are 404 with `{"errors":[{"errorCode":"NOT_FOUND","description":"Requested resource not found"}]}`. `DELETE` of a message already deleted or expired is 200 (the behaviour the EE host adopts on 23.11.2026). Other messages-API errors (bad `limit`, bad bulk body) use the same JSON shape. |
| 9 | Bulk delete | Per id: 200 when deleted (or already deleted), 400 when it never existed. HTTP 200 when all are 200, 207 when some are, 400 when none are (the GitBook "OK / Multi-Status / Bad request" tabs). More than 100 ids, an empty array or a body without a string array is 400 and deletes nothing. |
| 10 | Expiry | Unread messages older than 5 days are invisible at once and purged hourly (clock injectable). |
| 11 | `GET /heartbeat/mq`, `POST /heartbeat` | 202 + `Message-Request-Id`; the inbox message has type `HEARTBEAT` (the webhook type list names it). `AuthorizedUser` is the certificate holder ("takes authenticated user info"), also when a service provider acts for a customer; the message goes to the customer's inbox. POST does not verify BDOC: the body is echoed in `UserRequest`. |
| 12 | Body that is not XML | `POST /payment` answers 400 synchronously (no MsgId to refer to); well-formed but invalid files get the documented pain.002 group RJCT "Corrupted payment file: …". `application/vnd.etsi.asic-e+zip` is 415. |
| 13 | Processing timing | Synchronous: all pain.002 / camt.054 messages exist when POST returns 202. |
| 14 | Duplicate MsgId | Remembered per customer only for files that passed file-level checks, so a corrected file may reuse its MsgId. |
| 15 | Internal vs external | A creditor IBAN known to the emulator is INTERNAL; any other goes to the rails. |
| 16 | Statuses | Internal: one pain.002 ACSC (+ group status) and camt.054 DBIT/CRDT. External: pain.002 ACSP with group status, then pain.002 ACSC (no group status) + camt.054 DBIT, or RJCT when the rails reject (reservation released). As in the published SEPA samples. |
| 17 | Scheme selection | Requested INST/SEPA/TARGET2 needs EUR (else "Invalid currency.") and a SEPA country (else "Payment declined."); automatic: EUR + SEPA country → INST if reachable, else SEPA; otherwise SWIFT. Invalid `Prtry` rejects the whole file. |
| 18 | IBAN check digits | Creditor IBANs are mod-97 checked (`STRICT_IBAN=0` turns it off; the published samples use placeholder IBANs). |
| 19 | pain.002.001.03 shape | ISO names of that version (`BICOrBEI`, `BIC`, no `Pty`, ISODate). The docs say "BIC" for the initiating party; no XSD was published to settle it. |
| 20 | pain.001.001.03 sunset | Refused from 2026-11-15 (docs' announced end), by the injectable clock; `PAIN_001_001_03_UNTIL` overrides. |
| 21 | camt.054 version | 02 by default, 08 per customer (`camt054: "08"`), as "upon request" in the docs. One notification per payment. |
| 22 | Multi-currency | An account holds a balance per currency; a payment debits the balance of its currency, no FX. |
| 23 | Bank identity in messages | BIC `LHVBEE22` by default (clients may compare it), bank name `open-banking emulator`; both set in the seed. |
| 24 | XSDs | Not committed: `scripts/fetch-reference.sh` downloads them with pinned checksums; without them, structural checks only. Tests read XSDs and samples from the local docs mirror (`LHV_DOCS_DIR`, default `../docs.lhv-connect`) when present, else from `reference/`, and skip with a message when neither exists. |
| 25 | `X-Bank-Code` | `LHVEE` on every response, errors and `/_sim` included (`bankCode` option of `buildApp`). |
| 26 | Body limit | Bodies over 5 MB are 413 with `<Errors><Error><ErrorCode>413</ErrorCode><Description>Request Entity Too Large</Description>…`. The reference's nginx answers an HTML page; the error document follows the 503 sample's numeric-code form instead. |
| 27 | `X-Idempotency-Key` | On every Connect POST: a key that already got a 2xx from the same certificate holder within 24 h (injectable clock) is 409 with `ErrorCode` `CONFLICT`; a value that is not a UUID is 400. A failed request does not use up its key. Not applied to `/_sim`. |
| 28 | Empty list | `GET /messages` with nothing pending is 204 without a body (GitBook "204 - no more messages"), not an empty array. |

## L3

| # | Topic | Choice |
| --- | --- | --- |
| 200 | VIBAN business errors | 202 + an inbox message of the operation's type (`VIBAN_OPEN` …) whose body is `<Errors>`: the GitBook shows only 202 and 403 for `/viban/*`, and the mirror reads service-level errors as inbox messages. Switch with `VIBAN_ERRORS=sync` / `vibanErrors: 'sync'` / `POST /_sim/viban/errors` → the same `<Errors>` as the HTTP answer (403 FORBIDDEN, 500 TECHNICAL_ERROR, else 400). Not-well-formed XML is `INVALID_REQUEST` through the same channel. |
| 201 | Check order | XML/root → birth dates and countries → XSD and required elements (`INVALID_REQUEST`) → master account (`INVALID_ACCOUNT`, `FORBIDDEN` MasterAccount, `MASTER_ACCOUNT_AGREEMENT_MISSING`) → VIBAN (`INVALID_VIBAN`, `FORBIDDEN` VirtualIBAN) → operation rules. Field checks run before the XSD so `INVALID_BIRTH_DATE` / `INVALID_COUNTRY` are reachable; all field errors of a request are listed together. `Field` is the bare element name (`BirthDate`). |
| 202 | Agreement | Required for open, bulk and modify; info and close only need ownership. Set per account with `"viban": true` in the seed or `POST /_sim/viban/agreements`. |
| 203 | Ownership | A VIBAN belongs to the customer owning its master account; service providers reach it with `Client-Code`/`Client-Country`. A VIBAN under another master (also another customer's) is `FORBIDDEN` "Unauthorized virtual IBAN.", not `INVALID_VIBAN`. |
| 204 | ClientReference | Unique per customer over all its VIBANs, closed ones included. Modify may set it once when empty; omitting it keeps it. |
| 205 | Numbers | EE: bank code 77, account `77` + 11-digit serial + 7-3-1 check digit (the published `EE…7777…` numbers pass the same checks); GB: master's bank code and sort code + account `7xxxxxxx`. ISO mod-97 check digits. |
| 206 | Screening | ACTIVE unless a holder or representative name is on the simulator's list (`POST /_sim/viban/screening`) → ON_HOLD. Bank decisions via `POST /_sim/viban/:iban/status` (ON_HOLD→ACTIVE/REJECTED, ACTIVE⇄BLOCKED, →CLOSED) each send `VIBAN_STATUS_NOTIFICATION` (no Message-Request-Id); user-initiated changes do not. |
| 207 | Payments to a VIBAN | Booked on the master account; camt.054 `Acct` = master, `Cdtr`/`CdtrAcct` = holder name + address country / VIBAN (P 06). Not ACTIVE: internal pain.001 RJCT "Creditor account is closed." (CLOSED, REJECTED) or "Account temporarily closed." (PENDING, ON_HOLD, BLOCKED); `/_sim/incoming` answers `returned: true` with AC04 / AC06, nothing booked or notified. |
| 208 | Payments from a VIBAN | Debited from the master; RJCT "Debtor’s account not active." when not ACTIVE, "Invalid debtor’s name." when `Dbtr/Nm` differs from the holder (case and whitespace ignored); camt.054 `Dbtr`/`DbtrAcct` = holder / VIBAN. |
| 209 | Dates | `DateActivated` / `DateClosed` are xs:date with the Tallinn offset (`2026-03-10+02:00`), as the samples. |
| 210 | Docs mirror in tests | Refines 24: without `LHV_DOCS_DIR` the tests take the nearest `../docs.lhv-connect` walking up from the repo, so git worktrees nested in it (`.claude/worktrees/x`) find the mirror; there `reference/` is absent too, and 5 tests used to skip. The P 10 markdown replay needs the mirror (the page is not a downloadable file); with `reference/` only, that suite skips with a message. `fetch-reference.sh` also fetches the VIBAN XSDs and the PAYMENT_VIBAN_SEPA samples. |
| 211 | Master account format | The VIBAN XSDs' IBAN pattern admits EE-style (2 letters + 18 digits) and GB-style numbers only, so any other master (a DE IBAN) is `INVALID_REQUEST`, not `INVALID_ACCOUNT`; `INVALID_ACCOUNT` is a well-formed number nobody holds, or a VIBAN given as master. |
| 212 | Sample inconsistencies | The bulk sample's master `EE737700771001625166` has wrong IBAN check digits (the same BBAN as `EE83…` elsewhere): replayed as published it is `INVALID_ACCOUNT`, so the replay swaps in `EE83…`. The modify / info / notification sample responses do not echo their requests' names, so the replay compares element structure; the open samples are compared value for value except `VirtualIBAN`. |
