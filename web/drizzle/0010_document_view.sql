ALTER TABLE "documents" ADD COLUMN "view_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_view_key" ON "documents" USING btree ("view_key");