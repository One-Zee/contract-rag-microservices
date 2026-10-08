CREATE TYPE "public"."document_visibility" AS ENUM('private', 'shared');--> statement-breakpoint
DROP INDEX "chunks_doc_idx";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "visibility" "document_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_visibility_idx" ON "documents" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_doc_idx" ON "chunks" USING btree ("document_id","chunk_index");