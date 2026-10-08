-- The lexical half of the hybrid search. `simple` indexes raw tokens, so a
-- search for "terminating" misses a clause that says "termination" — which is
-- most of them, in English contract text. `english` stems both to `termin` and
-- drops stopwords. The query side must use the same configuration
-- (`plainto_tsquery('english', …)`): a mismatch returns nothing, silently.
--
-- The column is GENERATED, so dropping and re-adding it recomputes every row
-- from `content`; embeddings are untouched. Dropping the column drops its
-- index with it, hence the explicit CREATE afterwards.
ALTER TABLE "chunks" DROP COLUMN "tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");
