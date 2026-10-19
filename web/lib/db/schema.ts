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

import { DOC_TYPES, ENTITIES, JOB_KINDS, JOB_STATES, ROLES, ROUTES, STATUSES } from "../constants";

export { DOC_TYPES, ENTITIES, JOB_KINDS, JOB_STATES, ROLES, ROUTES, STATUSES };
export type { DocStatus, DocType, Entity, JobState, Route } from "../constants";

export const docType = pgEnum("doc_type", DOC_TYPES);
export const entityCode = pgEnum("entity_code", ENTITIES);
export const docStatus = pgEnum("doc_status", STATUSES);
export const role = pgEnum("role", ROLES);
export const jobState = pgEnum("job_state", JOB_STATES);
export const jobKind = pgEnum("job_kind", JOB_KINDS);
export const route = pgEnum("route", ROUTES);

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
export type FinalisePayload = { metadata: DocMetadata } & (
  | { mode: "editor"; fixes: Record<string, { value: string; confirmed: true }> }
  | { mode: "upload"; docx: JobFile }
  // a draft without yellow: the worker checks name and content agree, then it is Final
  | { mode: "approve" }
);

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
    exitCode: integer("exit_code"),
    log: text("log"),
    attempts: integer("attempts").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_state_created").on(t.state, t.createdAt),
    index("jobs_created_by").on(t.createdBy, t.createdAt),
    // One open finalise per document at a time (review L3).
    uniqueIndex("jobs_one_open_finalise")
      .on(t.documentId)
      .where(sql`${t.kind} = 'finalise' and ${t.state} in ('queued', 'running')`),
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
export const FEEDBACK_KINDS = ["corrected", "confirmed", "rejected", "word_upload"] as const;
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
