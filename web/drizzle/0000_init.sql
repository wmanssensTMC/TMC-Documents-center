CREATE TYPE "public"."doc_status" AS ENUM('Draft', 'To check', 'Final', 'Superseded');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('COA', 'MSDS', 'TDS', 'SPEC', 'LABEL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."entity_code" AS ENUM('TMC', 'TMCGULF', 'PHARMALABO');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'approver', 'user');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"document_id" uuid,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "doc_type" NOT NULL,
	"entity" "entity_code" DEFAULT 'TMC' NOT NULL,
	"product_name" text NOT NULL,
	"inci_name" text,
	"cas_number" text,
	"batch" text,
	"file_nr" text,
	"po_number" text,
	"language" text DEFAULT 'EN' NOT NULL,
	"manufacturing_date" date,
	"expiry_or_retest_date" date,
	"supplier_name" text,
	"status" "doc_status" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"previous_version_id" uuid,
	"pdf_key" text NOT NULL,
	"pdf_filename" text NOT NULL,
	"docx_key" text,
	"docx_filename" text,
	"source_key" text,
	"source_filename" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" DEFAULT 'user' NOT NULL,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_previous_version_id_documents_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_document" ON "audit_log" USING btree ("document_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_one_current_per_name" ON "documents" USING btree ("name") WHERE "documents"."status" <> 'Superseded';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_name_version" ON "documents" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "documents_created_at" ON "documents" USING btree ("created_at");