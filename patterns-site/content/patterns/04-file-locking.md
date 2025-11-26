---
title: "File Locking"
weight: 4
---

# File Locking (flock)

Synchronize access to shared resources between processes using filesystem-based locks.

## The Problem

Multiple processes (or instances of the same tool) might try to:
- Write to the same file (e.g., Terraform state)
- Use the same resource (e.g., Git index)
- Run operations that must be exclusive (e.g., database migrations)

Without coordination, you get race conditions, corruption, or undefined behavior.

## The Solution

Use `flock()` to acquire an **advisory lock** on a file. Other cooperating processes check the lock before proceeding.

```
Process A                           Process B
    │                                   │
    ▼                                   │
flock(LOCK_EX) ────────────────────┐   │
    │                              │   │
    │  Lock acquired               │   │
    │                              │   ▼
    │  Doing work...               │  flock(LOCK_EX)
    │                              │   │
    │                              │   │ BLOCKED
    │                              │   │ waiting...
    ▼                              │   │
flock(LOCK_UN) ◄───────────────────┘   │
    │                                   ▼
    │                              Lock acquired
    │                              Doing work...
```

## Linux Internals

### Advisory vs Mandatory Locks

| Type | Behavior | Use Case |
|------|----------|----------|
| **Advisory** (flock) | Cooperative—only works if all processes check | Most CLI tools |
| **Mandatory** (fcntl + mount option) | Kernel enforces—blocks all access | Rare, complex |

`flock()` is advisory, meaning uncooperating processes can ignore it. But for tools you control, it's simple and effective.

### Lock Types

| Flag | Meaning |
|------|---------|
| `LOCK_SH` | Shared lock (multiple readers allowed) |
| `LOCK_EX` | Exclusive lock (only one holder) |
| `LOCK_NB` | Non-blocking (return error if can't lock) |
| `LOCK_UN` | Unlock |

### Lock Scope
- Locks are associated with the **file descriptor**, not the file path
- When all FDs to a file close, locks are released
- Locks are **not** inherited across `fork()`

## Go Implementation

### Basic Exclusive Lock

```go
package main

import (
    "fmt"
    "os"
    "syscall"
    "time"
)

func main() {
    // Open or create lock file
    lockFile, err := os.OpenFile("/tmp/myapp.lock",
        os.O_CREATE|os.O_RDWR, 0644)
    if err != nil {
        fmt.Printf("Failed to open lock file: %v\n", err)
        os.Exit(1)
    }
    defer lockFile.Close()

    fmt.Println("Acquiring lock...")

    // Acquire exclusive lock (blocks until available)
    if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX); err != nil {
        fmt.Printf("Failed to acquire lock: %v\n", err)
        os.Exit(1)
    }
    defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)

    fmt.Println("Lock acquired! Doing critical work...")

    // Simulate work
    time.Sleep(5 * time.Second)

    fmt.Println("Work done, releasing lock.")
}
```

### Non-Blocking (Try Lock)

```go
package main

import (
    "fmt"
    "os"
    "syscall"
)

func main() {
    lockFile, err := os.OpenFile("/tmp/myapp.lock",
        os.O_CREATE|os.O_RDWR, 0644)
    if err != nil {
        fmt.Printf("Failed to open lock file: %v\n", err)
        os.Exit(1)
    }
    defer lockFile.Close()

    // Try to acquire lock without blocking
    err = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
    if err != nil {
        if err == syscall.EWOULDBLOCK {
            fmt.Println("Another instance is already running!")
            os.Exit(1)
        }
        fmt.Printf("Lock error: %v\n", err)
        os.Exit(1)
    }
    defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)

    fmt.Println("Lock acquired, proceeding...")
    // Do work
}
```

### Reusable Lock Helper

```go
package main

import (
    "context"
    "fmt"
    "os"
    "syscall"
    "time"
)

type FileLock struct {
    file *os.File
}

func NewFileLock(path string) (*FileLock, error) {
    f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
    if err != nil {
        return nil, err
    }
    return &FileLock{file: f}, nil
}

func (l *FileLock) Lock() error {
    return syscall.Flock(int(l.file.Fd()), syscall.LOCK_EX)
}

func (l *FileLock) TryLock() (bool, error) {
    err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
    if err == syscall.EWOULDBLOCK {
        return false, nil
    }
    if err != nil {
        return false, err
    }
    return true, nil
}

func (l *FileLock) LockWithTimeout(timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()

    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return fmt.Errorf("timeout acquiring lock")
        case <-ticker.C:
            acquired, err := l.TryLock()
            if err != nil {
                return err
            }
            if acquired {
                return nil
            }
        }
    }
}

func (l *FileLock) Unlock() error {
    return syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
}

func (l *FileLock) Close() error {
    l.Unlock()
    return l.file.Close()
}

func main() {
    lock, err := NewFileLock("/tmp/myapp.lock")
    if err != nil {
        fmt.Printf("Failed to create lock: %v\n", err)
        os.Exit(1)
    }
    defer lock.Close()

    fmt.Println("Trying to acquire lock (5s timeout)...")
    if err := lock.LockWithTimeout(5 * time.Second); err != nil {
        fmt.Printf("Failed: %v\n", err)
        os.Exit(1)
    }

    fmt.Println("Lock acquired!")
    time.Sleep(10 * time.Second)
}
```

## Real-World Examples

| Tool | Lock Purpose |
|------|--------------|
| **Git** | `.git/index.lock` prevents concurrent index operations |
| **Terraform** | State file locking prevents concurrent `apply` |
| **dpkg/apt** | `/var/lib/dpkg/lock` prevents concurrent installs |
| **Docker** | Container layer locks |

### Git's Lock Pattern

```bash
$ git status &
$ git add .
# => fatal: Unable to create '.git/index.lock': File exists.
```

Git creates a lock file before operations and removes it after. If a crash leaves a stale lock, users delete it manually.

## Best Practices

### 1. Store Lock Files in Appropriate Locations

```go
// System-wide lock
"/var/lock/myapp.lock"

// User-specific lock
filepath.Join(os.Getenv("HOME"), ".myapp.lock")

// Project-specific lock
filepath.Join(projectRoot, ".myapp.lock")
```

### 2. Handle Stale Locks
Write PID to the lock file to detect stale locks:

```go
func isLockStale(lockPath string) bool {
    data, err := os.ReadFile(lockPath)
    if err != nil {
        return false
    }

    pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
    if err != nil {
        return true // Can't parse, assume stale
    }

    // Check if process exists
    process, err := os.FindProcess(pid)
    if err != nil {
        return true
    }

    // Signal 0 checks existence without killing
    if err := process.Signal(syscall.Signal(0)); err != nil {
        return true
    }

    return false
}
```

### 3. Clean Up on Exit
Always unlock in a defer:

```go
lock.Lock()
defer lock.Unlock()
```

### 4. Provide User Feedback
Tell users why they're waiting:

```go
fmt.Println("Waiting for lock (another instance may be running)...")
lock.Lock()
```

## Common Pitfalls

{{< hint warning >}}
**NFS and Network Filesystems**
`flock()` may not work correctly over NFS. Use `fcntl()` locks or external coordination (Redis, etcd) instead.
{{< /hint >}}

{{< hint warning >}}
**Closing the File Releases the Lock**
If you close the file descriptor, the lock is released. Keep the file open for the duration of the critical section.
{{< /hint >}}

{{< hint danger >}}
**Deadlocks**
If process A holds lock 1 and waits for lock 2, while process B holds lock 2 and waits for lock 1—deadlock. Always acquire locks in a consistent order.
{{< /hint >}}

## Try It Yourself

1. Save the basic example to `lock.go`
2. Run `go run lock.go` in terminal 1
3. Run `go run lock.go` in terminal 2
4. Watch terminal 2 wait until terminal 1's lock is released

## Related Patterns

- [Daemonization]({{< relref "03-daemonization" >}}) - Use locks to ensure single daemon instance
- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Release locks on shutdown
