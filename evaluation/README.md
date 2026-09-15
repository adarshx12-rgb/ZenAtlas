# Relevance evaluation

`npm run evaluate` runs the **synthetic development** set in a fresh embedded PostgreSQL database. Records are explicitly fictional, simple, and largely repeat the query language. This checks retrieval mechanics and evidence boundaries; high scores do not demonstrate real-world recall or ranking quality. No synthetic records enter `data/curated.json` or the preview.

Metrics: precision@10 (relevant hits divided by 10, including empty slots), recall@10, reciprocal rank, and nDCG@10 with graded gains. The report includes elapsed search time on this machine. Timing quality is separate and remains unevaluated without verified timestamps.

Before changing `rules-v1`, collect real candidates for the four example intents and additional paraphrases/negations. Ask a human reviewer to fill `held-out.template.json` with canonical URL → grade (0 irrelevant, 1 plausible lead, 2 strong match). Keep that set out of ranking development. A visually specific title can receive a lead grade but cannot count as a verified visual moment. Judge story setup/payoff together, recording transcript windows or actually inspected video ranges. Record moment start/end error and evidence correctness separately.

Do not enable learned global ranking until the held-out judgments, comparison metrics, reviewer, and acceptance criteria are recorded. No automatic model retraining exists in this build. Personal useful/not-useful votes contribute a capped 3% ranking factor only for that browser session. Anonymous votes never affect global ranking.

Rollback: deploy the previous ranking code/version, clear active search snapshots to prevent mixed ranking versions, and keep the same catalogue. Migrations are additive. Disable `SEMANTIC_ENABLED` to return to lexical/moment retrieval.
