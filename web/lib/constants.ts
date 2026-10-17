// Shared lists, safe to use in the browser (no database code).
export const DOC_TYPES = ["COA", "MSDS", "TDS", "SPEC", "LABEL", "OTHER"] as const;
export const ENTITIES = ["TMC", "TMCGULF", "PHARMALABO"] as const;
export const STATUSES = ["Draft", "To check", "Final", "Superseded", "Rejected"] as const;
export const ROLES = ["admin", "approver", "user"] as const;

// Neutralise jobs (BRIEF 6). Route = the engine route; "auto" lets the engine classify.
export const JOB_STATES = ["queued", "running", "to_check", "done", "failed"] as const;
export const JOB_KINDS = ["neutralise", "finalise"] as const;
export const ROUTES = ["auto", "coa", "sds", "tds"] as const;

export type JobState = (typeof JOB_STATES)[number];
export type Route = (typeof ROUTES)[number];
export type DocType = (typeof DOC_TYPES)[number];
export type Entity = (typeof ENTITIES)[number];
export type DocStatus = (typeof STATUSES)[number];
