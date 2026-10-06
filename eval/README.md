# Evaluation and measurements

Everything behind the numbers of the thesis (plan §9): retrieval quality,
answer quality, load, and the NestJS comparisons. Scripts are TypeScript run
directly by Node 24 (type stripping, no build); k6 and cloc run as pinned
containers, so the same commands work on macOS and on a Linux host.

## Data: CUAD v1

The corpus comes from the Contract Understanding Atticus Dataset — Hendrycks,
Burns, Chen and Ball, *CUAD: An Expert-Annotated NLP Dataset for Legal
Contract Review*, NeurIPS 2021 — published by The Atticus Project under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The archive is
downloaded, never committed:

```bash
npm run eval:fetch        # eval/data/CUAD_v1 (gitignored), sha256-checked
```

`eval/dataset/` holds what is derived from it and committed: the chosen
contracts (`contracts.json`, `load-contracts.json`) and the questions with
their gold spans (`questions.json`).

| Script | What it does |
|---|---|
| `eval:select` | 40 contracts, stratified by type, 5–60 pages, with a text layer; seeded |
| `eval:draft` | questions from CUAD's annotations — a **draft** until reviewed by hand |

`questions.json` carries `"status": "draft"`. Final numbers are only computed
on `"reviewed"`; every scoring script refuses a draft unless `--allow-draft`.

## One database per experiment

A corpus indexed with another embedding model or another chunking strategy
is another corpus, so every experiment gets its own database, named
`contracts_<experiment>`; results go to `eval/results/<database>/`.

```bash
export DATABASE_URL=postgresql://app:dev@localhost:5432/contracts_eval
npm run eval:db           # create + migrate (docker/migrate.mjs)
```

Start the services **from the same shell** against it — the scripts record
the settings they can see, so the services must see the same ones:

```bash
export S3_BUCKET=contracts-eval THROTTLE_ENABLED=false LEXICAL_MATCH=any
export EMBEDDING_PROVIDER=voyage RERANK_PROVIDER=cohere LLM_PROVIDER=anthropic
export LLM_TEMPERATURE=0 LLM_COST_INPUT_PER_MTOK=1 LLM_COST_OUTPUT_PER_MTOK=5
npm run start:all         # keys come from .env
```

Side experiments: `contracts_eval_generic` with `EMBEDDING_MODEL=voyage-3.5`,
`contracts_eval_naive` with `CHUNK_RESPECT_SECTIONS=false`.

A failed rerank is not an error — the service keeps the fusion order and
reports `reranker: "none"` — so requests that rerank are paced under
`RERANK_PER_MINUTE` (default 8, for a trial Cohere key's 10 calls a minute;
`0` with a production key). `eval:retrieval` retries a search that comes back
unreranked and stops after three tries; `eval:answers` cannot see it, so check
the retrieval-service log for `Reranking failed` after a run.

## Retrieval and answers (§9.2, §9.3)

| Script | What it does |
|---|---|
| `eval:corpus` | uploads the contracts through the gateway, waits for `indexed` |
| `eval:label` | CUAD spans → graded chunk labels (word 4-grams; `labels.md` lists misses) |
| `eval:retrieval` | 4 configurations × corpus/document scope → R@1/3/5/10, MRR, nDCG@10 with bootstrap CIs |
| `eval:threshold` | `QUERY_MIN_SIMILARITY` from answerable vs unanswerable questions (Youden's J) |
| `eval:answers` | every question through `POST /query`; `--label` names the run |
| `eval:judge` | LLM judge (`JUDGE_MODEL`, default `claude-sonnet-5`, which takes no `temperature`; `JUDGE_TEMPERATURE` for a model that does) + a 20 % sample CSV |
| `eval:agreement` | after the `author` column of the sample is filled: agreement and Cohen's κ |

## The Express twin (§9.5)

`bench/express-auth` is the auth flow written in plain Express over the same
database, keys and validation rules. `npm run eval:parity` sends one sequence
of requests to the gateway and to the twin and compares statuses and
response shapes.
