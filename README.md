# contract-rag-microservices

Sistem za analizu ugovora zasnovan na RAG pristupu (*Retrieval-Augmented Generation*), izgrađen kao šest mikroservisa u NestJS okviru.

Repozitorij je praktični dio diplomskog rada **„Implementacija mikroservisne arhitekture primjenom NestJS okvira na primjeru sistema za analizu ugovora zasnovanog na RAG pristupu“** (Visoka poslovno tehnička škola Doboj, studijski program Računarstvo i informatika, mentor prof. dr Kristijan Kuk).

## Šta sistem radi

- prima ugovore u formatima PDF i DOCX, izdvaja tekst i dijeli ga na segmente po granicama klauzula;
- za svaki segment računa vektorsku reprezentaciju i upisuje je u PostgreSQL s ekstenzijom pgvector;
- pretražuje segmente hibridno – vektorski i pretragom punog teksta – i spaja rezultate fuzijom rangova (RRF), uz opciono rerangiranje;
- odgovara na pitanja prirodnim jezikom: odgovor se isporučuje postepeno (*Server-Sent Events*) i sadrži citate segmenata na kojima se zasniva, a kada izvora nema, sistem se uzdržava od odgovora;
- razlikuje uloge `admin`, `analyst` i `reader` i vidljivost dokumenata (privatan, podijeljen).

## Arhitektura

```
klijent ──HTTP/SSE──▶ api-gateway ──TCP──▶ auth-service
                                  ├──TCP──▶ ingestion-service ──RabbitMQ (document.chunked)──▶ indexing-service
                                  ├──TCP──▶ retrieval-service
                                  └──TCP──▶ llm-service ──TCP──▶ retrieval-service

PostgreSQL 16 + pgvector · MinIO · RabbitMQ · OpenTelemetry (Jaeger, Prometheus, Grafana)
```

| Servis | Odgovornost |
|---|---|
| `api-gateway` | jedini HTTP servis: validacija, provjera tokena, ograničavanje broja zahtjeva, SSE prema klijentu |
| `auth-service` | registracija, prijava, izdavanje (RS256) i rotacija tokena |
| `ingestion-service` | prijem dokumenta, pohrana u MinIO, ekstrakcija teksta, segmentacija |
| `indexing-service` | vektorske reprezentacije segmenata, potrošač RabbitMQ događaja |
| `retrieval-service` | vektorska i leksička pretraga, RRF, rerangiranje |
| `llm-service` | prompt, poziv jezičkog modela, strujanje odgovora, provjera citata, evidencija upita |

Dijeljeni kod je u `libs/` (`common`, `config`, `database`, `embeddings`, `messaging`, `rpc`, `telemetry`), a `monolith/` sastavlja iste module u jedan proces, za poređenje arhitektura. Granice modula provjerava dependency-cruiser (`npm run dep:check`); graf zavisnosti je u [`docs/architecture/deps.svg`](docs/architecture/deps.svg).

**Tehnologije:** NestJS 12, Node.js 24, TypeScript, Drizzle ORM, PostgreSQL 16 + pgvector, RabbitMQ, MinIO, Docker Compose, OpenTelemetry. Modeli: voyage-law-2 (vektorske reprezentacije), Cohere Rerank (opciono), Anthropic Claude ili lokalni Ollama (odgovori).

## Pokretanje

Preduslovi: Node.js 24 i Docker s Compose v2.

```bash
npm ci
cp .env.example .env
```

U `.env` upisati par ključeva za JWT (RS256), svaki kao jedan base64 red:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.key
openssl pkey -in jwt.key -pubout -out jwt.pub
base64 -w0 jwt.key; echo     # → JWT_PRIVATE_KEY
base64 -w0 jwt.pub; echo     # → JWT_PUBLIC_KEY
```

Bez plaćenih API ključeva sistem radi s lokalnim modelom (`LLM_PROVIDER=ollama`, potreban je pokrenut Ollama s modelom `llama3.1:8b`), bez rerangiranja (`RERANK_PROVIDER=none`) i, samo za razvoj, sa zamjenskim providerom vektorskih reprezentacija (`EMBEDDING_PROVIDER=fake`). Za stvarne vektorske reprezentacije potreban je `VOYAGE_API_KEY`.

**Sve u kontejnerima** (gradi sliku, podiže infrastrukturu, praćenje i servise; migracije se izvršavaju automatski):

```bash
npm run stack:up        # mikroservisi
npm run monolith:up     # ista slika, monolitna topologija
npm run stack:down
```

**Razvoj** (servisi lokalno, infrastruktura u kontejnerima):

```bash
npm run infra:up
npm run db:migrate
npm run start:all
```

### Lokalne adrese

| Šta | Adresa |
|---|---|
| API i Swagger dokumentacija | http://localhost:3000/api/docs |
| RabbitMQ Management | http://localhost:15672 |
| Jaeger (tragovi) | http://localhost:16686 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3030 |
| MinIO konzola | http://localhost:9001 |
| cAdvisor | http://localhost:8080 |

## Testovi

```bash
npm test               # jedinični testovi (Vitest)
npm run test:e2e       # testovi s kraja na kraj, uz pokrenut `npm run infra:up`
npm run lint
npm run dep:check      # granice modula
```

## Evaluacija

Skripte za evaluaciju kvaliteta pretrage i odgovora, mjerenja opterećenja i mjerenja NestJS okvira opisane su u [`eval/README.md`](eval/README.md). Korpus CUAD v1 (The Atticus Project, CC BY 4.0) preuzima se skriptom `npm run eval:fetch` i nije dio repozitorija.

## Postavljanje na server

Produkcijska konfiguracija (jedan server, Caddy, automatska isporuka iz CI-ja) opisana je u [`deploy/README.md`](deploy/README.md).

## Licenca

[MIT](LICENSE) © 2026 Harun Ibrahimović
