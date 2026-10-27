-- API v1 (contract docs/API.md): calling apps with hashed keys, their requests, and the link
-- from an engine run to its request. Requests are kept as long as the app: never deleted.
CREATE TYPE "public"."api_job_kind" AS ENUM('coa-neutralise', 'sds-neutralise', 'tds-neutralise', 'label');--> statement-breakpoint
ALTER TYPE "public"."job_state" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_hint" text NOT NULL,
	"allowed_kinds" "api_job_kind"[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"deactivated_by" text,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "api_clients_client_name" CHECK ("api_clients"."client" ~ '^[a-z0-9]{2,16}$')
);
--> statement-breakpoint
CREATE TABLE "api_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"body_hash" text NOT NULL,
	"kind" "api_job_kind" NOT NULL,
	"entity" "entity_code" NOT NULL,
	"request_id" uuid NOT NULL,
	"order_no" text NOT NULL,
	"part_no" integer NOT NULL,
	"requested_by" text NOT NULL,
	"reason" text NOT NULL,
	"lines" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "api_job_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_key_hash" ON "api_clients" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_clients_client" ON "api_clients" USING btree ("client");--> statement-breakpoint
CREATE UNIQUE INDEX "api_jobs_client_idempotency" ON "api_jobs" USING btree ("client","idempotency_key");--> statement-breakpoint
CREATE INDEX "api_jobs_client_created" ON "api_jobs" USING btree ("client","created_at");--> statement-breakpoint
CREATE INDEX "api_jobs_created" ON "api_jobs" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_api_job_id_api_jobs_id_fk" FOREIGN KEY ("api_job_id") REFERENCES "public"."api_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_api_job" ON "jobs" USING btree ("api_job_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION api_jobs_kept() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'api_jobs rows are never deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER api_jobs_no_delete
  BEFORE DELETE ON api_jobs
  FOR EACH ROW EXECUTE FUNCTION api_jobs_kept();
--> statement-breakpoint
CREATE TRIGGER api_jobs_no_truncate
  BEFORE TRUNCATE ON api_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION api_jobs_kept();
