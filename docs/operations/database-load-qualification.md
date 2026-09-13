# SkyOS database load qualification

## Purpose

This runbook qualifies the non-production PostgreSQL runtime for expected SkyOS
web, background-worker, reconciliation, and retrieval pressure. It is designed
to prove bounded connection use, useful failure behavior, and recovery after a
spike. It is not a generic database benchmark and does not establish a
production throughput SLO.

Task 9 is not complete from static configuration alone. The live scenarios in
this document must be executed against the reviewed non-production deployment
and recorded in `database-dr-load-qualification-report.md`.

## Static connection budget

The reviewed Task 9 configuration is intentionally small and explicit:

| Consumer                             | Configured steady-state instances/tasks | Connections per runtime | Nominal connections |
| ------------------------------------ | --------------------------------------: | ----------------------: | ------------------: |
| Cloud Run web                        |                     service-level max 2 |                       3 |                   6 |
| Background worker pool               |                                       1 |                       3 |                   3 |
| Reconciliation job                   |                                       1 |                       3 |                   3 |
| Migrator/bootstrap job               |                                       1 |                       1 |                   1 |
| **Known nominal application budget** |                                         |                         |              **13** |

Persistent Prisma runtimes use these values:

- `DATABASE_POOL_MAX=3`;
- `DATABASE_CONNECTION_TIMEOUT_MS=3000`; and
- `DATABASE_IDLE_TIMEOUT_MS=30000`.

The migrator uses one `pg.Client` and the same finite 3-second connection
acquisition timeout.

The web limit is configured at Cloud Run service level rather than revision level
so traffic splits and revision transitions share the same service cap. Cloud Run
can still temporarily exceed a configured maximum during rapid scaling. For that
reason, **13 is the nominal configured application budget, not an absolute
platform-level ceiling**. Each runtime is hard-bounded to three pooled database
connections, while the live spike and deployment gates must prove that transient
instance overshoot still preserves database headroom.

## Gate A: establish live capacity and headroom

Before load generation, query the live database from an approved private-network
operator runtime:

```sql
SELECT setting::int AS max_connections
FROM pg_settings
WHERE name = 'max_connections';

SELECT state, count(*) AS connections
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY state NULLS FIRST;

SELECT count(*) AS all_database_connections
FROM pg_stat_activity;
```

Also record Cloud SQL tier, current CPU utilization, memory utilization where
available, disk utilization, and connection count from Cloud Monitoring.

### Headroom rule

For Task 9 qualification, reserve the larger of:

- 10 database connections; or
- 30% of live `max_connections`, rounded up.

The nominal budget is acceptable only when:

```text
13 <= max_connections - max(10, ceil(max_connections * 0.30))
```

The operational gate is stricter: the **measured peak total application/database
connection count during moderate load, spike load, and a controlled revision
transition must remain below the same application allowance**. Static arithmetic
alone cannot qualify Cloud Run's transient overshoot behavior.

This reserve is intentionally not allocated to normal application traffic. It
protects operator access, Cloud SQL maintenance/recovery activity, and temporary
runtime overlap.

If either the nominal equation or the measured-peak gate fails, do not raise
pool sizes or web scaling. Reduce the application budget or resize the database
only after reviewing observed load.

## Gate B: baseline

Observe the deployed system for at least five minutes before intentional load.
Record:

- request volume and error rate;
- web revision instance count;
- database active/idle connections;
- Cloud SQL CPU, memory, disk, and connection utilization;
- worker status and queue depth; and
- reconciliation or migration jobs that are currently running.

A baseline with unexplained connection growth, persistent errors, or an already
saturated database blocks the test.

## Workload principles

1. Use only non-production test identities and tenant data.
2. Do not weaken tenancy, authentication, or rate-limiting controls to obtain a
   higher benchmark number.
3. Exercise representative application paths rather than a tight `SELECT 1`
   loop alone.
4. Keep the background worker enabled during the worker-concurrency scenario.
5. Exercise both ordinary relational reads/writes and knowledge retrieval/vector
   paths when suitable test data is available.
6. Use the same deployed pool configuration being qualified.
7. Stop a scenario if the database approaches the headroom reserve, if error
   behavior becomes unbounded, or if tenant/data correctness is uncertain.

## Metrics to capture for every scenario

Record one-minute or finer samples where available:

- generated request/operation rate;
- successful and failed operations;
- p50, p95, and p99 latency;
- web instance count by revision;
- database total, active, idle, and waiting connections;
- Cloud SQL CPU and memory utilization;
- disk latency/utilization where exposed;
- connection acquisition timeout/error count;
- worker queue depth and lease-expiry/retry activity;
- retrieval/vector-query latency and error count; and
- time to return to baseline after load stops.

Do not put credentials, session cookies, access tokens, database URLs, or user
content in the report.

## Scenario 1: low steady load

Run representative authenticated web operations for 10 minutes at a rate that
keeps a single web instance comfortably below saturation. Include common
read-heavy routes and at least one safe non-production write path.

Pass conditions:

- no database connection-acquisition timeouts;
- no unexpected HTTP 5xx caused by the database;
- connection count remains bounded and returns toward baseline after the run;
- no tenant-isolation or data-integrity failure; and
- no persistent worker backlog attributable to the database.

## Scenario 2: moderate sustained load

Run a 15-minute load sufficient to exercise Cloud Run scaling and concurrent
Prisma pool use without intentionally exhausting the database.

Pass conditions:

- steady-state web scaling respects the service-level target of two instances;
- any transient platform overshoot is captured rather than ignored;
- measured peak database connections remain below the calculated application
  allowance and preserve the headroom reserve;
- database errors do not appear under normal sustained pressure;
- p95 latency stabilizes rather than increasing continuously; and
- Cloud SQL CPU is not sustained above 80% for more than five consecutive
  minutes.

The CPU threshold is a qualification guardrail for the current small
non-production tier, not a production SLO.

## Scenario 3: bounded spike

Apply a short 2-5 minute burst above the moderate rate, then remove it completely.
The purpose is to prove bounded degradation, not to find a destructive maximum.

Pass conditions:

- database connection count does not grow without bound;
- any Cloud Run max-instance overshoot is transient and the measured connection
  peak still preserves the database reserve;
- pool acquisition fails within the configured finite timeout rather than
  waiting indefinitely when capacity is unavailable;
- any overload errors are explicit and stop when pressure is removed; and
- the service returns to its pre-spike connection/latency range within 60
  seconds after the spike ends, excluding intentionally queued domain work.

If the system cannot preserve the reserve, terminate the scenario and record a
failure rather than increasing the database connection limit during the test.

## Scenario 4: web plus background worker

Generate moderate authenticated application traffic while at least one
representative durable background-job flow is active. Suitable flows include
non-production document extraction, knowledge chunking, embedding, or AI
orchestration work whose side effects are understood.

Pass conditions:

- the worker remains at one configured instance;
- leases complete or retry through existing bounded recovery behavior;
- measured web and worker connections preserve the database headroom reserve;
- no duplicate domain completion or impossible job state is observed; and
- reconciliation report-only after the scenario finds no unexpected stranded or
  corrupt state.

## Scenario 5: retrieval/vector pressure

Using an existing non-production workspace with reviewed test knowledge data,
exercise the same search/retrieval path used by SkyOS. Include enough concurrent
requests to overlap vector and relational work.

Pass conditions:

- pgvector remains available;
- retrieval remains tenant-scoped and returns only permitted workspace data;
- vector/retrieval operations preserve the database headroom reserve;
- no database acquisition timeout occurs during low or moderate retrieval load;
- query latency stabilizes under the selected moderate rate; and
- correctness checks are performed on returned citations/results, not latency
  alone.

Do not fabricate a vector-only SQL microbenchmark and treat it as a substitute
for the application retrieval path.

## Scenario 6: reconciliation overlap

Run reconciliation in its normal report-only mode while low or moderate web load
continues. Do not use `--repair-expired-leases` for qualification unless the
mutation has been separately authorized.

Pass conditions:

- reconciliation exits successfully;
- its three-connection pool remains bounded;
- measured total connections preserve the same headroom rule; and
- no unexplained connection leak remains after the job exits.

## Scenario 7: controlled revision transition

While low representative traffic is active, deploy only the already-reviewed
Task 9 runtime/configuration revision using the normal deployment procedure.
Do not combine this gate with unrelated application changes.

Pass conditions:

- old and new revision instance counts are captured;
- measured peak database connections preserve the headroom reserve even during
  overlap;
- no connection storm or unbounded acquisition wait occurs;
- the old revision drains normally; and
- connection count returns toward baseline after the transition.

This gate exists because a service-level maximum reduces revision-overlap risk
but does not make Cloud Run's instance limit a mathematically absolute cap.

## Gate C: post-load recovery

After all load generators stop, observe the system for at least five minutes.
Record:

```sql
SELECT state, count(*) AS connections
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY state NULLS FIRST;
```

Also run report-only reconciliation and the normal health/readiness checks.

Pass conditions:

- connection count falls back toward baseline;
- idle connections are released according to the 30-second idle timeout where
  runtimes are no longer using them;
- no stuck migration/reconciliation execution remains;
- no unexpected background-job lease remains expired/stranded; and
- application readiness is healthy.

## Failure classification

Classify every failed operation before closing Task 9:

- expected bounded overload;
- connection acquisition timeout;
- database server/resource exhaustion;
- application defect;
- tenant/correctness defect;
- worker/reconciliation defect; or
- test-harness/operator defect.

A tenant/correctness defect, connection storm, unbounded wait, or recovery
failure is an automatic Task 9 failure regardless of aggregate throughput.

## Evidence required

The qualification report must include:

- live `max_connections`;
- calculated reserve and resulting application allowance;
- baseline connection count;
- actual maximum connection count per scenario;
- Cloud Run instance count by revision, including any transient overshoot;
- load duration and generated operation/request rate;
- p50/p95/p99 latency where the harness exposes it;
- error counts and classifications;
- Cloud SQL CPU/memory/disk observations;
- worker/reconciliation results;
- retrieval/vector correctness result; and
- measured post-load recovery time.

Task 9 may be marked `PASS` only when both this load qualification and the
separate disaster-recovery qualification have live evidence.
