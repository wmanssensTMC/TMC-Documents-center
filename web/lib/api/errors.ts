// API v1 errors (contract section 10): a fixed code and a fixed English text per case. `fields`
// holds paths only, never values; no stack trace or database text ever goes out.

export const API_ERRORS = {
  invalid_json: [400, "The request body is not valid JSON."],
  missing_idempotency_key: [400, "The Idempotency-Key header is required."],
  unauthorized: [401, "Missing, unknown or inactive API key."],
  kind_not_allowed: [403, "This key may not start this kind of job."],
  entity_not_set_up: [403, "This entity is not set up in the Document Center."],
  not_found: [404, "Job not found."],
  idempotency_conflict: [409, "This Idempotency-Key was already used with another body."],
  not_cancellable: [409, "This job cannot be cancelled."],
  // v1.1 (contract section 15.4)
  not_waiting_for_input: [409, "This job does not wait for a supplier document."],
  not_final: [409, "This document is not Final."],
  file_too_large: [409, "This file is larger than the Document Center can send here."],
  length_required: [411, "The Content-Length header is required."],
  payload_too_large: [413, "The request body is too large."],
  unsupported_type: [415, "This file type is not accepted."],
  invalid_payload: [422, "The request does not match the contract."],
  unknown_field: [422, "The request has a field the contract does not allow."],
  not_accepted_for_kind: [422, "This kind of job does not take a supplier document."],
  rate_limited: [429, "Too many requests; try again later."],
  unavailable: [503, "The Document Center API is not available."],
} as const satisfies Record<string, readonly [number, string]>;

export type ApiErrorCode = keyof typeof API_ERRORS;

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly fields: string[] = [],
    readonly retryAfter?: number,
  ) {
    super(API_ERRORS[code][1]);
  }

  get status() {
    return API_ERRORS[this.code][0];
  }

  body() {
    return { error: { code: this.code, message: this.message, ...(this.fields.length ? { fields: this.fields } : {}) } };
  }
}
