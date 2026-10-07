# Operational readiness and trustworthy measurement

Run `npm run check:runtime` before a live evaluation. It writes `output/runtime-check.json` and exits nonzero if the database,
required migrations, core services, or running code/settings versions fail. Warnings produce `degraded`, not a false clean bill
of health. The command reads provider/model availability and budgets; it does not generate model answers, send notifications,
reset quotas, apply migrations, or restart services.

`/health/live` answers whether the API process is alive. `/health/ready` checks that it can read the database and that every
required migration is applied (including optional vector migrations when semantic search is enabled). It returns safe failure
codes and the startup code/settings fingerprints. Worker, provider, privileges, budget and queue checks remain in the operational
preflight/admin watchdog report; API readiness alone does not promise that all search modalities work.

API, worker and watchdog heartbeats carry a snapshot of their startup code/settings version. New search traces and cost events
carry that identity and a trace ID. Settings fingerprints exclude credentials and connection strings. Restart the processes after
changing code/settings; hashing files for a report does not relabel an old process as current.

## Measurement rules

- Version 2 discovery metrics distinguish the main list, closest matches and hidden candidates. Requirement satisfaction comes
  from recorded requirement states, including unknown exclusions; a high model score is not verification or accuracy.
- Costs in the answer, field and SSJ3 suites are matched by trace ID. Missing prices or unavailable attribution yield `null`,
  with reported partial cost and unpriced-call counts retained. These are model usage measurements, not a total infrastructure bill.
- HTTP failures and exhausted evaluation polling are errors, not completed searches. Answer errors remain in the task denominator.
- Answer accuracy is `null` until all returned claims have grades. Field top-five/top-ten scores remain `null` if their returned
  results lack grades. Missing slots still score zero. Field paired comparisons report only common successful queries, so inspect
  each run's failure count as well; that comparison alone is not an end-to-end success rate.
- Historical files retain their original measurements. Do not combine older cost/metric definitions with version 2 results.
- The scripts measure completed reviews/answers, not time to first useful result. Discovery traces are initial snapshots;
  inspect final scene-verification revisions separately. A small smoke check is not a held-out accuracy benchmark.

## Small checks after a work item

For example, in PowerShell:

```powershell
$env:ANSWER_EVAL_DIR='output/order1-evaluation'
$env:ANSWER_EVAL_IDS='exp-solar,fact-constitution,skip-match'
node --import tsx scripts/answer-eval.ts run measurement-check
node --import tsx scripts/answer-eval.ts label
node --import tsx scripts/answer-eval.ts score
```

Record task completion, each claim's actual support, relevant constraints and measured time. Identify assistant-reviewed smoke
checks as such; do not save them as independent human grades. Broad accuracy still needs a separately reviewed held-out set.
