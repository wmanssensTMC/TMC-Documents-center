-- API v1.1 (contract section 15): the supplier name sent with a request and the one supplier
-- document handed over through the API (kept until the engine can start), with its hand-off key.
ALTER TABLE "api_jobs" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "api_jobs" ADD COLUMN "supplier_file" jsonb;--> statement-breakpoint
ALTER TABLE "api_jobs" ADD COLUMN "supplier_file_key" uuid;