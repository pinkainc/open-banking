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
