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
  payload_too_large: [413, "The request body is larger than 64 KB."],
  invalid_payload: [422, "The request does not match the contract."],
  unknown_field: [422, "The request has a field the contract does not allow."],
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
