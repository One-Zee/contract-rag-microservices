-- Drizzle ne kreira ekstenzije sam, a tip `vector` mora postojati prije
-- DDL-a koji ga koristi. Zato je ovo zasebna prva migracija, a ne dopisan
-- red na vrh generisanog fajla — preživi svaki budući `drizzle-kit generate`.
CREATE EXTENSION IF NOT EXISTS vector;
