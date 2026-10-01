CREATE TYPE "public"."query_status" AS ENUM('answered', 'abstained', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."abstain_reason" AS ENUM('no_context', 'below_threshold', 'no_citations');--> statement-breakpoint
CREATE TABLE "queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question" text NOT NULL,
	"document_ids" uuid[],
	"mode" text NOT NULL,
	"context_chunks" integer DEFAULT 0 NOT NULL,
	"min_similarity" numeric(4, 3),
	"status" "query_status" DEFAULT 'failed' NOT NULL,
	"embedding_ms" integer,
	"retrieval_ms" integer,
	"rerank_ms" integer,
	"llm_ms" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"content" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"estimated_cost" numeric(12, 6) DEFAULT 0 NOT NULL,
	"abstained" boolean DEFAULT false NOT NULL,
	"abstain_reason" "abstain_reason",
	"finish_reason" text,
	"citations_offered" integer DEFAULT 0 NOT NULL,
	"citations_valid" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_query_id_unique" UNIQUE("query_id")
);
--> statement-breakpoint
CREATE TABLE "answer_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"similarity_score" numeric(8, 6)
);
--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_query_id_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_answer_id_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_citations" ADD CONSTRAINT "answer_citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queries_user_created_idx" ON "queries" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "answer_citations_rank_idx" ON "answer_citations" USING btree ("answer_id","rank");