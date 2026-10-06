# Abstention threshold — contracts_eval

Config hybrid+rerank, best similarity among the top 5 chunks, corpus-wide. Ranges: answerable 0.534–0.741 (50), out of corpus 0.344–0.441 (4), absent clause 0.516–0.645 (6).

**QUERY_MIN_SIMILARITY = 0.485** — abstains before the model on 100 % of the out-of-corpus questions and wrongly on 0 % of the answerable ones (J = 1.00); it stops 0 % of the absent-clause questions, which are left to the model.

Calibrated on every unanswerable question instead, it would be 0.645: 100 % of them stopped, 46 % of the answerable ones wrongly (J = 0.54).

With this few unanswerable questions every percentage step is one question; treat the value as a calibration of this corpus, not a constant.
