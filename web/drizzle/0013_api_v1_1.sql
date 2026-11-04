-- API v1.1 (contract section 15): the supplier name sent with a request, the one supplier document
-- handed over through the API (kept until the engine can start) with its hand-off key, and one run
-- per supplier file of a request.
ALTER TABLE "api_jobs" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "api_jobs" ADD COLUMN "supplier_file" jsonb;--> statement-breakpoint
ALTER TABLE "api_jobs" ADD COLUMN "supplier_file_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_run_per_api_file" ON "jobs" USING btree ("api_job_id",("supplier_file"->>'key')) WHERE "jobs"."api_job_id" IS NOT NULL AND "jobs"."kind" = 'neutralise';