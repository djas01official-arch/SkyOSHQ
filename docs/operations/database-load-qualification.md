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

| Consumer | Maximum runtime instances/tasks | Connections per runtime | Maximum connections |
| --- | ---: | ---: | ---: |
| Cloud Run web | 2 | 3 | 6 |
| Background worker pool | 1 | 3 | 3 |
| Reconciliation job | 1 | 3 | 3 |
| Migrator/bootstrap job | 1 | 1 | 1 |
| **Known application maximum** |  |  | **13** |

Persistent Prisma runtimes use these values:

- `DATABASE_POOL_MAX=3`;
- `DATABASE_CONNECTION_TIMEOUT_MS=3000`; and
- `DATABASE_IDLE_TIMEOUT_MS=30000`.

The migrator uses one `pg.Client` and the same finite 3-second connection
acquisition timeout.

The 13-connection total is a configured ceiling for known application consumers,
not a claim about live database capacity.

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

The application budget passes only when:

```text
13 <= max_connections - max(10, ceil(max_connections * 0.30))
```

This reserve is intentionally not allocated to normal application traffic. It
protects operator access, Cloud SQL maintenance/recovery activity, and temporary
connection overlap during revision transitions.

If this equation fails, do not raise pool sizes or web scaling. Reduce the
application budget or resize the database only after reviewing observed load.

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
- web instance count;
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

- web scale never exceeds the configured maximum of two instances;
- known application connections stay within the 13-connection budget;
- the headroom reserve remains available;
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
- pool acquisition fails within the configured finite timeout rather than
  waiting indefinitely when capacity is unavailable;
- any overload errors are explicit and stop when pressure is removed;
- the headroom reserve is not consumed by normal application pools; and
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
- web and worker together stay inside the connection budget;
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
- vector/retrieval operations do not force connection use above the budget;
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
- web traffic remains within the same headroom rule; and
- no unexplained connection leak remains after the job exits.

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
- load duration and generated operation/request rate;
- p50/p95/p99 latency where the harness exposes it;
- error counts and classifications;
- Cloud SQL CPU/memory/disk observations;
- worker/reconciliation results;
- retrieval/vector correctness result; and
- measured post-load recovery time.

Task 9 may be marked `PASS` only when both this load qualification and the
separate disaster-recovery qualification have live evidence.
