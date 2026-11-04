// Database tables (BRIEF section 6). Phase 1: documents, users, audit log.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type { Edits } from "../documents/edits";
import { API_JOB_KINDS, DOC_TYPES, ENTITIES, JOB_KINDS, JOB_STATES, ROLES, ROUTES, STATUSES } from "../constants";

export { API_JOB_KINDS, DOC_TYPES, ENTITIES, JOB_KINDS, JOB_STATES, ROLES, ROUTES, STATUSES };
export type { DocStatus, DocType, Entity, JobState, Route } from "../constants";

export const docType = pgEnum("doc_type", DOC_TYPES);
export const entityCode = pgEnum("entity_code", ENTITIES);
export const docStatus = pgEnum("doc_status", STATUSES);
export const role = pgEnum("role", ROLES);
export const jobState = pgEnum("job_state", JOB_STATES);
export const jobKind = pgEnum("job_kind", JOB_KINDS);
export const route = pgEnum("route", ROUTES);
export const apiJobKind = pgEnum("api_job_kind", API_JOB_KINDS);

// Entity records the engine prints (BRIEF 6, engine/entity.example.json). Only an admin edits
// them; a job for an entity without a record is refused: an address is never invented.
export const entities = pgTable("entities", {
  code: entityCode("code").primaryKey(),
  naam: text("naam").notNull(),
  adres: text("adres").notNull(),
  telefoon: text("telefoon").notNull(),
  email: text("email").notNull(),
  web: text("web").notNull(),
  btw: text("btw").notNull(),
  nood: text("nood").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type JobFile = { key: string; filename: string };
export type YellowPart = { id: string; text: string; context: string; truncated?: boolean };
export type DocMetadata = { productName: string; fileNr: string | null; batch: string | null };
/** finalise jobs: either the on-screen fixes, or a checked Word file the person uploaded. */
export type FinalisePayload = {
  metadata: DocMetadata;
  /** The Final of another document the person confirmed this one replaces (reviews M1/R2). */
  replaces?: string | null;
} & (
  | { mode: "editor"; fixes: Record<string, { value: string; confirmed: true }> }
  | { mode: "upload"; docx: JobFile }
  // a draft without yellow: the worker checks name and content agree, then it is Final
  | { mode: "approve" }
  // edited on screen (Willem 19/10, own editor 20/10): the changed pieces of text, written into
  // the draft by the worker; changes not found in the supplier original are a warning;
  // acceptChanges = the person saw the warnings and goes on
  | { mode: "edited"; edits: Edits; acceptChanges?: boolean }
);
/** label jobs: the template (an id from lib/labels, never a path) and the other form values.
 * Product name, file nr and batch sit in the job's own columns, like a neutralise job. */
export type LabelPayload = {
  template: string;
  language: string;
  fields: Record<string, string>;
  /** Kept from the moment the label was made: a sample label stays a sample (security M3). */
  sample: boolean;
};

// One neutralise job = one supplier document (+ commercial documents for a COA), run by the
// worker. A COA with several batches can give several documents (documents.job_id).
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: jobKind("kind").notNull().default("neutralise"),
    state: jobState("state").notNull().default("queued"),
    route: route("route").notNull().default("auto"),
    entity: entityCode("entity").notNull().default("TMC"),
    // Values typed by the user overrule the documents (BRIEF 7.4). Empty = engine reads them.
    productName: text("product_name"),
    fileNr: text("file_nr"),
    batch: text("batch"),
    supplierName: text("supplier_name"), // internal metadata for the library, never passed to the engine
    supplierFile: jsonb("supplier_file").$type<JobFile>(), // neutralise jobs only
    commercialFiles: jsonb("commercial_files").$type<JobFile[]>().notNull().default([]),
    // finalise jobs: the draft being finalised, and what the person decided
    documentId: uuid("document_id").references((): AnyPgColumn => documents.id),
    payload: jsonb("payload").$type<FinalisePayload>(),
    label: jsonb("label").$type<LabelPayload>(),
    // "Run again" (Willem 02/11): the draft this run replaces once it has made its own draft
    rerunOf: uuid("rerun_of").references((): AnyPgColumn => documents.id),
    exitCode: integer("exit_code"),
    log: text("log"),
    // The request from a calling app (API v1) this run belongs to; null for the app's own jobs.
    apiJobId: uuid("api_job_id").references((): AnyPgColumn => apiJobs.id),
    attempts: integer("attempts").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_state_created").on(t.state, t.createdAt),
    index("jobs_created_by").on(t.createdBy, t.createdAt),
    index("jobs_api_job").on(t.apiJobId),
    // API v1.1: one run per supplier file of a request (the handed-over one is used once, review M1).
    uniqueIndex("jobs_one_run_per_api_file")
      .on(t.apiJobId, sql`(${t.supplierFile}->>'key')`)
      .where(sql`${t.apiJobId} IS NOT NULL AND ${t.kind} = 'neutralise'`),
    // One open finalise per document at a time (review L3).
    uniqueIndex("jobs_one_open_finalise")
      .on(t.documentId)
      .where(sql`${t.kind} = 'finalise' and ${t.state} in ('queued', 'running')`),
    // One open "run again" per draft at a time: a double click files one job.
    uniqueIndex("jobs_one_open_rerun")
      .on(t.rerunOf)
      .where(sql`${t.rerunOf} is not null and ${t.state} in ('queued', 'running')`),
    // ::text: the enum value is new in the same migration
    check("jobs_label_has_payload", sql`${t.kind}::text <> 'label' OR ${t.label} IS NOT NULL`),
  ],
);

/** One BC order line as a calling app sends it (API v1, contract section 6): BC facts only. */
export type ApiLine = { lineNo: number; itemNo: string | null; description: string | null };
/** A supplier document handed over through the API (v1.1). `filename` is internal, for display only. */
export type ApiSupplierFile = JobFile & { sha256: string; size: number; contentType: string };

// Apps that may call the API (API v1, contract section 3). Only the SHA-256 of a key is kept;
// the key itself is shown once to the admin who makes it. Two active keys per client (rotation).
export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    client: text("client").notNull(),
    keyHash: text("key_hash").notNull(),
    /** The last 4 characters, so an admin can tell two keys apart. */
    keyHint: text("key_hint").notNull(),
    allowedKinds: apiJobKind("allowed_kinds").array().notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    deactivatedBy: text("deactivated_by"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_clients_key_hash").on(t.keyHash),
    index("api_clients_client").on(t.client),
    check("api_clients_client_name", sql`${t.client} ~ '^[a-z0-9]{2,16}$'`),
  ],
);

// A request from a calling app (API v1): one part (order no + part no) and one kind. A person in
// the app adds the supplier document(s) or makes the label; those runs point here (jobs.api_job_id).
// The state is worked out from those runs and their documents (lib/api/requests.ts), never stored.
export const apiJobs = pgTable(
  "api_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    client: text("client").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    /** SHA-256 of the request body (canonical JSON): same key with another body is refused. */
    bodyHash: text("body_hash").notNull(),
    kind: apiJobKind("kind").notNull(),
    entity: entityCode("entity").notNull(),
    requestId: uuid("request_id").notNull(),
    orderNo: text("order_no").notNull(),
    partNo: integer("part_no").notNull(),
    requestedBy: text("requested_by").notNull(),
    reason: text("reason").notNull(),
    lines: jsonb("lines").$type<ApiLine[]>().notNull(),
    // v1.1 (contract 15.2): the BC vendor name sent with the job. Internal, like a typed one: block
    // list for the output check and the AI reader, never printed, never in an API answer.
    supplierName: text("supplier_name"),
    // v1.1 (contract 15.1): the one supplier document handed over through the API, kept here until
    // the engine can start (a supplier name is known), and the hand-off's own Idempotency-Key.
    supplierFile: jsonb("supplier_file").$type<ApiSupplierFile>(),
    supplierFileKey: uuid("supplier_file_key"),
    createdBy: text("created_by").notNull(), // "<client>:<requestedBy>"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("api_jobs_client_idempotency").on(t.client, t.idempotencyKey),
    index("api_jobs_client_created").on(t.client, t.createdAt),
    index("api_jobs_created").on(t.createdAt),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(), // always stored lower-case
  name: text("name").notNull(),
  role: role("role").notNull().default("user"),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // File name without extension (BRIEF 7.5). Same name = same document, new version.
    name: text("name").notNull(),
    type: docType("type").notNull(),
    entity: entityCode("entity").notNull().default("TMC"),
    // Empty on an engine draft until a person confirms it at the check (never guessed).
    productName: text("product_name"),
    inciName: text("inci_name"),
    casNumber: text("cas_number"),
    batch: text("batch"),
    fileNr: text("file_nr"),
    poNumber: text("po_number"),
    language: text("language").notNull().default("EN"),
    manufacturingDate: date("manufacturing_date"),
    expiryOrRetestDate: date("expiry_or_retest_date"),
    supplierName: text("supplier_name"), // internal: never printed on any output
    status: docStatus("status").notNull(),
    // Set when the document becomes Final (1, 2, 3 ...). Drafts and rejected drafts have none.
    version: integer("version"),
    previousVersionId: uuid("previous_version_id").references((): AnyPgColumn => documents.id),
    // A draft from the engine has Word only; the PDF comes at finalisation (BRIEF 7.2).
    pdfKey: text("pdf_key"),
    pdfFilename: text("pdf_filename"),
    docxKey: text("docx_key"),
    docxFilename: text("docx_filename"),
    sourceKey: text("source_key"),
    sourceFilename: text("source_filename"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    jobId: uuid("job_id").references((): AnyPgColumn => jobs.id),
    rejectedReason: text("rejected_reason"),
    // Engine drafts: the yellow parts to check, and a preview PDF stamped DRAFT (view only).
    yellowParts: jsonb("yellow_parts").$type<YellowPart[]>(),
    previewKey: text("preview_key"),
    // The on-screen editor's view of the draft (web/worker/yellow.py view), made with the draft.
    viewKey: text("view_key"),
  },
  (t) => [
    // Never two Final versions of the same document. Drafts may sit next to the Final one.
    uniqueIndex("documents_one_final_per_name").on(t.name).where(sql`${t.status} = 'Final'`),
    uniqueIndex("documents_name_version").on(t.name, t.version).where(sql`${t.version} is not null`),
    // An uploaded file belongs to one document only.
    uniqueIndex("documents_pdf_key").on(t.pdfKey),
    uniqueIndex("documents_docx_key").on(t.docxKey),
    uniqueIndex("documents_source_key").on(t.sourceKey),
    uniqueIndex("documents_preview_key").on(t.previewKey),
    uniqueIndex("documents_view_key").on(t.viewKey),
    index("documents_created_at").on(t.createdAt),
    // A Final document always has its PDF, a version number and a product name (BRIEF 7.2, 7.6).
    check(
      "documents_final_complete",
      sql`${t.status} <> 'Final' OR (${t.version} IS NOT NULL AND ${t.pdfKey} IS NOT NULL AND ${t.productName} IS NOT NULL)`,
    ),
  ],
);

// Append-only: a database trigger (migration 0001) refuses UPDATE, DELETE and TRUNCATE for
// normal queries. The database owner could still disable the trigger; before real data the
// app should connect with a role that may only INSERT/SELECT here (security finding S2).
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    documentId: uuid("document_id").references(() => documents.id),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_log_document").on(t.documentId, t.at)],
);

// What people corrected or decided at the check: the feedback overview for the admin, to
// improve the engine's reading rules. Never used to change a document automatically.
export const FEEDBACK_KINDS = ["corrected", "confirmed", "rejected", "word_upload", "edited"] as const;
export const feedbackKind = pgEnum("feedback_kind", FEEDBACK_KINDS);
export const feedback = pgTable(
  "feedback",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    documentId: uuid("document_id").references(() => documents.id),
    kind: feedbackKind("kind").notNull(),
    partId: text("part_id"),
    before: text("before"),
    after: text("after"),
    context: text("context"),
    reason: text("reason"),
  },
  (t) => [index("feedback_at").on(t.at)],
);

export type Document = typeof documents.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type User = typeof users.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type EntityRecord = typeof entities.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
export type ApiJob = typeof apiJobs.$inferSelect;
