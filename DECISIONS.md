# Engineering Decisions

This document answers the key design questions for queuectl, explains trade-offs, and documents rejected alternatives.

---

## 1. Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?

### The Exact Code

In `src/repositories/job-repository.js`, the `claimJob` prepared statement:

```sql
UPDATE jobs
SET state = 'processing',
    worker_id = ?,
    started_at = datetime('now'),
    updated_at = datetime('now')
WHERE id = (
  SELECT id FROM jobs
  WHERE state = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
)
```

This is ONE SQL statement — a single UPDATE with an embedded subquery.

### Why It's Atomic Across Separate OS Processes

SQLite uses a **file-level write lock**. Here's what happens:

1. Worker A and Worker B both call this statement at roughly the same time.
2. SQLite's locking mechanism ensures only ONE write transaction executes at a time. The other waits (up to `busy_timeout = 5000ms`).
3. Worker A's statement runs first:
   - The subquery finds job `X` (oldest pending)
   - The UPDATE sets `state = 'processing'` and `worker_id = 'A'`
   - The lock is released
4. Worker B's statement runs next:
   - The subquery looks for `state = 'pending'` jobs
   - Job `X` is no longer pending (it's `processing` now)
   - The subquery returns the NEXT pending job, or nothing
   - Worker B either gets a different job or gets `changes = 0`

**Key insight:** This works because the SELECT and UPDATE happen inside a SINGLE statement. There's no gap between "finding" and "claiming" where another process could interfere. This is different from a two-step approach:

```javascript
// DANGEROUS — DO NOT DO THIS:
const job = db.prepare("SELECT * FROM jobs WHERE state = 'pending' LIMIT 1").get();
// <-- Another worker could claim this job RIGHT HERE
db.prepare("UPDATE jobs SET state = 'processing' WHERE id = ?").run(job.id);
```

The two-step approach has a TOCTOU (Time-of-Check-to-Time-of-Use) race condition. Our single-statement approach eliminates it entirely.

### How We Verify It Worked

After the UPDATE, we check `result.changes`:
- `changes === 1` → we got a job
- `changes === 0` → someone else got it first, or no jobs available

This is in `job-repository.js`:
```javascript
claimNext(workerId) {
  const result = statements.claimJob.run(workerId);
  if (result.changes === 0) {
    return null;  // No job claimed
  }
  // Fetch the job we just claimed
  ...
}
```

---

## 2. A worker is SIGKILLed halfway through a job. Walk through, step by step, what state the job is in and how it eventually runs again. What is the worst-case delay before recovery?

### Step-by-Step Timeline

**T=0s: Worker A claims job X**
- `jobs.state` = `'processing'`
- `jobs.worker_id` = `'worker-A'`
- `jobs.started_at` = `'2024-01-01 12:00:00'`
- Worker A's heartbeat is current

**T=3s: Worker A is killed with SIGKILL**
- The process is terminated immediately by the OS
- No cleanup code runs (SIGKILL cannot be caught)
- The database is NOT corrupted (SQLite + WAL mode handles this)
- Job X remains in state `'processing'` with `started_at` = T=0s
- Worker A's `last_heartbeat` freezes at whatever it last was

**T=3s to T=30s: Job X is "stuck"**
- It's in `processing` state but no one is working on it
- The worker that owned it is dead

**T=10s, T=20s, T=30s: Other workers run crash recovery scans**
- Every 10 seconds, each living worker runs `recoverAbandonedJobs()`
- This function calls:
  ```sql
  SELECT * FROM jobs
  WHERE state = 'processing'
    AND started_at < datetime('now', '-30 seconds')
  ```
- At T=10s and T=20s: `started_at` is only 10/20 seconds old → NOT stale yet
- At T=30s+: `started_at` is now older than 30 seconds → DETECTED as stale

**T≈30-40s: Recovery happens**
- A living worker's recovery scan finds job X
- It increments `attempts` by 1
- Decision point:
  - If `attempts < max_retries`: set `state = 'pending'` (requeue for retry)
  - If `attempts >= max_retries`: set `state = 'dead'` (move to DLQ)
- Job X is now available to be claimed again (or in DLQ)

**T≈31-41s: Job X runs again**
- A worker's poll loop finds job X in `pending` state
- Claims it with the atomic UPDATE
- Executes it

### Worst-Case Delay Before Recovery

The worst case is:
- Worker crashes at T=0
- Recovery scan just ran at T=0 (so next scan is at T=10s)
- At T=10s: job is only 10s old, not stale yet (need 30s)
- At T=20s: job is only 20s old, still not stale
- At T=30s: job is 30s old, NOW it's stale — but recovery scan JUST ran
- At T=40s: next recovery scan detects it

**Worst-case delay = LEASE_TIMEOUT (30s) + RECOVERY_INTERVAL (10s) = ~40 seconds**

This is within the assignment's requirement of "recovery within 60 seconds."

### Why Not a Shorter Timeout?

If the lease timeout is too short (e.g., 5 seconds), a slow-but-alive job would be falsely recovered while it's still running. 30 seconds gives legitimate jobs enough time to complete while still recovering quickly from crashes.

---

## 3. Does `dlq retry` reset attempts? Why is that the right call?

### Current Behavior

Looking at `src/services/queue-service.js`:

```javascript
retryFromDLQ(jobId) {
  const job = jobRepository.findById(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.state !== 'dead') throw new Error(`Job ${jobId} is not in dead letter queue`);

  jobRepository.requeueForRetry(jobId);  // Sets state = 'pending'
  return jobRepository.findById(jobId);
}
```

And `requeueForRetry` in the repository:

```sql
UPDATE jobs
SET state = 'pending',
    worker_id = NULL,
    started_at = NULL,
    updated_at = datetime('now')
WHERE id = ?
```

**No, it does NOT reset attempts.** The `attempts` counter remains at its current value (e.g., 3).

### Why This Is the Right Call

1. **Preserves history:** The `attempts` count tells you how many times this job has been tried total. Resetting it would erase evidence of past failures.

2. **Prevents infinite retry loops:** If attempts reset to 0, and the job fails again, it would retry 3 more times, land in DLQ again, someone retries it again... infinite cycle. With attempts preserved, if `max_retries` is still 3 and `attempts` is already 3, the job will immediately go back to DLQ on next failure. The operator needs to either fix the underlying problem OR increase `max_retries` config.

3. **Operator intent is clear:** When someone runs `dlq retry`, they're saying "I fixed something, give it one more shot." They're not saying "forget everything that happened." The job gets ONE more attempt because:
   - State goes to `pending` → gets claimed → executes
   - If it succeeds: great, `state = 'completed'`
   - If it fails: `attempts` (now 4) >= `max_retries` (3) → back to DLQ immediately

4. **Auditable:** You can always see how many total attempts a job has had, regardless of how many times it was retried from DLQ.

### Alternative Considered: Reset Attempts to 0

This would give the job a completely fresh start. Rejected because:
- Loses failure history
- Can create retry storms (job keeps failing, keeps getting retried from DLQ, each time gets 3 more attempts)
- Harder to debug: "why has this job run 15 times?" is invisible if attempts keep resetting

---

## 4. What designs did you consider and reject for worker stop (cross-process signaling), and why?

### Chosen Approach: SQLite State Column

When `queuectl worker stop` runs, it executes:
```sql
UPDATE workers SET state = 'stopping' WHERE state = 'running'
```

Each worker checks its own state every poll cycle (every 1 second):
```javascript
function shouldStop() {
  const worker = container.workerRepository.findById(workerId);
  if (!worker || worker.state === 'stopping') return true;
  return false;
}
```

### Why This Was Chosen

| Requirement                    | SQLite state satisfies it? |
|-------------------------------|---------------------------|
| Works across terminals         | ✅ Any process can read/write the DB |
| Works across OS processes      | ✅ SQLite handles cross-process access |
| Crash-safe (no stale state)    | ✅ If worker crashes, nothing to clean up |
| Works on Windows AND Linux     | ✅ Pure file-based, no OS-specific APIs |
| Simple to implement            | ✅ One UPDATE, one SELECT |
| No extra dependencies          | ✅ Already using SQLite |
| Workers already poll DB        | ✅ Checking state is basically free |

### Rejected Alternative 1: PID Files

**How it would work:**
- Each worker writes its PID to a file (e.g., `data/worker-12345.pid`)
- `worker stop` reads all PID files and sends `SIGTERM` to each PID

**Why rejected:**
- **Stale PID files:** If a worker crashes, its PID file remains. Now you have ghost PID files lying around. Need cleanup logic.
- **PID reuse:** On Linux/Windows, PIDs get reused. You might send SIGTERM to a completely different process that got the same PID number.
- **Platform issues:** Sending signals works differently on Windows vs Unix. `process.kill()` on Windows is unreliable for SIGTERM.
- **Extra state to manage:** PID files are a second source of truth alongside the database. They can get out of sync.

### Rejected Alternative 2: Unix Domain Sockets

**How it would work:**
- Each worker opens a socket (e.g., `/tmp/queuectl-worker-abc.sock`)
- `worker stop` connects to each socket and sends a "stop" message

**Why rejected:**
- **Windows compatibility:** Unix domain sockets don't work on Windows (or require Windows 10+ with specific APIs)
- **Complexity:** Need to handle socket creation, connection errors, socket file cleanup
- **Crashes leave stale sockets:** If worker crashes, the socket file remains
- **Overkill:** We only need a boolean signal ("stop or don't stop"), not a communication channel

### Rejected Alternative 3: Lock Files with `flock`

**How it would work:**
- Workers hold a lock on a shared file
- `worker stop` removes the file or changes its contents

**Why rejected:**
- **Windows:** `flock` is a Unix concept. Windows uses different locking APIs.
- **No list of workers:** Lock files don't tell you which or how many workers are running
- **Deletion race conditions:** If stop command deletes the file while a worker is reading it

### Rejected Alternative 4: Named Pipe / FIFO

**How it would work:**
- Create a named pipe; `worker stop` writes to it; workers read from it

**Why rejected:**
- **Platform-specific:** Named pipes work differently on Windows vs Unix
- **One-to-many is hard:** Named pipes are typically one-to-one. Broadcasting to N workers requires N pipes or a fan-out mechanism.
- **Complexity far exceeds benefit**

### Summary

SQLite state wins because we're ALREADY using SQLite for everything else. Adding a state column costs zero additional infrastructure, works everywhere, and has no failure modes that aren't already handled (crash → heartbeat goes stale → recovery runs).

---

## 5. If priorities were added tomorrow (high-priority jobs jump the queue), which parts of your design survive unchanged and which break?

### What Survives Unchanged

| Component | Why it survives |
|-----------|----------------|
| `container.js` | Just wires things together — doesn't care about job fields |
| `config-service.js` | Config is separate from job structure |
| `config-repository.js` | Doesn't touch jobs |
| `worker-repository.js` | Doesn't touch jobs |
| `worker-process.js` (mostly) | Calls `claimNext()` — doesn't care HOW it selects |
| `logger.js` | Logging is decoupled from business logic |
| CLI commands (mostly) | `status`, `dlq`, `config`, `worker` commands don't care about priority |
| `Dockerfile`, `docker-compose.yml` | Infrastructure is business-logic-agnostic |
| All tests (as a base) | Existing behavior still needs to work |
| Crash recovery logic | Stale job detection doesn't depend on priority |
| Graceful shutdown | Signaling mechanism is independent of job ordering |

### What Needs to Change

**1. Database Schema** — add a column:
```sql
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
```
Higher number = higher priority.

**2. Job Repository — `claimJob` query:**

Current:
```sql
SELECT id FROM jobs WHERE state = 'pending' ORDER BY created_at ASC LIMIT 1
```

New:
```sql
SELECT id FROM jobs WHERE state = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1
```

This is a ONE-LINE change in the ORDER BY clause. High-priority jobs sort first; within the same priority, FIFO ordering is preserved.

**3. Queue Service — `enqueue()` method:**
Need to accept an optional `priority` parameter and pass it to the repository.

**4. CLI — `enqueue` command:**
Add a `--priority` option:
```bash
queuectl enqueue --priority 10 "urgent-job.sh"
```

**5. Index:**
Add a composite index for the new query:
```sql
CREATE INDEX idx_jobs_priority_created ON jobs(state, priority DESC, created_at ASC);
```

**6. `list` command:**
Might want to show/sort by priority.

### What This Says About the Architecture

The fact that adding priorities requires:
- 1 schema change
- 1 query modification
- 1 service parameter addition
- 1 CLI option

...and leaves 80% of the codebase untouched demonstrates that the layered architecture (repositories separate from services separate from CLI) works. The "claim" logic is centralized in one place, so changing the selection strategy is a surgical change, not a rewrite.

### Impact on Atomicity

The atomic claiming mechanism **still works perfectly** with priorities. The UPDATE+subquery pattern doesn't care what ORDER BY clause you use — it's still a single atomic statement that only one writer can execute at a time.

---

## Additional Design Notes

### Why WAL Mode?

WAL (Write-Ahead Logging) is critical for this project:
- Without WAL: readers block writers, writers block readers
- With WAL: readers never block writers, only writers wait for other writers
- Multiple workers reading status while one worker is claiming a job? WAL makes this seamless.

### Why `busy_timeout = 5000`?

When multiple workers try to write simultaneously, SQLite queues them. Without busy_timeout, a blocked writer would immediately get `SQLITE_BUSY` error. With 5000ms timeout, it waits up to 5 seconds for the lock — plenty of time since our writes are fast (microseconds).

### Why `better-sqlite3` (Synchronous) Instead of `sqlite3` (Async)?

- `better-sqlite3` is synchronous — simpler code, no callbacks/promises for DB operations
- Transactions are straightforward (no async transaction wrappers needed)
- The synchronous nature is fine because our workers do one thing at a time: poll → claim → execute → repeat
- Performance is actually better than the async `sqlite3` package for single-connection use

### Why UUID for Job IDs Instead of Auto-Increment?

- Workers and CLI processes can generate IDs independently without coordination
- No risk of ID collision between separate processes
- IDs are globally unique, useful if jobs are ever exported/shared
- Auto-increment would require reading the last ID from the database first (extra query + race condition potential)
