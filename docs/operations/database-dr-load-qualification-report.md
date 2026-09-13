# Task 9 — disaster recovery and database load qualification report

**Status:** `PENDING LIVE EVIDENCE`

This report deliberately separates reviewed static configuration from live
qualification. A static `YES` below is not equivalent to an operational `PASS`.
Do not change the overall status to `PASS` until every required live evidence
field is complete.

## Static engineering closeout

| Control | Static status | Evidence |
| --- | --- | --- |
| Cloud SQL scheduled backups configured | YES | Terraform enables scheduled backups. |
| Cloud SQL PITR configured | YES | Terraform enables PITR with 7-day transaction-log retention. |
| Backup retention configured | YES | Terraform retains 8 backups. |
| Source DB private-IP-only | YES | Terraform disables public IPv4 and uses private networking. |
| Source deletion protection configured | YES | Terraform enables instance and settings deletion protection. |
| Persistent Prisma pool explicitly bounded | YES | Shared pool max is 3 connections per runtime. |
| Connection acquisition timeout finite | YES | 3,000 ms for Prisma/pg consumers and migrator client. |
| Idle pool timeout finite | YES | 30,000 ms for persistent Prisma pools. |
| Web scale-out capped | YES | Maximum two Cloud Run web instances. |
| Worker scale capped | YES | One manual worker-pool instance. |
| Reconciliation concurrency capped | YES | One task, parallelism one. |
| Known application connection ceiling calculated | YES | 6 web + 3 worker + 3 reconciliation + 1 migrator = 13. |
| Recent successful live backup verified | PENDING | Requires live Cloud SQL backup history. |
| Live DB `max_connections` verified | PENDING | Requires live database query. |
| Isolated PITR executed | PENDING | Requires controlled disposable restore. |
| RPO measured | PENDING | Requires PITR evidence. |
| RTO measured | PENDING | Requires PITR plus application validation evidence. |
| Low/moderate/spike load qualification | PENDING | Requires live load execution. |
| Worker concurrency qualification | PENDING | Requires live load execution. |
| Retrieval/vector load qualification | PENDING | Requires live load execution. |
| Post-load recovery qualified | PENDING | Requires live load execution. |

## Connection-budget evidence

Configured known application maximum: **13 connections**.

Record live values:

| Measurement | Value |
| --- | --- |
| `max_connections` | PENDING |
| 30% of `max_connections`, rounded up | PENDING |
| Minimum absolute reserve | 10 |
| Required reserve = max(10, 30%) | PENDING |
| Maximum application allowance | PENDING |
| Configured application maximum | 13 |
| Headroom gate | PENDING |
| Baseline total DB connections | PENDING |
| Baseline SkyOS DB connections | PENDING |

Headroom passes only when:

```text
13 <= max_connections - max(10, ceil(max_connections * 0.30))
```

## Backup/PITR evidence

| Evidence | Value |
| --- | --- |
| Source instance | `skyos-np-postgres` |
| Live source state | PENDING |
| Live backup enabled | PENDING |
| Live PITR enabled | PENDING |
| Live transaction-log retention | PENDING |
| Live retained backup count | PENDING |
| Latest successful automated backup ID | PENDING |
| Latest successful backup start/end | PENDING |
| Selected PITR timestamp | PENDING |
| Disposable target instance | PENDING |
| PITR/clone operation ID | PENDING |
| PITR operation result | PENDING |
| Target private connectivity verified | PENDING |
| Target PostgreSQL version verified | PENDING |
| Source instance unchanged after PITR | PENDING |

## Recovered database validation

| Check | Result |
| --- | --- |
| `_prisma_migrations` present and plausible | PENDING |
| `vector` extension available | PENDING |
| `organizations` logical count checked | PENDING |
| `workspaces` logical count checked | PENDING |
| `background_jobs` logical count checked | PENDING |
| `knowledge_chunks` logical count checked | PENDING |
| Repository schema validation | PENDING |
| Repository index validation | PENDING |
| Repository pgvector validation | PENDING |
| Reconciliation report-only | PENDING |

## RPO/RTO evidence

Engineering qualification objectives:

- RPO: **<= 5 minutes**;
- RTO: **<= 30 minutes** through full application validation.

| Measurement | Value |
| --- | --- |
| Recovery command start UTC | PENDING |
| Target infrastructure ready UTC | PENDING |
| Infrastructure-ready duration | PENDING |
| Full validation complete UTC | PENDING |
| Measured RTO | PENDING |
| RTO objective result | PENDING |
| Recovery-point marker used | PENDING |
| Newest recovered state timestamp/marker | PENDING |
| Measured RPO | PENDING / NOT MEASURED |
| RPO objective result | PENDING |

Do not convert `NOT MEASURED` to `PASS`.

## Load qualification evidence

### Baseline

| Measurement | Value |
| --- | --- |
| Observation duration | PENDING |
| Web instances | PENDING |
| DB active/idle/total connections | PENDING |
| Cloud SQL CPU | PENDING |
| Cloud SQL memory | PENDING |
| Cloud SQL disk observation | PENDING |
| Worker queue state | PENDING |

### Scenario 1 — low steady load

| Measurement | Value |
| --- | --- |
| Duration | PENDING |
| Generated request/operation rate | PENDING |
| Successes / failures | PENDING |
| p50 / p95 / p99 | PENDING |
| Peak DB connections | PENDING |
| DB acquisition timeouts | PENDING |
| Cloud SQL peak CPU | PENDING |
| Correctness/tenant gate | PENDING |
| Result | PENDING |

### Scenario 2 — moderate sustained load

| Measurement | Value |
| --- | --- |
| Duration | PENDING |
| Generated request/operation rate | PENDING |
| Successes / failures | PENDING |
| p50 / p95 / p99 | PENDING |
| Peak web instances | PENDING |
| Peak DB connections | PENDING |
| Remaining connection reserve | PENDING |
| Cloud SQL peak/sustained CPU | PENDING |
| Result | PENDING |

### Scenario 3 — bounded spike

| Measurement | Value |
| --- | --- |
| Duration | PENDING |
| Generated request/operation rate | PENDING |
| Successes / failures | PENDING |
| Peak DB connections | PENDING |
| Acquisition timeout behavior | PENDING |
| Reserve preserved | PENDING |
| Time to post-spike baseline | PENDING |
| Result | PENDING |

### Scenario 4 — web plus background worker

| Measurement | Value |
| --- | --- |
| Representative domain flow | PENDING |
| Worker instances | PENDING |
| Job success/retry/lease evidence | PENDING |
| Peak DB connections | PENDING |
| Web errors/latency impact | PENDING |
| Post-run reconciliation | PENDING |
| Result | PENDING |

### Scenario 5 — retrieval/vector pressure

| Measurement | Value |
| --- | --- |
| Test workspace/data set | PENDING (non-sensitive identifier only) |
| Retrieval request rate | PENDING |
| p50 / p95 / p99 | PENDING |
| Vector/retrieval errors | PENDING |
| Peak DB connections | PENDING |
| Tenant-scope/citation correctness | PENDING |
| Result | PENDING |

### Scenario 6 — reconciliation overlap

| Measurement | Value |
| --- | --- |
| Concurrent web load | PENDING |
| Reconciliation exit/result | PENDING |
| Peak DB connections | PENDING |
| Remaining reserve | PENDING |
| Connection count after job exit | PENDING |
| Result | PENDING |

## Post-load recovery

| Check | Result |
| --- | --- |
| Observation period >= 5 minutes | PENDING |
| Connections returned toward baseline | PENDING |
| Runtime idle connections released as expected | PENDING |
| Readiness healthy | PENDING |
| Report-only reconciliation healthy | PENDING |
| No unexpected stranded/expired jobs | PENDING |
| Measured recovery time | PENDING |

## DR cleanup

| Check | Result |
| --- | --- |
| Disposable target identity re-verified | PENDING |
| Source deletion protection unchanged | PENDING |
| Disposable target deleted | PENDING |
| Cleanup operation result | PENDING |

## Final decision

**Task 9 result: `PENDING LIVE EVIDENCE`**

A final `PASS` requires all of the following:

1. recent successful backup evidence;
2. controlled isolated PITR with source unchanged;
3. measured RPO and RTO meeting the engineering objectives;
4. recovered schema/data/vector and reconciliation validation;
5. live connection-headroom gate;
6. successful low/moderate/spike load qualification;
7. successful worker and retrieval/vector concurrency qualification; and
8. bounded post-load recovery with no connection storm, correctness failure, or
   tenant-isolation failure.
