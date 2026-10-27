// Shared lists, safe to use in the browser (no database code).
export const DOC_TYPES = ["COA", "MSDS", "TDS", "SPEC", "LABEL", "OTHER"] as const;
export const ENTITIES = ["TMC", "TMCGULF", "PHARMALABO"] as const;
export const STATUSES = ["Draft", "To check", "Final", "Superseded", "Rejected"] as const;
export const ROLES = ["admin", "approver", "user"] as const;

// Neutralise jobs (BRIEF 6). Route = the engine route; "auto" lets the engine classify.
// "cancelled": a queued run stopped by a request from TMC Logistics (API v1, contract section 9).
export const JOB_STATES = ["queued", "running", "to_check", "done", "failed", "cancelled"] as const;
export const JOB_KINDS = ["neutralise", "finalise", "label"] as const;
export const ROUTES = ["auto", "coa", "sds", "tds"] as const;
// Label languages: only those with texts in engine/assets/label_texts.json (Arabic when supplied).
export const LABEL_LANGUAGES = ["EN", "FR"] as const;

// API v1 (contract docs/API.md): what a calling app may ask for, and the state it reads back.
export const API_JOB_KINDS = ["coa-neutralise", "sds-neutralise", "tds-neutralise", "label"] as const;
export const API_JOB_STATES = ["waiting-input", "in-progress", "to-check", "ready", "failed", "cancelled"] as const;
/** The engine route of each neutralise kind (label has its own form). */
export const API_KIND_ROUTE = { "coa-neutralise": "coa", "sds-neutralise": "sds", "tds-neutralise": "tds", label: null } as const;

export type JobState = (typeof JOB_STATES)[number];
export type Route = (typeof ROUTES)[number];
export type DocType = (typeof DOC_TYPES)[number];
export type Entity = (typeof ENTITIES)[number];
export type DocStatus = (typeof STATUSES)[number];
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];
export type ApiJobKind = (typeof API_JOB_KINDS)[number];
export type ApiJobState = (typeof API_JOB_STATES)[number];
