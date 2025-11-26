---
title: "Shell Wrapper"
weight: 1
---

# Shell Wrapper (Sub-shell Spawning)

Spawn a new shell process with a modified environment, allowing tools to inject credentials, paths, or configuration without affecting the parent shell.

## The Problem

Environment variables only propagate *downward* to child processes. A tool cannot modify its parent shell's environment—this is a fundamental Unix security constraint. So how do tools like `aws-vault` or `pipenv` seem to "inject" variables into your shell?

## The Solution

Instead of modifying the parent, spawn a **new shell** as a child process with the desired environment. The user "enters" this subshell, works within it, and exits when done.

```
┌─────────────────────────────────────────────────┐
│ Original Shell (bash, PID 1000)                 │
│   $ aws-vault exec production                   │
│        │                                        │
│        ▼                                        │
│   ┌─────────────────────────────────────────┐  │
│   │ New Shell (bash, PID 1001)              │  │
│   │   AWS_ACCESS_KEY_ID=AKIA...             │  │
│   │   AWS_SECRET_ACCESS_KEY=...             │  │
│   │   $ aws s3 ls  ← credentials available  │  │
│   │   $ exit                                │  │
│   └─────────────────────────────────────────┘  │
│        │                                        │
│        ▼                                        │
│   Back to original shell (no credentials)       │
└─────────────────────────────────────────────────┘
```

## Linux Internals

### Environment Inheritance
When a process calls `fork()` + `exec()`, the child inherits the parent's environment. We exploit this by:
1. Building a custom environment array
2. Executing a new shell with this environment

### `syscall.Exec` vs `os/exec.Command`

| Approach | Behavior | Use Case |
|----------|----------|----------|
| `syscall.Exec` | **Replaces** current process | Cleaner, no signal proxying needed |
| `exec.Command` | Spawns **child** process | Need to maintain parent for cleanup |

Using `syscall.Exec` is preferred because:
- Same PID (process "becomes" the shell)
- No need to proxy signals (SIGINT, SIGTERM, etc.)
- Cleaner process tree

## Go Implementation

### Basic Version (syscall.Exec)

```go
package main

import (
    "fmt"
    "os"
    "syscall"
)

func main() {
    // 1. Detect user's preferred shell
    shell := os.Getenv("SHELL")
    if shell == "" {
        shell = "/bin/sh"
    }

    // 2. Build modified environment
    env := os.Environ()
    env = append(env, "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")
    env = append(env, "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    env = append(env, "AWS_REGION=us-west-2")

    fmt.Printf("Entering subshell with credentials. Type 'exit' to leave.\n")

    // 3. Replace current process with shell
    // argv[0] should be the command name
    argv := []string{shell}

    if err := syscall.Exec(shell, argv, env); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to exec shell: %v\n", err)
        os.Exit(1)
    }
}
```

### Production Version (with cleanup)

When you need to perform cleanup after the shell exits, use `exec.Command`:

```go
package main

import (
    "context"
    "fmt"
    "os"
    "os/exec"
    "os/signal"
    "syscall"
)

func main() {
    shell := os.Getenv("SHELL")
    if shell == "" {
        shell = "/bin/sh"
    }

    // Setup signal handling for graceful cleanup
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

    // Create the subprocess
    cmd := exec.CommandContext(ctx, shell)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    // Inject environment
    cmd.Env = append(os.Environ(),
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        "MY_TOOL_ACTIVE=true",
    )

    // Start shell in its own process group (for clean signal handling)
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Setpgid: true,
    }

    fmt.Println("Entering subshell...")

    if err := cmd.Start(); err != nil {
        fmt.Fprintf(os.Stderr, "Failed to start shell: %v\n", err)
        os.Exit(1)
    }

    // Wait for shell to exit OR signal
    done := make(chan error, 1)
    go func() {
        done <- cmd.Wait()
    }()

    select {
    case <-sigCh:
        // Forward signal to child process group
        syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
        <-done
    case err := <-done:
        if err != nil {
            if exitErr, ok := err.(*exec.ExitError); ok {
                os.Exit(exitErr.ExitCode())
            }
        }
    }

    // Cleanup code runs here
    fmt.Println("Cleaning up credentials...")
}
```

## Real-World Examples

| Tool | Usage |
|------|-------|
| **aws-vault** | `aws-vault exec profile -- aws s3 ls` |
| **pipenv** | `pipenv shell` enters virtualenv |
| **nix-shell** | `nix-shell` enters Nix environment |
| **direnv** | Modifies shell prompt to show active env |

## Best Practices

### 1. Indicate Subshell Status
Modify the prompt so users know they're in a subshell:

```go
env = append(env, "PS1=(myenv) $PS1")
// or
env = append(env, "MY_TOOL_ACTIVE=true")
```

### 2. Handle Non-Interactive Usage
Support running a single command without entering interactive mode:

```bash
# Interactive
$ mytool exec production

# Non-interactive
$ mytool exec production -- aws s3 ls
```

```go
if len(os.Args) > 2 && os.Args[2] == "--" {
    // Run command directly instead of shell
    cmd := exec.Command(os.Args[3], os.Args[4:]...)
    cmd.Env = modifiedEnv
    // ...
}
```

### 3. Preserve TTY Settings
If the original terminal has special settings, preserve them:

```go
import "golang.org/x/term"

// Save terminal state
oldState, _ := term.GetState(int(os.Stdin.Fd()))
defer term.Restore(int(os.Stdin.Fd()), oldState)
```

## Common Pitfalls

{{< hint warning >}}
**Signal Handling with exec.Command**
When using `exec.Command` instead of `syscall.Exec`, you must proxy signals to the child process. Otherwise, Ctrl+C won't work as expected.
{{< /hint >}}

{{< hint danger >}}
**Environment Variable Leakage**
Be careful with sensitive values. Clear them from the environment after the subshell exits, and consider using memory-only credentials where possible.
{{< /hint >}}

## Try It Yourself

1. Save the basic version to `main.go`
2. Run `go build -o subshell && ./subshell`
3. Inside the subshell, run `env | grep AWS`
4. Type `exit` to leave

## Related Patterns

- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Properly handle signals in long-running subshells
- [Stdin Detection]({{< relref "08-stdin-detection" >}}) - Detect if running interactively or in a script
