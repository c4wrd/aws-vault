---
title: "Daemonization"
weight: 3
---

# Daemonization (Background Process)

Run a process in the background, detached from the terminal, so it persists after the user closes their shell.

## The Problem

When you run a command in the terminal and close that terminal, the process typically dies. For long-running services (agents, file watchers, local servers), you want them to:
- Continue running after the terminal closes
- Start automatically on boot
- Log to files instead of stdout

## The Solution

Create a daemon—a process that runs in the background, detached from any controlling terminal.

```
Terminal Session                    System
┌─────────────────┐                ┌─────────────────┐
│ $ myagent start │                │                 │
│      │          │                │                 │
│      ▼          │                │                 │
│ Spawn daemon ───┼────────────────▶ Agent (PID 123)│
│ print PID       │                │ - No terminal   │
│ exit            │                │ - Logs to file  │
└─────────────────┘                │ - Runs forever  │
                                   └─────────────────┘
User closes terminal                Agent continues running
```

## Linux Internals

### Traditional Double-Fork
In C, the classic technique is:
1. `fork()` - Parent exits, child continues
2. `setsid()` - Create new session, detach from TTY
3. `fork()` again - Prevent reacquiring a TTY
4. Redirect stdin/stdout/stderr to /dev/null or log files

### Why Go Is Different
Go's runtime doesn't support `fork()` directly because:
- The Go runtime uses multiple OS threads
- After `fork()`, only the calling thread survives
- This leaves the runtime in an inconsistent state

**Solution:** Re-execute the same binary with a special flag.

## Go Implementation

### Self-Reexecution Pattern

```go
package main

import (
    "fmt"
    "log"
    "os"
    "os/exec"
    "syscall"
    "time"
)

const daemonFlag = "__DAEMON__"

func main() {
    // Check if we're already the daemon
    if os.Getenv(daemonFlag) == "1" {
        runDaemon()
        return
    }

    // Spawn ourselves as a daemon
    if err := spawnDaemon(); err != nil {
        log.Fatalf("Failed to start daemon: %v", err)
    }
}

func spawnDaemon() error {
    // Get path to current executable
    executable, err := os.Executable()
    if err != nil {
        return err
    }

    // Create the daemon process
    cmd := exec.Command(executable, os.Args[1:]...)

    // Detach from terminal
    cmd.Stdin = nil
    cmd.Stdout = nil
    cmd.Stderr = nil

    // Set environment to indicate we're the daemon
    cmd.Env = append(os.Environ(), daemonFlag+"=1")

    // Create new process group (detach from parent)
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Setsid: true, // Create new session
    }

    if err := cmd.Start(); err != nil {
        return err
    }

    fmt.Printf("Daemon started with PID %d\n", cmd.Process.Pid)

    // Write PID file for later management
    if err := os.WriteFile("/tmp/myagent.pid",
        []byte(fmt.Sprintf("%d", cmd.Process.Pid)), 0644); err != nil {
        log.Printf("Warning: couldn't write PID file: %v", err)
    }

    return nil
}

func runDaemon() {
    // Set up logging to file
    logFile, err := os.OpenFile("/tmp/myagent.log",
        os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
    if err != nil {
        os.Exit(1)
    }
    defer logFile.Close()

    log.SetOutput(logFile)
    log.Println("Daemon started")

    // Your actual daemon work
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        log.Println("Daemon heartbeat")
    }
}
```

### Daemon with Stop Command

```go
package main

import (
    "fmt"
    "os"
    "strconv"
    "syscall"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: myagent <start|stop|status>")
        os.Exit(1)
    }

    switch os.Args[1] {
    case "start":
        startDaemon()
    case "stop":
        stopDaemon()
    case "status":
        showStatus()
    default:
        fmt.Printf("Unknown command: %s\n", os.Args[1])
        os.Exit(1)
    }
}

func stopDaemon() {
    pidBytes, err := os.ReadFile("/tmp/myagent.pid")
    if err != nil {
        fmt.Println("Daemon not running (no PID file)")
        return
    }

    pid, err := strconv.Atoi(string(pidBytes))
    if err != nil {
        fmt.Printf("Invalid PID file: %v\n", err)
        return
    }

    // Send SIGTERM
    process, err := os.FindProcess(pid)
    if err != nil {
        fmt.Printf("Process not found: %v\n", err)
        return
    }

    if err := process.Signal(syscall.SIGTERM); err != nil {
        fmt.Printf("Failed to stop daemon: %v\n", err)
        return
    }

    os.Remove("/tmp/myagent.pid")
    fmt.Println("Daemon stopped")
}

func showStatus() {
    pidBytes, err := os.ReadFile("/tmp/myagent.pid")
    if err != nil {
        fmt.Println("Daemon is not running")
        return
    }

    pid, _ := strconv.Atoi(string(pidBytes))

    // Check if process is actually running
    process, err := os.FindProcess(pid)
    if err != nil {
        fmt.Println("Daemon is not running (stale PID file)")
        return
    }

    // On Unix, FindProcess always succeeds. Send signal 0 to check.
    if err := process.Signal(syscall.Signal(0)); err != nil {
        fmt.Println("Daemon is not running (stale PID file)")
        os.Remove("/tmp/myagent.pid")
        return
    }

    fmt.Printf("Daemon is running (PID %d)\n", pid)
}

func startDaemon() {
    // ... same as previous example
}
```

## Real-World Examples

| Tool | Daemon Purpose |
|------|----------------|
| **dockerd** | Docker daemon managing containers |
| **ssh-agent** | Holds SSH keys in memory |
| **gpg-agent** | Caches GPG passphrases |
| **systemd** | Init system (PID 1) |

## Modern Alternative: Systemd

Instead of manual daemonization, let systemd manage your process:

```ini
# /etc/systemd/system/myagent.service
[Unit]
Description=My Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/myagent
Restart=on-failure
User=nobody

[Install]
WantedBy=multi-user.target
```

Then your Go program stays simple—no daemonization code needed:

```go
func main() {
    // Just run your logic
    // Systemd handles backgrounding, logging, restarts
    for {
        doWork()
    }
}
```

## Best Practices

### 1. Use PID Files
Store the daemon's PID for later management:

```go
os.WriteFile("/var/run/myagent.pid", []byte(fmt.Sprintf("%d", pid)), 0644)
```

### 2. Handle SIGHUP for Config Reload
```go
sighup := make(chan os.Signal, 1)
signal.Notify(sighup, syscall.SIGHUP)

go func() {
    for range sighup {
        log.Println("Reloading configuration...")
        reloadConfig()
    }
}()
```

### 3. Log to Files with Rotation
Use `lumberjack` for automatic log rotation:

```go
import "gopkg.in/natefinch/lumberjack.v2"

log.SetOutput(&lumberjack.Logger{
    Filename:   "/var/log/myagent.log",
    MaxSize:    100, // MB
    MaxBackups: 3,
    MaxAge:     28, // days
})
```

### 4. Single Instance Check
Use file locking to prevent multiple daemons:

```go
lockFile, err := os.OpenFile("/tmp/myagent.lock", os.O_CREATE|os.O_RDWR, 0644)
if err != nil {
    log.Fatal(err)
}

if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
    log.Fatal("Another instance is already running")
}
defer syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
```

## Common Pitfalls

{{< hint warning >}}
**Orphaned PID Files**
If the daemon crashes, the PID file remains. Always verify the process is actually running before trusting the PID file.
{{< /hint >}}

{{< hint warning >}}
**Inheriting File Descriptors**
Close or redirect stdin/stdout/stderr. Otherwise, writing to stdout after terminal closes causes errors.
{{< /hint >}}

{{< hint danger >}}
**Running as Root**
Daemons often start as root to bind low ports, then drop privileges. Be careful with file permissions.
{{< /hint >}}

## Try It Yourself

1. Compile the daemon: `go build -o myagent`
2. Start it: `./myagent start`
3. Check status: `./myagent status`
4. View logs: `tail -f /tmp/myagent.log`
5. Stop it: `./myagent stop`

## Related Patterns

- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Daemons must handle SIGTERM
- [File Locking]({{< relref "04-file-locking" >}}) - Prevent multiple daemon instances
- [Unix Domain Sockets]({{< relref "10-unix-domain-sockets" >}}) - How daemons communicate with clients
