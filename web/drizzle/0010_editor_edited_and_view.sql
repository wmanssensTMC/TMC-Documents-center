-- Safe to run on a database where the editor branch (old 0009/0010) was already applied.
ALTER TYPE "public"."feedback_kind" ADD VALUE IF NOT EXISTS 'edited';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "view_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_view_key" ON "documents" USING btree ("view_key");