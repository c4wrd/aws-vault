# Advanced Linux & Developer Tooling Patterns

This document outlines powerful system programming patterns found in advanced developer tools (like `aws-vault`, `docker`, `terraform`, etc.). These patterns leverage Linux internals and Go's runtime to create robust, interactive, and efficient CLI experiences.

## 1. The Shell Wrapper (Sub-shell Spawning)

**Concept:** Instead of just setting environment variables for the *current* process (which is hard/impossible to propagate "up" to the parent shell), the tool spawns a *new* shell process. This child shell inherits a modified environment (e.g., with injected credentials).

**Use Case:** `aws-vault`, `pipenv shell`, `nix-shell`.

**Linux Internals:**
1.  **Environment Injection:** `os.Environ()` + custom vars.
2.  **Syscall Exec:** `syscall.Exec` replaces the current process image with the new shell. The tool *becomes* the shell.
3.  **Signal Handling:** If using a subprocess (instead of `exec`), signals must be proxied.

**Go Implementation:**

```go
package main

import (
    "os"
    "os/exec"
    "syscall"
)

func main() {
    // 1. Detect User's Shell
    shell := os.Getenv("SHELL")
    if shell == "" {
        shell = "/bin/sh"
    }

    // 2. Prepare Environment
    env := os.Environ()
    env = append(env, "MY_TOOL_Inject=true")

    // 3. Replace Process (syscall.Exec)
    // This is cleaner than spawning a child because we don't need to proxy signals.
    // The PID remains the same.
    argv := []string{shell}
    err := syscall.Exec(shell, argv, env)
    if err != nil {
        panic(err)
    }
}
```

---

## 2. Graceful Shutdown (Signal Trapping)

**Concept:** Long-running CLI tools (dev servers, proxies) must clean up resources (Docker containers, temp files, network ports) when the user hits `Ctrl+C`.

**Use Case:** `docker-compose up`, `webpack-dev-server`.

**Linux Internals:** The OS sends `SIGINT` (Interrupt) or `SIGTERM` (Termination). By default, these kill the process immediately. We must intercept them.

**Go Implementation:**

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
    // Create a context that cancels on signal
    ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer cancel()

    fmt.Println("Running... (Press Ctrl+C to stop)")

    // Block until signal is received
    <-ctx.Done()

    fmt.Println("\nShutdown signal received. Cleaning up...")
    // Perform cleanup (e.g., waiting for active requests to finish)
    time.Sleep(1 * time.Second)
    fmt.Println("Cleanup done. Exiting.")
}
```

---

## 3. Daemonization (Double Fork / Backgrounding)

**Concept:** Running a process in the background, detached from the controlling terminal, so it persists after the user closes their shell.

**Use Case:** `dockerd`, background file watchers, agents.

**Linux Internals:**
1.  `fork()` parent exits, child runs.
2.  `setsid()` creates a new session, detaching from TTY.
3.  Redirect `stdin/out/err` to `/dev/null` or log files.

**Go Implementation:**
*Note: Go doesn't support `fork()` directly due to runtime complexity. The pattern is to re-execute the binary with a special flag.*

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
)

func main() {
    if len(os.Args) > 1 && os.Args[1] == "daemon" {
        runDaemon()
        return
    }

    // Spawn self as daemon
    cmd := exec.Command(os.Args[0], "daemon")
    cmd.Stdin = nil
    cmd.Stdout = nil
    cmd.Stderr = nil
    
    // Detach (setsid equivalent usually handled by OS or systemd, 
    // but effectively we are starting a background process here)
    err := cmd.Start()
    if err != nil {
        panic(err)
    }
    fmt.Printf("Daemon started with PID %d\n", cmd.Process.Pid)
}

func runDaemon() {
    // Actual background logic
    select {} // Block forever
}
```

---

## 4. File Locking (`flock`)

**Concept:** Ensuring only one instance of a tool runs at a time, or synchronizing access to a shared resource (like a `tfstate` file) between processes.

**Use Case:** `git` (index.lock), `terraform`, database migrations.

**Linux Internals:** `flock(fd, LOCK_EX)` places an advisory lock on an open file descriptor.

**Go Implementation:**

```go
package main

import (
    "fmt"
    "os"
    "syscall"
    "time"
)

func main() {
    file, _ := os.Create("/tmp/mytool.lock")
    defer file.Close()

    // Try to acquire exclusive lock. Non-blocking (LOCK_NB) would fail immediately.
    fmt.Println("Acquiring lock...")
    err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX)
    if err != nil {
        panic(err)
    }
    defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)

    fmt.Println("Lock acquired! Doing critical work...")
    time.Sleep(5 * time.Second)
}
```

---

## 5. PTY (Pseudo-Terminal) Control

**Concept:** Tricking a subprocess into thinking it's running in an interactive terminal. This forces it to output colors and accept interactive input, even when being run by a script.

**Use Case:** CI/CD runners, wrapping legacy CLI tools, TUIs.

**Go Implementation (using `creack/pty`):**

```go
package main

import (
    "io"
    "os"
    "os/exec"
    "github.com/creack/pty"
)

func main() {
    c := exec.Command("grep", "--color=auto", "foo", "myfile.txt")
    
    // Start with a PTY instead of standard pipes
    f, err := pty.Start(c)
    if err != nil {
        panic(err)
    }
    defer f.Close()

    // Copy PTY output (which will include ANSI color codes) to our stdout
    io.Copy(os.Stdout, f)
}
```

---

## 6. Self-Updating Binaries

**Concept:** A tool detects a new version, downloads it, and replaces its own executable file on disk.

**Use Case:** `kubectl` plugins, CLI tools outside package managers.

**Linux Internals:** You cannot overwrite a running executable. You must use `rename()` (which is atomic) to swap the new file into place, or `unlink` the old one first.

**Go Implementation (Conceptual):**

```go
// 1. Download new binary to /tmp/new_version
// 2. Verify checksum
// 3. os.Rename("/tmp/new_version", "/usr/local/bin/mytool")
//    Linux allows renaming over an executing binary. The old inode remains active
//    for the running process, but new executions use the new file.
```

---

## 7. Embedded Build Artifacts

**Concept:** Compiling static assets (scripts, config templates, migration SQL) directly into the binary.

**Use Case:** Single-file deployments, "Zero dependency" tools.

**Go Implementation:**

```go
package main

import (
    _ "embed"
    "fmt"
)

//go:embed templates/config.yaml
var defaultConfig string

func main() {
    fmt.Println("Default Config:", defaultConfig)
}
```

---

## 8. Stdin Detection (Piping vs. Interactive)

**Concept:** Detecting if the user is typing interactively or piping data into the tool.

**Use Case:** `cat` vs `grep`. Tools that behave differently in scripts (no prompts) vs terminals (interactive wizards).

**Go Implementation:**

```go
package main

import (
    "os"
)

func main() {
    stat, _ := os.Stdin.Stat()
    if (stat.Mode() & os.ModeCharDevice) == 0 {
        println("Data is being piped from stdin")
    } else {
        println("Running interactively in a terminal")
    }
}
```

---

## 9. Namespaces (Lightweight Isolation)

**Concept:** Restricting a process's view of the system (Network, Mounts, PID) without the full overhead of Docker.

**Use Case:** Sandboxed builds, testing networking.

**Go Implementation:**

```go
cmd := exec.Command("/bin/sh")
cmd.SysProcAttr = &syscall.SysProcAttr{
    Cloneflags: syscall.CLONE_NEWUTS | syscall.CLONE_NEWPID | syscall.CLONE_NEWNS,
}
cmd.Start()
```

---

## 10. Unix Domain Sockets (UDS)

**Concept:** Inter-process communication using filesystem paths instead of network ports. Faster, secure (file permissions apply).

**Use Case:** Docker daemon communication, local agents.

**Go Implementation:**

```go
// Server
l, _ := net.Listen("unix", "/tmp/mysocket.sock")
conn, _ := l.Accept()

// Client
conn, _ := net.Dial("unix", "/tmp/mysocket.sock")
```

---

## 11. Fanotify/Inotify (File Watching)

**Concept:** Subscribing to kernel events to react immediately to file changes.

**Use Case:** "Hot reload" dev tools (`air`, `nodemon`), auto-test runners.

**Library:** `fsnotify/fsnotify`

---

## 12. LD_PRELOAD Injection

**Concept:** Forcing the dynamic linker to load a custom shared library *before* libc.

**Use Case:** Intercepting system calls (e.g., mocking `open()` or `connect()`) for debugging or networking without recompiling the target binary.

---

## 13. Shim Executables

**Concept:** A lightweight entry-point binary that determines the environment/version and *then* executes the real tool.

**Use Case:** Version managers (`rbenv`, `nvm`, `volta`). The `node` command is actually a shim that looks at `.nvmrc` and forwards to `~/.nvm/versions/node/v14.../bin/node`.

---

## 14. eBPF Instrumentation

**Concept:** Injecting safe, sandboxed bytecode into the Linux kernel to observe or modify system behavior.

**Use Case:** High-performance observability, security monitoring, packet filtering.

**Library:** `cilium/ebpf`

---

## 15. ELF Binary Modification

**Concept:** Parsing and altering compiled binaries post-build.

**Use Case:** Injecting metadata, security tagging, or static analysis.

**Library:** `debug/elf`

---

## 16. Memfd Execution (Fileless)

**Concept:** Creating a file in memory (RAM-only) and executing it.

**Use Case:** Secure execution of sensitive tools, bypassing disk I/O.

**Implementation:**
1. `memfd_create()` syscall returns a file descriptor.
2. Write binary content to FD.
3. `execveat(fd, ...)` executes it directly.

```