CREATE UNIQUE INDEX "documents_pdf_key" ON "documents" USING btree ("pdf_key");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_docx_key" ON "documents" USING btree ("docx_key");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_source_key" ON "documents" USING btree ("source_key");