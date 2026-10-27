# TMC Document Center API v1 (Document Center side)

The contract is `docs/DOCUMENT-CENTER-API.md` in the TMC Logistics repo (answers Willem 27/10/2026). This page says
how the Document Center implements it. Nothing here changes a hard rule of BRIEF section 7; there is no override field.

## Switch and settings

| Env (Vercel) | Meaning |
|---|---|
| `API_CLIENTS_ENABLED` | `on` = API answers. Anything else (default) = every call `503 unavailable`. |
| `APP_URL` | This app's own address (https; `http://localhost:3002` on a laptop). Used for every `link`. Missing or not https = `503`. |

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

Job and result shapes: contract 4.1 and 4.2. `link` of a job opens `/api-jobs/<id>`, of a result `/documents/<id>`
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
the database; reads 120 a minute per client, counted per server instance (approximate, Willem 27/10). Error codes and
texts: `web/lib/api/errors.ts` (contract section 10). Unexpected errors are `503 unavailable`; only the error name is
logged.

## Audit

`api.job.created` and `api.job.cancelled` (actor `<client>:<requestedBy>`; client, requestedBy, kind, request id),
`api.key.created` / `api.key.deactivated` (admin), `api.key.refused` (client prefix only, at most once a minute per
prefix and server). Reads are not audited; each key keeps "last used".

## In the app

- Neutralise page: "Requests from TMC Logistics waiting for you" (waiting-input and failed). All requests: `/api-jobs`.
- Request page: BC lines, state, runs and results. COA / SDS / TDS: "Add supplier document" (route and entity fixed, dossier =
  order no and product name = line description as proposals, supplier name mandatory). Label: "Make label" per line opens
  the label form prefilled.
- Deploy order: the worker (Railway) before the web app (Vercel), because the worker saves drafts of a cancelled request
  as Rejected.
