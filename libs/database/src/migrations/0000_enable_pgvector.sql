-- Drizzle does not create extensions itself, and the `vector` type has to exist
-- before any DDL that uses it. Hence a separate first migration rather than a
-- line appended to a generated file — this survives every future
-- `drizzle-kit generate`.
CREATE EXTENSION IF NOT EXISTS vector;
