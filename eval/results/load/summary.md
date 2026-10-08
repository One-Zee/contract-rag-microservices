# Load tests

Medians over the repetitions (column `n`). App CPU is the sum of the measured containers' mean CPU % (100 % = one core) and app MiB the sum of their peaks — the target alone for the Express twin and the 1-CPU monolith, every application container otherwise. Stubbed providers, tracing off, throttling off.

## overhead-health

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| express-1cpu | 50 | 1 | 17328.7 | 2 | 5 | 9 | 0.00 | 89 | 101 | 1 |
| monolith-1cpu | 50 | 1 | 13605.7 | 3 | 6 | 13 | 0.00 | 89 | 165 | 17 |
| services | 50 | 1 | 5002.0 | 4 | 57 | 84 | 0.00 | 56 | 616 | 2 |

## overhead-login

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| express-1cpu | 10 | 1 | 2.9 | 3193 | 4909 | 11870 | 0.00 | 93 | 112 | 2 |
| monolith-1cpu | 10 | 1 | 2.9 | 3705 | 4769 | 5406 | 0.00 | 90 | 191 | 4 |
| services | 10 | 1 | 1.4 | 7799 | 10180 | 13340 | 0.00 | 59 | 641 | 3 |

## overhead-me

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| express-1cpu | 50 | 1 | 5634.6 | 7 | 14 | 41 | 0.00 | 92 | 91 | 1 |
| monolith-1cpu | 50 | 1 | 4756.3 | 8 | 15 | 63 | 0.00 | 89 | 169 | 1 |
| services | 50 | 1 | 1906.0 | 10 | 77 | 176 | 0.00 | 54 | 634 | 1 |

## overhead-user

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| express-1cpu | 50 | 1 | 1797.1 | 19 | 66 | 90 | 0.00 | 92 | 93 | 18 |
| monolith-1cpu | 50 | 1 | 1193.0 | 28 | 111 | 157 | 0.00 | 88 | 200 | 11 |
| rmq | 50 | 1 | 619.8 | 73 | 196 | 413 | 0.00 | 80 | 765 | 8 |
| services | 50 | 1 | 1003.5 | 23 | 126 | 200 | 0.00 | 87 | 630 | 12 |

## query

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| monolith | 10 | 1 | 4.0 | 2576 | 2752 | 2859 | 0.00 | 20 | 294 | 9 |
| rmq | 10 | 1 | 3.7 | 2679 | 3109 | 3700 | 0.00 | 54 | 694 | 13 |
| services | 10 | 1 | 3.7 | 2672 | 3093 | 3221 | 0.00 | 36 | 691 | 8 |
| monolith | 50 | 1 | 20.0 | 2546 | 2712 | 3370 | 0.00 | 44 | 313 | 11 |
| rmq | 50 | 1 | 16.7 | 2951 | 4156 | 4336 | 0.00 | 75 | 710 | 14 |
| services | 50 | 1 | 18.4 | 2597 | 3790 | 4116 | 0.00 | 82 | 710 | 17 |
| monolith | 100 | 1 | 39.5 | 2577 | 2808 | 3044 | 0.00 | 66 | 305 | 18 |
| rmq | 100 | 1 | 22.8 | 4525 | 6360 | 6999 | 0.00 | 88 | 733 | 18 |
| services | 100 | 1 | 27.9 | 3473 | 5594 | 5754 | 0.00 | 78 | 732 | 17 |

## search

| topology | VUs | n | req/s | p50 ms | p95 ms | p99 ms | failed % | app CPU % | app MiB | postgres CPU % |
|---|---|---|---|---|---|---|---|---|---|---|
| monolith | 10 | 1 | 25.3 | 392 | 427 | 547 | 0.00 | 22 | 305 | 16 |
| rmq | 10 | 1 | 22.8 | 398 | 670 | 1133 | 0.00 | 47 | 650 | 15 |
| services | 10 | 1 | 23.0 | 398 | 654 | 896 | 0.00 | 41 | 663 | 14 |
| monolith | 50 | 1 | 129.3 | 377 | 431 | 511 | 0.00 | 53 | 280 | 39 |
| rmq | 50 | 1 | 73.8 | 603 | 1246 | 1619 | 0.00 | 74 | 656 | 26 |
| services | 50 | 1 | 84.3 | 530 | 1007 | 1265 | 0.00 | 67 | 651 | 32 |
| monolith | 100 | 1 | 251.6 | 383 | 462 | 551 | 0.00 | 77 | 305 | 70 |
| rmq | 100 | 1 | 98.3 | 912 | 1833 | 2414 | 0.00 | 83 | 711 | 31 |
| services | 100 | 1 | 106.2 | 859 | 1526 | 1918 | 0.00 | 73 | 650 | 37 |

## burst — monolith

40 contracts uploaded at once, 40 indexed; the last one 31.0 s after the burst (median 20.3 s). Search load 20 VUs throughout.

| phase | searches | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| before | 2969 | 385 | 449 | 667 |
| during | 1286 | 394 | 936 | 1760 |
| after | 7627 | 386 | 433 | 499 |

## burst — services

40 contracts uploaded at once, 40 indexed; the last one 35.2 s after the burst (median 27.9 s). Search load 20 VUs throughout.

| phase | searches | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| before | 2677 | 391 | 649 | 1186 |
| during | 1488 | 429 | 752 | 880 |
| after | 6361 | 411 | 705 | 898 |

