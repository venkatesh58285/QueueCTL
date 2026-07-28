# queuectl

A persistent background job queue with a CLI interface. Jobs are shell commands executed by worker processes with retry logic, exponential backoff, dead letter queue, and crash recovery.

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER (Terminal)                                  │
│                                                                          │
│  queuectl enqueue "echo hi"    queuectl status    queuectl worker start  │
└──────────────┬──────────────────────┬─────────────────────┬─────────────┘
               │                      │                     │
               ▼                      ▼                     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           CLI LAYER (Commander.js)                        │
│                                                                          │
│   enqueue.js    status.js    list.js    dlq.js    config.js   worker.js  │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         CONTAINER (Dependency Injection)                  │
│                                                                          │
│  Wires together: DB Connection → Repositories → Services → Logger        │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│       SERVICE LAYER          │  │          WORKER PROCESSES             │
│                              │  │                                      │
│  queue-service.js            │  │  ┌────────────┐  ┌────────────┐     │
│  • enqueue logic             │  │  │  Worker 1  │  │  Worker 2  │ ... │
│  • retry/DLQ decisions       │  │  │            │  │            │     │
│  • backoff calculation       │  │  │ Poll Loop: │  │ Poll Loop: │     │
│                              │  │  │ 1. Claim   │  │ 1. Claim   │     │
│  config-service.js           │  │  │ 2. Execute │  │ 2. Execute │     │
│  • validate settings         │  │  │ 3. Report  │  │ 3. Report  │     │
│  • persist config            │  │  │ 4. Sleep   │  │ 4. Sleep   │     │
└──────────────┬───────────────┘  │  └─────┬──────┘  └─────┬──────┘     │
               │                  │        │                │            │
               ▼                  └────────┼────────────────┼────────────┘
┌──────────────────────────────┐           │                │
│      REPOSITORY LAYER        │           │                │
│                              │           │                │
│  job-repository.js           │           │                │
│  • INSERT, SELECT, UPDATE    │           │                │
│  • Atomic claim query        │           │                │
│                              │           │                │
│  worker-repository.js        │           │                │
│  • Register/heartbeat        │           │                │
│  • Stop signaling            │           │                │
│                              │           │                │
│  config-repository.js        │           │                │
│  • Key-value store           │           │                │
└──────────────┬───────────────┘           │                │
               │                           │                │
               ▼                           ▼                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         SQLite DATABASE (single file)                     │
│                                                                          │
│  ┌──────────────┐    ┌──────────────────┐    ┌────────────────────┐     │
│  │ jobs table   │    │  workers table   │    │   config table     │     │
│  │              │    │                  │    │                    │     │
│  │ id           │    │ id               │    │ key                │     │
│  │ command      │    │ pid              │    │ value              │     │
│  │ state ●──────┼──┐ │ state            │    └────────────────────┘     │
│  │ attempts     │  │ │ last_heartbeat   │                               │
│  │ max_retries  │  │ └──────────────────┘                               │
│  │ worker_id    │  │                                                     │
│  └──────────────┘  │  WAL Mode: concurrent reads + serialized writes    │
│                     │  busy_timeout: 5000ms                              │
│                     │                                                     │
└─────────────────────┼─────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          JOB STATE MACHINE                                │
│                                                                          │
│  ┌─────────┐  claim   ┌────────────┐  success  ┌───────────┐           │
│  │ PENDING ├─────────►│ PROCESSING ├──────────►│ COMPLETED │           │
│  └────┬────┘          └─────┬──────┘           └───────────┘           │
│       ▲                     │                                            │
│       │                     │ failure                                    │
│       │                     ▼                                            │
│       │  requeue     ┌──────────┐  max retries   ┌──────┐              │
│       │◄─────────────┤  FAILED  ├───────────────►│ DEAD │ (DLQ)       │
│       │  (after      └──────────┘  exceeded      └──┬───┘              │
│       │   backoff)                                   │                   │
│       │                                              │ dlq retry         │
│       │◄─────────────────────────────────────────────┘                   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Worker Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     SINGLE WORKER PROCESS                         │
│                                                                  │
│  START                                                           │
│    │                                                             │
│    ▼                                                             │
│  Register in DB (id, pid, state='running')                       │
│    │                                                             │
│    ▼                                                             │
│  ┌──────────────────────────────────┐                            │
│  │         MAIN POLL LOOP           │◄─────────── sleep(1s)     │
│  │                                  │                            │
│  │  1. Check: should I stop?        │──── yes ──► SHUTDOWN      │
│  │  2. Try to claim a pending job   │                            │
│  │  3. If claimed → execute it      │                            │
│  │  4. Handle success/failure       │                            │
│  │  5. Sleep 1 second               │                            │
│  └──────────────────────────────────┘                            │
│                                                                  │
│  BACKGROUND TIMERS (run in parallel):                            │
│  ┌─────────────────────┐  ┌──────────────────────────────┐      │
│  │ Heartbeat (every 5s)│  │ Crash Recovery (every 10s)   │      │
│  │ UPDATE last_heartbeat│  │ Find stale processing jobs   │      │
│  └─────────────────────┘  │ Requeue or move to DLQ       │      │
│                            └──────────────────────────────┘      │
│                                                                  │
│  SHUTDOWN (triggered by 'worker stop' or Ctrl+C):               │
│  1. Finish current job (never interrupt)                         │
│  2. Stop heartbeat timer                                         │
│  3. Stop recovery timer                                          │
│  4. Set state = 'stopped' in DB                                  │
│  5. Close DB connection                                          │
│  6. Exit process                                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Crash Recovery Flow

```
  Worker A claims Job X         Worker A gets SIGKILL (crash)
       │                              │
       ▼                              ▼
  jobs.state = 'processing'     Heartbeat stops updating
  jobs.started_at = NOW         (no cleanup runs)
       │                              │
       │                              │  ... 30 seconds pass ...
       │                              │
       │                              ▼
       │                        Worker B's recovery scan detects:
       │                        "Job X is processing but started_at
       │                         is older than 30 seconds"
       │                              │
       │                              ▼
       │                        Worker B requeues Job X:
       │                        jobs.state = 'pending'
       │                              │
       │                              ▼
       │                        Any worker claims Job X again
```

### File Structure

```
queuectl/
├── bin/
│   └── queuectl.js              → CLI entry point (2 lines)
├── src/
│   ├── cli/
│   │   ├── program.js           → Commander.js setup
│   │   └── commands/
│   │       ├── enqueue.js       → queuectl enqueue
│   │       ├── worker.js        → queuectl worker start/stop
│   │       ├── status.js        → queuectl status
│   │       ├── list.js          → queuectl list
│   │       ├── dlq.js           → queuectl dlq list/retry
│   │       └── config.js        → queuectl config set
│   ├── database/
│   │   ├── connection.js        → SQLite connection (WAL, busy_timeout)
│   │   └── schema.js            → CREATE TABLE statements
│   ├── repositories/
│   │   ├── job-repository.js    → Job SQL queries
│   │   ├── worker-repository.js → Worker SQL queries
│   │   └── config-repository.js → Config SQL queries
│   ├── services/
│   │   ├── queue-service.js     → Business logic (retry, backoff, DLQ)
│   │   └── config-service.js    → Config validation
│   ├── workers/
│   │   └── worker-process.js    → Worker loop (poll → claim → execute)
│   ├── utils/
│   │   └── logger.js            → Structured JSON logging
│   └── container.js             → Dependency injection
├── tests/
│   ├── unit/                    → Fast isolated tests
│   └── integration/             → Multi-process tests
├── data/                        → SQLite database (gitignored)
├── logs/                        → Log files (gitignored)
├── Dockerfile                   → Container image recipe
├── docker-compose.yml           → Multi-container setup
├── DECISIONS.md                 → Engineering decisions document
├── README.md                    → This file
└── package.json                 → Dependencies & scripts
```

## Installation

### Option A: Local (Node.js required)

```bash
npm install
```

### Option B: Docker (no Node.js needed)

```bash
docker build -t queuectl .
```

Or with Docker Compose:

```bash
docker compose build
```

## Dependencies

| Package        | Purpose                        |
|----------------|--------------------------------|
| better-sqlite3 | Synchronous SQLite driver      |
| commander      | CLI argument parsing           |
| uuid           | Job ID generation              |

## Database Schema

### jobs
| Column      | Type    | Purpose                                    |
|-------------|---------|-------------------------------------------|
| id          | TEXT PK | UUID, generated at enqueue time            |
| command     | TEXT    | Shell command to execute                   |
| state       | TEXT    | pending/processing/completed/failed/dead   |
| attempts    | INTEGER | Number of execution attempts               |
| max_retries | INTEGER | Retry limit (captured from config at enqueue) |
| created_at  | TEXT    | ISO timestamp                              |
| updated_at  | TEXT    | ISO timestamp, updated on state change     |
| started_at  | TEXT    | When worker claimed; used for lease timeout |
| worker_id   | TEXT    | Which worker currently owns this job       |

### workers
| Column         | Type    | Purpose                              |
|----------------|---------|--------------------------------------|
| id             | TEXT PK | Worker UUID                          |
| pid            | INTEGER | OS process ID                        |
| state          | TEXT    | running/stopping/stopped             |
| last_heartbeat | TEXT    | Updated every 5s; stale = crashed    |
| started_at     | TEXT    | When worker process started          |

### config
| Column | Type    | Purpose                    |
|--------|---------|----------------------------|
| key    | TEXT PK | Configuration key          |
| value  | TEXT    | Configuration value        |

## CLI Usage

### Enqueue a job
```bash
queuectl enqueue "echo hello world"
queuectl enqueue "python script.py --input data.csv"
```

### Start workers
```bash
queuectl worker start --count 4
```

### Stop all workers (gracefully)
```bash
queuectl worker stop
```

### Check queue status
```bash
queuectl status
```

### List jobs by state
```bash
queuectl list --state pending
queuectl list --state failed --json
```

### Dead Letter Queue
```bash
queuectl dlq list
queuectl dlq retry <job-id>
```

### Configuration
```bash
queuectl config set max-retries 5
queuectl config set backoff-base 3
```

## How It Works

### Atomic Job Claiming
Workers claim jobs using a single UPDATE with a subselect:
```sql
UPDATE jobs SET state='processing', worker_id=?
WHERE id = (SELECT id FROM jobs WHERE state='pending' ORDER BY created_at LIMIT 1)
```
SQLite serializes all writes, so only one worker wins the race. No external locks needed.

### Exponential Backoff
On failure: `delay = base ^ attempts` seconds.
- Attempt 1 → 2s delay
- Attempt 2 → 4s delay
- Attempt 3 → 8s delay

### Crash Recovery
Each worker updates a heartbeat every 5 seconds. Every 10 seconds, workers scan for jobs whose `started_at` is older than 30 seconds with state still `processing`. These are requeued or moved to DLQ.

### Graceful Shutdown
`worker stop` sets all workers' state to 'stopping' in the database. Workers check this state each poll cycle and exit after finishing the current job.

## Testing

### Local
```bash
# Run all unit tests
node --test tests/unit/*.test.js

# Run integration tests (slower, spawns real workers)
node --test tests/integration/*.test.js
```

### Docker
```bash
# Run tests inside container
docker run --rm --entrypoint node queuectl --test tests/unit/queue-service.test.js
```

---

## Docker Usage

### Quick Start with Docker Compose

```bash
# Build the image
docker compose build

# Enqueue some jobs
docker compose run queuectl enqueue "echo hello world"
docker compose run queuectl enqueue "echo another job"
docker compose run queuectl enqueue "exit 1"

# Check status
docker compose run queuectl status

# Start 2 workers in the background
docker compose up worker --scale worker=2 -d

# Wait a few seconds, then check status again
docker compose run queuectl status

# List completed jobs
docker compose run queuectl list --state completed --json

# Check dead letter queue
docker compose run queuectl dlq list

# Stop workers
docker compose down worker

# Change config
docker compose run queuectl config set max-retries 5
```

### Quick Start with Plain Docker

```bash
# Build
docker build -t queuectl .

# Create a shared volume for the database
docker volume create queuectl-data

# Run commands (always mount the same volume)
docker run -v queuectl-data:/app/data queuectl enqueue "echo hello"
docker run -v queuectl-data:/app/data queuectl status
docker run -v queuectl-data:/app/data queuectl list --state pending --json

# Start a worker (runs in background)
docker run -d -v queuectl-data:/app/data --entrypoint node queuectl src/workers/worker-process.js

# Check status after worker processes jobs
docker run -v queuectl-data:/app/data queuectl status
```

## Known Limitations

- Backoff delay is managed in-memory via `setTimeout`. If a worker dies during backoff, the retry timer is lost — but crash recovery will pick up the job.
- Job output is not captured/stored (could be added as a bonus feature).
- No job priority system (FIFO only).
- No job timeout configuration per-job (global 60s timeout hardcoded).

## Future Improvements

- Per-job timeout configuration
- Job priority levels
- Job output capture and storage
- Metrics/dashboard
- Scheduled (delayed) jobs
- Job cancellation
