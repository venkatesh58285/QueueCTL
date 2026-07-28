# Engineering Decisions

This document explains the key design decisions, trade-offs, and rejected alternatives for queuectl.

---

## 1. Concurrency: How is duplicate execution prevented?

**Approach:** Single atomic UPDATE query with embedded subselect.

```sql
UPDATE jobs
SET state = 'processing', worker_id = ?
WHERE id = (
  SELECT id FROM jobs WHERE state = 'pending'
  ORDER BY created_at ASC LIMIT 1
)
```

**Why this works:**
- SQLite serializes ALL write transactions. Only one process can execute a write at a time.
- The UPDATE + subselect runs as a single atomic operation.
- If two workers try to claim simultaneously, one will see `changes = 0` (the row was already claimed by the other) and moves on.
- No external locking mechanism (mutexes, file locks, Redis) is needed.

**Why not SELECT-then-UPDATE?**
A two-step approach (SELECT a pending job, then UPDATE it) has a TOCTOU race condition. Between the SELECT and UPDATE, another worker could claim the same job. The single-statement approach eliminates this entirely.

**Why not in-memory locks?**
Workers are separate OS processes. In-memory locks (mutexes, semaphores) don't work across process boundaries without shared memory or IPC. SQLite's write serialization provides cross-process mutual exclusion for free.

---

## 2. Crash Recovery: How are abandoned jobs detected?

**Mechanism:** Lease-based timeout with heartbeat.

- Workers update `last_heartbeat` in the `workers` table every 5 seconds.
- When a worker claims a job, `started_at` is set to the current time.
- Every 10 seconds, each running worker scans for jobs where:
  - `state = 'processing'`
  - `started_at` is older than 30 seconds

These jobs are considered abandoned (the worker crashed or was SIGKILL'd).

**Recovery action:**
- If `attempts < max_retries`: requeue the job (set state back to 'pending')
- If `attempts >= max_retries`: move to DLQ (state = 'dead')

**Why 30 seconds?**
- Long enough that a slow-but-alive job won't be prematurely reclaimed
- Short enough to meet the "recovery within 60 seconds" requirement
- Heartbeat interval (5s) + recovery scan interval (10s) + timeout (30s) = worst case ~45 seconds

**Why distributed recovery (every worker scans)?**
- No single point of failure: if the "recovery worker" crashes, others still recover jobs
- No additional process to manage
- SQLite handles contention if multiple workers try to recover the same job

**Rejected alternative: Central recovery process**
- Would require keeping yet another process alive
- Single point of failure — if it crashes, no recovery happens
- More complex deployment

---

## 3. Worker Stop: How is graceful shutdown signaled?

**Mechanism:** SQLite `workers` table state column.

When `queuectl worker stop` is called:
1. It sets `state = 'stopping'` for all workers with `state = 'running'`
2. Each worker checks its own state at the start of every poll cycle
3. If state is 'stopping', the worker finishes its current job and exits

**Why SQLite-based signaling?**

| Approach     | Cross-terminal | Cross-process | Crash-safe | Complexity |
|-------------|---------------|--------------|------------|------------|
| SQLite state | ✅            | ✅           | ✅         | Low        |
| PID files    | ✅            | ✅           | ❌ (stale) | Medium     |
| Unix sockets | ❌ (Windows)  | ✅           | ❌         | High       |
| Lock files   | ✅            | ✅           | ❌ (stale) | Medium     |

SQLite state is the simplest approach that works across all platforms and handles crashes gracefully (if a worker crashes, it just stops updating — no stale files to clean up).

**Rejected: SIGTERM via PID file**
- Requires storing PIDs in files and sending signals
- Stale PID files if worker crashes
- PID reuse on the OS could signal the wrong process
- Platform-dependent signal handling

---

## 4. Persistence: Why SQLite?

**Reasons:**
- Zero configuration — just a file
- ACID transactions — no partial writes, no corruption
- WAL mode — concurrent readers don't block the writer
- Cross-process safety — built-in locking handles multiple workers
- Survives restarts — it's just a file on disk
- Single dependency (better-sqlite3) vs. running a separate database server

**WAL mode specifically:**
Write-Ahead Logging allows readers to continue reading the old version while a writer commits new data. This means `queuectl status` doesn't block while a worker is claiming a job.

**busy_timeout = 5000ms:**
If a writer holds the lock, other writers wait up to 5 seconds before failing with SQLITE_BUSY. This prevents spurious failures under load.

---

## 5. Configuration: Do changes affect already-queued jobs?

**No.** Each job captures `max_retries` from the current config at enqueue time.

**Why?**
- Predictability: a job's behavior is determined when it enters the queue
- No surprises: changing config won't suddenly kill jobs that expected more retries
- Easy to reason about: "this job was enqueued with max_retries=3, that's what it gets"

**Trade-off:** If you increase max-retries, already-queued jobs keep the old limit. You'd need to re-enqueue them to get the new limit. This is intentional and documented.

---

## 6. Architecture: Why Repository + Service pattern?

**Repository layer:** Owns SQL queries. No business logic.
**Service layer:** Owns business rules. No SQL.

**Benefits:**
- Testable: services can be tested with mock repositories
- Explainable: "this function handles data, this one handles decisions"
- Maintainable: changing a query doesn't affect business logic
- Interview-friendly: clear separation of concerns

**Why not a single "model" class?**
- Mixes data access with business logic
- Harder to test (need a real database for every test)
- Harder to explain boundaries

---

## 7. Worker Process Design: Why polling?

Workers poll the database every 1 second for new jobs.

**Why not event-driven (pub/sub)?**
- Would require IPC between the enqueue command and workers
- The enqueue command is a short-lived CLI process — it exits immediately
- No shared runtime between enqueue and workers to push events through
- Polling is simple, reliable, and the 1s interval is negligible overhead

**Why 1 second?**
- Fast enough that jobs start within 1s of being enqueued
- Slow enough that SQLite isn't hammered with queries
- Each poll is a single indexed query — extremely cheap

---

## 8. Exponential Backoff Implementation

**Formula:** `delay_seconds = base ^ attempts`

With default base=2:
- Attempt 1: 2^1 = 2 seconds
- Attempt 2: 2^2 = 4 seconds
- Attempt 3: 2^3 = 8 seconds

**Implementation detail:** The delay is handled via `setTimeout` in the worker process. After the timeout fires, the job's state is set back to 'pending' so it can be claimed again.

**Trade-off:** If the worker crashes during the backoff wait, the `setTimeout` is lost. However, crash recovery will detect the job (its state is 'failed', not 'processing') — actually, the job is marked 'failed' immediately and only transitions back to 'pending' after the timer. So a crash during backoff means the job stays 'failed'. The next claim cycle won't find it. This is a known limitation documented in the README.

**Mitigation:** A more robust approach would store `retry_after` timestamp in the database and have workers check it. This was considered but adds complexity beyond the assignment requirements.

---

## 9. Error Handling Strategy

Every error is caught and handled at the appropriate level:
- **CLI layer:** catches service errors, prints user-friendly messages, sets exit code
- **Service layer:** validates inputs, throws descriptive errors
- **Worker layer:** catches execution failures, database errors, and logs them
- **Repository layer:** lets SQLite errors propagate (callers handle them)

**Principle:** No silent failures. Every error is either:
- Logged with context
- Returned to the user with a clear message
- Handled with a recovery action

---

## 10. Future Scalability

**What would change if this needed to handle 100x more load?**

1. **Replace SQLite with PostgreSQL** — SQLite's write serialization becomes a bottleneck. Postgres uses MVCC and row-level locking for true parallel writes.
2. **Use `SELECT ... FOR UPDATE SKIP LOCKED`** — Postgres-native atomic claiming without subqueries.
3. **Event-driven instead of polling** — Use LISTEN/NOTIFY or a message broker (Redis, RabbitMQ).
4. **Distributed workers** — Workers on different machines, communicating via the shared database or message queue.
5. **Job priority** — Add a `priority` column and ORDER BY priority DESC, created_at ASC.

The current architecture's clean layering means these changes would be localized to the repository and worker layers. The service layer and CLI wouldn't change.
