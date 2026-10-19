CREATE TYPE "public"."feedback_kind" AS ENUM('corrected', 'confirmed', 'rejected', 'word_upload');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"document_id" uuid,
	"kind" "feedback_kind" NOT NULL,
	"part_id" text,
	"before" text,
	"after" text,
	"context" text,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "yellow_parts" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "preview_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_at" ON "feedback" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_preview_key" ON "documents" USING btree ("preview_key");