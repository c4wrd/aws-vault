---
title: "Graceful Shutdown"
weight: 2
---

# Graceful Shutdown (Signal Trapping)

Intercept OS signals to perform cleanup before a process exits—essential for long-running services, dev servers, and tools that manage external resources.

## The Problem

When a user hits Ctrl+C or a container orchestrator sends SIGTERM, your process needs to:
- Close database connections cleanly
- Finish processing in-flight requests
- Remove temporary files or containers
- Release network ports

By default, these signals cause immediate termination. Your cleanup code never runs.

## The Solution

Trap signals using Go's `signal.Notify` or `signal.NotifyContext`, then perform cleanup in a controlled shutdown sequence.

```
User presses Ctrl+C
        │
        ▼
┌───────────────────────┐
│ OS sends SIGINT       │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ signal.NotifyContext  │
│ cancels context       │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ ctx.Done() triggers   │
│ cleanup goroutines    │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Wait for cleanup      │
│ (with timeout)        │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ os.Exit(0)            │
└───────────────────────┘
```

## Linux Internals

### Common Signals

| Signal | Number | Default Action | When Sent |
|--------|--------|----------------|-----------|
| `SIGINT` | 2 | Terminate | Ctrl+C |
| `SIGTERM` | 15 | Terminate | `kill`, Docker stop |
| `SIGKILL` | 9 | Terminate (uncatchable) | `kill -9` |
| `SIGHUP` | 1 | Terminate | Terminal closed |
| `SIGQUIT` | 3 | Core dump | Ctrl+\\ |

{{< hint info >}}
**SIGKILL cannot be caught**—it's the OS's "force quit." Your process must respond to SIGTERM quickly, or orchestrators will escalate to SIGKILL.
{{< /hint >}}

### Signal Delivery
When a signal arrives, the Go runtime interrupts one goroutine to run the signal handler. Using channels (`signal.Notify`) is safe and idiomatic in Go.

## Go Implementation

### Modern Approach (Go 1.16+)

```go
package main

import (
    "context"
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // Create context that cancels on SIGINT or SIGTERM
    ctx, stop := signal.NotifyContext(context.Background(),
        os.Interrupt,
        syscall.SIGTERM,
    )
    defer stop()

    // Start your server/worker
    server := startServer()

    fmt.Println("Server running. Press Ctrl+C to stop.")

    // Block until signal received
    <-ctx.Done()

    // Stop receiving signals (allows second Ctrl+C to force quit)
    stop()

    fmt.Println("\nShutdown signal received. Cleaning up...")

    // Give cleanup a deadline
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        fmt.Printf("Shutdown error: %v\n", err)
        os.Exit(1)
    }

    fmt.Println("Graceful shutdown complete.")
}

type Server struct{}

func startServer() *Server {
    return &Server{}
}

func (s *Server) Shutdown(ctx context.Context) error {
    // Simulate cleanup
    select {
    case <-time.After(2 * time.Second):
        return nil
    case <-ctx.Done():
        return ctx.Err()
    }
}
```

### Classic Channel Approach

```go
package main

import (
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // Buffered channel to avoid missing signals
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

    // Your main work
    go doWork()

    fmt.Println("Working... Press Ctrl+C to stop.")

    // Wait for signal
    sig := <-sigCh
    fmt.Printf("\nReceived %v, shutting down...\n", sig)

    // Perform cleanup
    cleanup()

    fmt.Println("Done.")
}

func doWork() {
    for {
        time.Sleep(1 * time.Second)
        fmt.Print(".")
    }
}

func cleanup() {
    fmt.Println("Releasing resources...")
    time.Sleep(500 * time.Millisecond)
}
```

### HTTP Server with Graceful Shutdown

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Simulate slow request
        time.Sleep(5 * time.Second)
        w.Write([]byte("Hello, World!"))
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }

    // Start server in goroutine
    go func() {
        fmt.Println("Server listening on :8080")
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            fmt.Printf("Server error: %v\n", err)
            os.Exit(1)
        }
    }()

    // Wait for interrupt
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
    <-quit

    fmt.Println("\nShutting down server...")

    // Give active requests time to complete
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        fmt.Printf("Forced shutdown: %v\n", err)
    }

    fmt.Println("Server stopped.")
}
```

## Real-World Examples

| Tool | Cleanup Actions |
|------|-----------------|
| **docker-compose** | Stop containers, remove networks |
| **webpack-dev-server** | Close file watchers, release port |
| **kubectl proxy** | Close connections, remove temp certs |
| **terraform** | Release state lock |

## Best Practices

### 1. Use Shutdown Timeouts
Don't wait forever for cleanup—set a deadline:

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
```

### 2. Allow Force Quit
After the first signal starts graceful shutdown, a second signal should force immediate exit:

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
defer stop()

<-ctx.Done()
stop() // Stop catching signals—next Ctrl+C will force quit
```

### 3. Log Shutdown Progress
Users should see what's happening during shutdown:

```go
fmt.Println("Waiting for active requests to complete...")
fmt.Println("Closing database connections...")
fmt.Println("Shutdown complete.")
```

### 4. Handle Multiple Cleanup Tasks
Use WaitGroup for parallel cleanup:

```go
var wg sync.WaitGroup
wg.Add(2)

go func() {
    defer wg.Done()
    closeDatabase()
}()

go func() {
    defer wg.Done()
    closeCache()
}()

wg.Wait()
```

## Common Pitfalls

{{< hint warning >}}
**Blocking Forever**
If cleanup hangs, the process never exits. Always use timeouts and consider a "force quit" option.
{{< /hint >}}

{{< hint warning >}}
**Unbuffered Signal Channel**
Using `make(chan os.Signal)` (unbuffered) can miss signals if your receiver isn't ready. Always use `make(chan os.Signal, 1)`.
{{< /hint >}}

{{< hint danger >}}
**Cleanup in main() After os.Exit()**
`os.Exit()` terminates immediately—deferred functions don't run:

```go
defer cleanup() // This won't run!
os.Exit(1)
```

Call cleanup explicitly before exiting.
{{< /hint >}}

## Try It Yourself

1. Run the HTTP server example
2. Start a slow request: `curl localhost:8080 &`
3. Press Ctrl+C
4. Watch the server wait for the request to complete

## Related Patterns

- [Shell Wrapper]({{< relref "01-shell-wrapper" >}}) - Signal handling in subshell scenarios
- [Daemonization]({{< relref "03-daemonization" >}}) - Background processes need robust signal handling
