CREATE TYPE "public"."job_kind" AS ENUM('neutralise', 'finalise');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'to_check', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."route" AS ENUM('auto', 'coa', 'sds', 'tds');--> statement-breakpoint
ALTER TYPE "public"."doc_status" ADD VALUE 'Rejected';--> statement-breakpoint
CREATE TABLE "entities" (
	"code" "entity_code" PRIMARY KEY NOT NULL,
	"naam" text NOT NULL,
	"adres" text NOT NULL,
	"telefoon" text NOT NULL,
	"email" text NOT NULL,
	"web" text NOT NULL,
	"btw" text NOT NULL,
	"nood" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" DEFAULT 'neutralise' NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"route" "route" DEFAULT 'auto' NOT NULL,
	"entity" "entity_code" DEFAULT 'TMC' NOT NULL,
	"product_name" text,
	"file_nr" text,
	"batch" text,
	"supplier_name" text,
	"supplier_file" jsonb NOT NULL,
	"commercial_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_id" uuid,
	"exit_code" integer,
	"log" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "documents_one_current_per_name";--> statement-breakpoint
DROP INDEX "documents_name_version";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "pdf_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "pdf_filename" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "rejected_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_state_created" ON "jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "jobs_created_by" ON "jobs" USING btree ("created_by","created_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_one_final_per_name" ON "documents" USING btree ("name") WHERE "documents"."status" = 'Final';--> statement-breakpoint
CREATE UNIQUE INDEX "documents_name_version" ON "documents" USING btree ("name","version") WHERE "documents"."version" is not null;--> statement-breakpoint
-- TMC NV as in engine/entity.example.json (the engine's default). Other entities: entered by an admin.
INSERT INTO "entities" ("code", "naam", "adres", "telefoon", "email", "web", "btw", "nood", "updated_by")
VALUES ('TMC', 'Transmare Chemie NV', 'Italiëlei 124 / bus 59, Theater building (15th floor), B2000, Antwerpen, Belgium',
        '+32 3 21398 40', 'trans@transmare.com', 'www.transmare.com', 'BE 0435 913 050', '+32 (0)14 58 45 45',
        'seed: engine/entity.example.json')
ON CONFLICT ("code") DO NOTHING;
