---
title: "PTY Control"
weight: 5
---

# PTY (Pseudo-Terminal) Control

Control a pseudo-terminal to trick programs into thinking they're running interactively, enabling color output, interactive input, and terminal manipulation.

## The Problem

Many programs detect whether they're running in a terminal:
- Colors are disabled when piping output
- Interactive prompts are skipped in scripts
- Progress bars don't render

Sometimes you need to run these programs programmatically while preserving their interactive behavior.

## The Solution

Create a **pseudo-terminal (PTY)**—a pair of virtual devices (master/slave) that emulate a real terminal. The program runs attached to the PTY slave, thinking it's interactive.

```
┌─────────────────────────────────────────────────────┐
│ Your Go Program                                     │
│ ┌─────────────────┐                                │
│ │ PTY Master (fd) │◄──── Read colored output       │
│ └────────┬────────┘                                │
│          │                                          │
│ ┌────────▼────────┐                                │
│ │ PTY Slave       │                                │
│ │ (looks like     │                                │
│ │  real terminal) │                                │
│ └────────┬────────┘                                │
│          │                                          │
│ ┌────────▼────────────────────────────────────────┐│
│ │ Child Process (e.g., grep --color=auto)         ││
│ │ isatty(stdout) = true                           ││
│ └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## Linux Internals

### TTY vs PTY

| Concept | Description |
|---------|-------------|
| **TTY** | TeleTYpewriter—original hardware terminals |
| **PTY** | Pseudo-TTY—software emulation |
| **Master** | Your program's end (read/write to control) |
| **Slave** | Child's end (appears as `/dev/pts/N`) |

### How PTYs Work
1. `posix_openpt()` or `/dev/ptmx` creates master
2. `grantpt()` / `unlockpt()` prepare slave
3. `ptsname()` returns slave path (e.g., `/dev/pts/3`)
4. Child opens slave, inherits it as stdin/stdout/stderr

### isatty() Check
Programs use `isatty(fd)` to detect terminals:

```c
if (isatty(STDOUT_FILENO)) {
    // Enable colors, interactive mode
}
```

A PTY slave returns `true` for `isatty()`.

## Go Implementation

### Using creack/pty Library

```go
package main

import (
    "io"
    "os"
    "os/exec"

    "github.com/creack/pty"
)

func main() {
    // Run a command that detects TTY for color output
    cmd := exec.Command("ls", "--color=auto", "-la")

    // Start with a PTY instead of pipes
    ptmx, err := pty.Start(cmd)
    if err != nil {
        panic(err)
    }
    defer ptmx.Close()

    // Copy PTY output (including ANSI colors) to stdout
    io.Copy(os.Stdout, ptmx)
}
```

### Interactive PTY with Input

```go
package main

import (
    "io"
    "os"
    "os/exec"
    "os/signal"
    "syscall"

    "github.com/creack/pty"
    "golang.org/x/term"
)

func main() {
    cmd := exec.Command("bash")

    // Start bash in a PTY
    ptmx, err := pty.Start(cmd)
    if err != nil {
        panic(err)
    }
    defer ptmx.Close()

    // Handle window size changes
    ch := make(chan os.Signal, 1)
    signal.Notify(ch, syscall.SIGWINCH)
    go func() {
        for range ch {
            if ws, err := pty.GetsizeFull(os.Stdin); err == nil {
                pty.Setsize(ptmx, ws)
            }
        }
    }()
    ch <- syscall.SIGWINCH // Initial size sync

    // Put terminal in raw mode
    oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
    if err != nil {
        panic(err)
    }
    defer term.Restore(int(os.Stdin.Fd()), oldState)

    // Bidirectional copy
    go io.Copy(ptmx, os.Stdin)
    io.Copy(os.Stdout, ptmx)
}
```

### Capturing Colored Output

```go
package main

import (
    "bytes"
    "fmt"
    "os/exec"

    "github.com/creack/pty"
)

func runWithColors(name string, args ...string) (string, error) {
    cmd := exec.Command(name, args...)

    // Run in PTY to get colored output
    ptmx, err := pty.Start(cmd)
    if err != nil {
        return "", err
    }
    defer ptmx.Close()

    var buf bytes.Buffer
    _, err = buf.ReadFrom(ptmx)
    if err != nil {
        return "", err
    }

    cmd.Wait()
    return buf.String(), nil
}

func main() {
    output, err := runWithColors("grep", "--color=always", "error", "/var/log/syslog")
    if err != nil {
        fmt.Println("No matches or error")
        return
    }
    fmt.Println(output) // Includes ANSI color codes
}
```

### Setting PTY Size

```go
package main

import (
    "os"
    "os/exec"

    "github.com/creack/pty"
)

func main() {
    cmd := exec.Command("vim", "file.txt")

    ptmx, err := pty.Start(cmd)
    if err != nil {
        panic(err)
    }
    defer ptmx.Close()

    // Set terminal size (80x24)
    pty.Setsize(ptmx, &pty.Winsize{
        Rows: 24,
        Cols: 80,
    })

    // ... handle I/O
}
```

## Real-World Examples

| Tool | PTY Usage |
|------|-----------|
| **tmux/screen** | Multiplexes PTYs for multiple sessions |
| **expect** | Automates interactive programs |
| **script** | Records terminal sessions |
| **Docker** | `docker run -it` allocates PTY |
| **SSH** | Remote PTY allocation |

### Docker -it Flag
```bash
# Without -t: no PTY, program may not work interactively
docker run ubuntu bash

# With -t: allocates PTY
docker run -it ubuntu bash
```

## Best Practices

### 1. Handle Window Resize
Terminal applications need to know the window size:

```go
signal.Notify(ch, syscall.SIGWINCH)
go func() {
    for range ch {
        pty.Setsize(ptmx, getTerminalSize())
    }
}()
```

### 2. Use Raw Mode for Full Control
For interactive applications, put the terminal in raw mode:

```go
oldState, _ := term.MakeRaw(int(os.Stdin.Fd()))
defer term.Restore(int(os.Stdin.Fd()), oldState)
```

### 3. Clean Up on Exit
Always restore terminal state:

```go
defer func() {
    term.Restore(int(os.Stdin.Fd()), oldState)
    ptmx.Close()
}()
```

### 4. Pass Through Signals
Forward signals to the child process:

```go
sigCh := make(chan os.Signal, 1)
signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

go func() {
    for sig := range sigCh {
        cmd.Process.Signal(sig)
    }
}()
```

## Common Pitfalls

{{< hint warning >}}
**Terminal Left in Bad State**
If your program crashes without restoring terminal settings, the terminal may be unusable. Always use `defer` for cleanup.
{{< /hint >}}

{{< hint warning >}}
**Buffering Issues**
PTY output might be line-buffered. Use `io.Copy` in a loop or read in chunks for real-time output.
{{< /hint >}}

{{< hint danger >}}
**Security: PTY Input Injection**
If you echo user input to a PTY, be careful about escape sequences that could execute commands.
{{< /hint >}}

## Try It Yourself

1. Install the PTY library: `go get github.com/creack/pty`
2. Save the colored output example
3. Run `go run main.go`
4. Compare with regular `exec.Command` (no colors)

## Related Patterns

- [Shell Wrapper]({{< relref "01-shell-wrapper" >}}) - Often uses PTYs for interactive subshells
- [Stdin Detection]({{< relref "08-stdin-detection" >}}) - Detect if running in a real terminal
