# NestJS metrics (§9.5)

Code lines (cloc 1.98, TypeScript, specs excluded).

## Per service and library

| area | files | code | comment |
|---|---|---|---|
| apps/api-gateway | 22 | 974 | 158 |
| apps/auth-service | 9 | 468 | 120 |
| apps/indexing-service | 8 | 446 | 115 |
| apps/ingestion-service | 16 | 1228 | 186 |
| apps/llm-service | 19 | 1766 | 492 |
| apps/retrieval-service | 11 | 739 | 172 |
| libs/common | 21 | 967 | 226 |
| libs/config | 19 | 550 | 252 |
| libs/database | 11 | 326 | 91 |
| libs/embeddings | 5 | 322 | 76 |
| libs/messaging | 7 | 206 | 50 |
| libs/rpc | 9 | 469 | 146 |
| libs/telemetry | 7 | 315 | 139 |
| monolith | 4 | 77 | 33 |
| bench/express-auth | 7 | 431 | 17 |

## Auth flow: Nest as built vs the Express twin

| role | Nest code | Express code |
|---|---|---|
| wiring | 142 | 58 |
| http | 544 | 230 |
| domain | 318 | 143 |
| **total** | **1004** | **431** |

Of the Nest lines, 40 open an OpenAPI decorator (`@Api…`) — documentation the twin does not have.

## Changing the transport

The in-process transport (`libs/rpc/src/in-process.ts`): 102 code lines; the RabbitMQ client and server: 64.

### inProcess: f45d138 feat(monolith): compose the six services in one process over the in-process transport

| area | files | added | removed |
|---|---|---|---|
| build and boundary config | 4 | 58 | 4 |
| other libs | 1 | 18 | 1 |
| monolith composition | 5 | 146 | 0 |

### rmq: 8e548a6 feat(rpc): carry request/response over RabbitMQ behind RPC_TRANSPORT

| area | files | added | removed |
|---|---|---|---|
| deployment | 1 | 3 | 0 |
| service wiring | 9 | 18 | 24 |
| other libs | 2 | 58 | 0 |
| libs/rpc | 5 | 148 | 16 |

## Tests and the DI container

46 spec files: 1 build a Nest testing module, 0 override a provider/guard, 0 supply a provider by value.

```json
{
  "total": {
    "statements": 80.33,
    "branches": 72.39
  },
  "byArea": {
    "apps/api-gateway": {
      "statements": 76.9,
      "branches": 59.3
    },
    "apps/auth-service": {
      "statements": 75.5,
      "branches": 84.4
    },
    "apps/indexing-service": {
      "statements": 88,
      "branches": 83.8
    },
    "apps/ingestion-service": {
      "statements": 91.6,
      "branches": 89.5
    },
    "apps/llm-service": {
      "statements": 92.9,
      "branches": 82
    },
    "apps/retrieval-service": {
      "statements": 85.4,
      "branches": 77.3
    },
    "libs/common": {
      "statements": 83,
      "branches": 33.3
    },
    "libs/config": {
      "statements": 35.6,
      "branches": 62.5
    },
    "libs/database": {
      "statements": 69.6,
      "branches": 33.3
    },
    "libs/embeddings": {
      "statements": 96.6,
      "branches": 90.7
    },
    "libs/messaging": {
      "statements": 89.1,
      "branches": 77.8
    },
    "libs/rpc": {
      "statements": 9.5,
      "branches": 0
    },
    "libs/telemetry": {
      "statements": 62.2,
      "branches": 20
    }
  }
}
```
