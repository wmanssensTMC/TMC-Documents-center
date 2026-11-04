# TMC Document Center API v1 (Document Center side)

The contract is `docs/DOCUMENT-CENTER-API.md` in the TMC Logistics repo (answers Willem 27/10/2026). This page says
how the Document Center implements it. Nothing here changes a hard rule of BRIEF section 7; there is no override field.

## Switch and settings

| Env (Vercel) | Meaning |
|---|---|
| `API_CLIENTS_ENABLED` | `on` = API answers. Anything else (default) = every call `503 unavailable`. |
| `APP_URL` | This app's own address (https; `http://localhost:3002` on a laptop). Used for every `link`. Missing or not https = `503`. |
| `DC_API_MAX_BODY_MB` | v1.1: the largest file a function takes or sends. Default 4 (Vercel stops near 4.5 MB); on Azure 100 (the Final file stays at most 25). |

Keys: Settings > API keys (admins). A key is `tdc_<client>_<43 chars>`, shown once, stored as SHA-256 only. At most two
active keys per client (current + next). Rotation: make the next key, put it in TMC Logistics, deactivate the old one.

## Endpoints (`/api/v1`, JSON)

| Call | Answer |
|---|---|
| `POST /jobs` + `Idempotency-Key` (= `source.requestId`) | `201` job, `200` same key + same body |
| `GET /jobs/{id}` | `200` job |
| `GET /jobs?ids=a,b` (1 to 100 uuids) | `200 { "jobs": [job, ...] }`; unknown or another client's ids left out |
| `GET /jobs/{id}/results` | `200 { "results": [result, ...] }` |
| `POST /jobs/{id}/cancel` `{ "requestedBy" }` | `200` job (also when already cancelled) |
| `GET /health` | `200 { "ok": true }`, no key |
| v1.1 `PUT /jobs/{id}/supplier-document` (raw PDF, `Content-Length`, `Idempotency-Key`, `X-File-Name`) | `201` job + `supplierDocument { sha256, size, contentType }`, `200` same hand-off again |
| v1.1 `GET /jobs/{id}/results/{documentId}/file` + `X-Requested-By` | `200` the Final PDF, `X-Content-SHA256`, `Content-Disposition` with the document name |

### v1.1 rules (contract section 15)

- Hand-off: COA, SDS and TDS jobs only (`422 not_accepted_for_kind`); only while the job waits for input and holds no
  handed-over document (`409 not_waiting_for_input`). The length is checked before a byte is read (`411`, `413`), then
  the real content: PDF only, DOCX and anything else `415 unsupported_type` (the engine reads PDF; conversion later).
  Same key + same bytes = `200`, other bytes `409 idempotency_conflict`. 10 hand-offs a minute per key.
- With a supplier name known (`facts.supplierName` on create, or typed by a person on the request page) the engine
  starts at once as an ordinary neutralise run: dossier = order no, product name = the line description only with
  exactly one line. Without it: `waiting-input`, problem "Supplier name needed". The file name (`X-File-Name`) stays
  internal; it never reaches an answer, an audit detail, a TMC document or a TMC file name.
- `facts.supplierName` (2 to 200 characters, neutralise kinds only; a label: `422 unknown_field`): internal, never in
  any answer.
- Final file: only a `Final` result of the caller's own job (`404` otherwise; `409 not_final` for every other status,
  Superseded too), PDF only, at most the platform limit (`413 too_large_for_link`). Counts as a read.

Job and result shapes: contract 4.1 and 4.2, with one rule: a result's `name` is `null` until it is Final (or
Superseded). A draft's name can still hold the supplier file's name or trade name; a Final's name is made from details
a person checked (security review S1). At most 100 results per job, Finals first, then the newest (contract
amendment f40cabf, 02/11). `GET /jobs?ids=` also lists cancelled jobs (state `cancelled`). New response fields may be
added in v1; removing or changing one means `/api/v2`. `link` of a job opens `/api-jobs/<id>`, of a result `/documents/<id>`
(both behind the sign-in). Strict bodies: an unknown key anywhere is `422 unknown_field` with its path.

## Payload rules

`kind` one of `coa-neutralise`, `sds-neutralise`, `tds-neutralise`, `label` (and allowed for the key); `entity` only
`TMC` (with its record); `source.app` = `tmc-logistics`; `requestedBy` a `@transmare.com` address; `reason` one of
`neutral-bc`, `neutral-customer`, `neutral-country`, `originals-by-courier`, `coo-draft-to-do`, `asked-by-person`;
`facts.lines` 1 to 500 lines `{ lineNo, itemNo, description }` (unique line numbers, item <= 50, description <= 250,
null = unknown). Text: no control or invisible characters, no leading `-`. Body <= 64 KB.

## State (worked out on every read, never stored)

| State | When |
|---|---|
| `cancelled` | cancelled through the API |
| `in-progress` | a run for the request is queued or running |
| `to-check` | a draft of the request waits for a check |
| `ready` | at least one Final (a Final later superseded still counts) and nothing open |
| `failed` | no Final, no draft open, and the latest run failed: problem "Engine could not read the document" |
| `waiting-input` | nothing usable yet, also when every draft was rejected: problem "Supplier document needed" (label: "Label to be made in Document Center") |

## Cancel

Queued runs stop (job state `cancelled`); drafts waiting for a check become Rejected "Not needed in TMC Logistics";
a running run finishes and its drafts are saved as Rejected (worker); a draft being finalised and every Final stay.
Nothing is deleted. A cancelled request takes no new supplier document or label.

## Limits and errors

Creates 30 a minute per client and 300 open requests per client (open = not cancelled and no Final yet), counted in
the database under one lock per client; per server instance (approximate, Willem 27/10): reads 120 a minute and writes
(creates, replays, cancels) 60 a minute per client, and 30 refused keys a minute per address, after which that address
gets `429` without a lookup. Error codes and
texts: `web/lib/api/errors.ts` (contract section 10). Unexpected errors are `503 unavailable`; only the error name is
logged.

## Audit

`api.job.created` and `api.job.cancelled` (actor `<client>:<requestedBy>`; client, requestedBy, kind, request id),
`api.key.created` / `api.key.deactivated` (admin), `api.key.refused` (a known client's name, otherwise "unknown"; at
most once a minute per name and 20 rows a minute per server). Reads are not audited; each key keeps "last used".
v1.1: `api.job.input` (client, job, SHA-256, size, content type; never the file name) and `api.result.file.read`
(client, requested by, job, document).

## In the app

- Neutralise page: "Requests from TMC Logistics waiting for you" (waiting-input and failed). All requests: `/api-jobs`.
- Request page: BC lines, state, runs and results. COA / SDS / TDS: "Add supplier document" (route and entity fixed, dossier =
  order no and product name = line description as proposals, supplier name mandatory). Label: "Make label" per line opens
  the label form prefilled. v1.1: a document TMC Logistics handed over without a supplier name shows "Supplier document
  from TMC Logistics" with the supplier name to type (prefilled when it came with the job) and "Send to the neutralizer".
- Deploy order: the worker (Railway) before the web app (Vercel), because the worker saves drafts of a cancelled request
  as Rejected.
