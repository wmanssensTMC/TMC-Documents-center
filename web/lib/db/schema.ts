// Database tables (BRIEF section 6). Phase 1: documents, users, audit log.
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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

import { DOC_TYPES, ENTITIES, ROLES, STATUSES } from "../constants";

export { DOC_TYPES, ENTITIES, ROLES, STATUSES };
export type { DocStatus, DocType, Entity } from "../constants";

export const docType = pgEnum("doc_type", DOC_TYPES);
export const entityCode = pgEnum("entity_code", ENTITIES);
export const docStatus = pgEnum("doc_status", STATUSES);
export const role = pgEnum("role", ROLES);

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
    productName: text("product_name").notNull(),
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
    version: integer("version").notNull().default(1),
    previousVersionId: uuid("previous_version_id").references((): AnyPgColumn => documents.id),
    pdfKey: text("pdf_key").notNull(),
    pdfFilename: text("pdf_filename").notNull(),
    docxKey: text("docx_key"),
    docxFilename: text("docx_filename"),
    sourceKey: text("source_key"),
    sourceFilename: text("source_filename"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [
    // Never two current versions of the same document.
    uniqueIndex("documents_one_current_per_name").on(t.name).where(sql`${t.status} <> 'Superseded'`),
    uniqueIndex("documents_name_version").on(t.name, t.version),
    index("documents_created_at").on(t.createdAt),
  ],
);

// Append-only: a database trigger (migration 0001) refuses UPDATE, DELETE and TRUNCATE.
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

export type Document = typeof documents.$inferSelect;
export type User = typeof users.$inferSelect;
