ALTER TYPE "public"."job_kind" ADD VALUE 'label';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "label" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_label_has_payload" CHECK ("jobs"."kind"::text <> 'label' OR "jobs"."label" IS NOT NULL);