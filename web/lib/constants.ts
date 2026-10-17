// Shared lists, safe to use in the browser (no database code).
export const DOC_TYPES = ["COA", "MSDS", "TDS", "SPEC", "LABEL", "OTHER"] as const;
export const ENTITIES = ["TMC", "TMCGULF", "PHARMALABO"] as const;
export const STATUSES = ["Draft", "To check", "Final", "Superseded"] as const;
export const ROLES = ["admin", "approver", "user"] as const;

export type DocType = (typeof DOC_TYPES)[number];
export type Entity = (typeof ENTITIES)[number];
export type DocStatus = (typeof STATUSES)[number];
