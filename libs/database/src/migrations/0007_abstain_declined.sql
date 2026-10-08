-- A fourth abstention reason, decided after the model: it replied with the
-- system prompt's abstention sentence and went on to cite an excerpt for a
-- side remark, which the citation check alone counted as an answer. ADD VALUE
-- appends to the type; rows already written keep the reasons they have.
ALTER TYPE "public"."abstain_reason" ADD VALUE 'declined';