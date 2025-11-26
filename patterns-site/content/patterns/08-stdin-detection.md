---
title: "Stdin Detection"
weight: 8
---

# Stdin Detection (Piping vs Interactive)

Detect whether your program is receiving input from a pipe, file, or an interactive terminal—and adjust behavior accordingly.

## The Problem

CLI tools often need different behavior depending on how they're invoked:

```bash
# Interactive - show prompts, colors, progress bars
$ mytool

# Piped input - no prompts, parse stdin as data
$ cat data.json | mytool

# Piped output - no colors, clean output for parsing
$ mytool | jq .
```

Without detection, you might show prompts that break pipes, or omit colors in interactive use.

## The Solution

Check the file mode of stdin/stdout to determine if they're connected to a terminal (character device) or a pipe/file.

```
Interactive Terminal          Piped Input
┌─────────────────────┐      ┌─────────────────────┐
│ Terminal Emulator   │      │ $ cat file | mytool │
│ ┌─────────────────┐ │      │ ┌─────────────────┐ │
│ │ stdin (/dev/pts)│ │      │ │ stdin (pipe)    │ │
│ │ isatty = true   │ │      │ │ isatty = false  │ │
│ └─────────────────┘ │      │ └─────────────────┘ │
└─────────────────────┘      └─────────────────────┘
```

## Linux Internals

### Character Devices vs Pipes

| stdin Type | `os.ModeCharDevice` | `isatty()` |
|------------|---------------------|------------|
| Terminal (/dev/pts/N) | Set | true |
| Pipe | Not set | false |
| File | Not set | false |
| /dev/null | Set | true (but not a real terminal) |

### How `isatty()` Works
The kernel's `ioctl(fd, TIOCGWINSZ, ...)` call returns terminal size for TTYs, errors for non-TTYs. The C library's `isatty()` uses this (or similar) to detect terminals.

In Go, we check the file mode instead.

## Go Implementation

### Basic Detection

```go
package main

import (
    "os"
)

func main() {
    if isInputFromPipe() {
        println("Reading from pipe/file")
        // Parse stdin as data
    } else {
        println("Running interactively")
        // Show prompts, interactive UI
    }

    if isOutputToTerminal() {
        println("Output to terminal - colors OK")
    } else {
        println("Output piped - no colors")
    }
}

func isInputFromPipe() bool {
    stat, _ := os.Stdin.Stat()
    return (stat.Mode() & os.ModeCharDevice) == 0
}

func isOutputToTerminal() bool {
    stat, _ := os.Stdout.Stat()
    return (stat.Mode() & os.ModeCharDevice) != 0
}
```

### Using golang.org/x/term

```go
package main

import (
    "os"

    "golang.org/x/term"
)

func main() {
    if term.IsTerminal(int(os.Stdin.Fd())) {
        println("stdin is a terminal")
    }

    if term.IsTerminal(int(os.Stdout.Fd())) {
        println("stdout is a terminal")
    }

    if term.IsTerminal(int(os.Stderr.Fd())) {
        println("stderr is a terminal")
    }
}
```

### Practical Example: Smart Prompt

```go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"

    "golang.org/x/term"
)

func main() {
    var input string

    if term.IsTerminal(int(os.Stdin.Fd())) {
        // Interactive mode - prompt user
        fmt.Print("Enter your name: ")
        reader := bufio.NewReader(os.Stdin)
        input, _ = reader.ReadString('\n')
        input = strings.TrimSpace(input)
    } else {
        // Piped mode - read silently
        scanner := bufio.NewScanner(os.Stdin)
        if scanner.Scan() {
            input = scanner.Text()
        }
    }

    // Output: adapt to context
    if term.IsTerminal(int(os.Stdout.Fd())) {
        fmt.Printf("\033[1;32mHello, %s!\033[0m\n", input) // Green, bold
    } else {
        fmt.Printf("Hello, %s!\n", input) // Plain
    }
}
```

### Color Output Helper

```go
package main

import (
    "fmt"
    "os"

    "golang.org/x/term"
)

type Color string

const (
    Reset  Color = "\033[0m"
    Red    Color = "\033[31m"
    Green  Color = "\033[32m"
    Yellow Color = "\033[33m"
    Blue   Color = "\033[34m"
    Bold   Color = "\033[1m"
)

var useColors = term.IsTerminal(int(os.Stdout.Fd()))

func colorize(color Color, text string) string {
    if useColors {
        return string(color) + text + string(Reset)
    }
    return text
}

func main() {
    fmt.Println(colorize(Green, "✓ Success"))
    fmt.Println(colorize(Red, "✗ Error"))
    fmt.Println(colorize(Bold, "Important message"))
}
```

### Reading All Piped Input

```go
package main

import (
    "fmt"
    "io"
    "os"

    "golang.org/x/term"
)

func main() {
    if term.IsTerminal(int(os.Stdin.Fd())) {
        fmt.Println("Usage: cat file.txt | mytool")
        os.Exit(1)
    }

    // Read all piped input
    input, err := io.ReadAll(os.Stdin)
    if err != nil {
        fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Received %d bytes\n", len(input))
    // Process input...
}
```

### Timeout for Interactive Input

```go
package main

import (
    "bufio"
    "context"
    "fmt"
    "os"
    "time"

    "golang.org/x/term"
)

func main() {
    if !term.IsTerminal(int(os.Stdin.Fd())) {
        // Piped - read immediately
        scanner := bufio.NewScanner(os.Stdin)
        scanner.Scan()
        fmt.Println("Got:", scanner.Text())
        return
    }

    // Interactive - use timeout
    fmt.Print("Enter value (5s timeout): ")

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    inputCh := make(chan string, 1)
    go func() {
        reader := bufio.NewReader(os.Stdin)
        line, _ := reader.ReadString('\n')
        inputCh <- line
    }()

    select {
    case input := <-inputCh:
        fmt.Println("Got:", input)
    case <-ctx.Done():
        fmt.Println("\nTimeout - using default")
    }
}
```

## Real-World Examples

| Tool | Behavior |
|------|----------|
| **ls** | Columns in terminal, one-per-line when piped |
| **grep** | Colors in terminal, plain when piped |
| **git** | Pager in terminal, full output when piped |
| **jq** | Colors in terminal, plain when piped |

### The `--color` Flag Pattern
Many tools provide explicit override:

```bash
ls --color=auto   # Detect (default)
ls --color=always # Force colors
ls --color=never  # Force plain
```

```go
var colorMode string

func init() {
    flag.StringVar(&colorMode, "color", "auto", "auto|always|never")
}

func shouldUseColor() bool {
    switch colorMode {
    case "always":
        return true
    case "never":
        return false
    default: // auto
        return term.IsTerminal(int(os.Stdout.Fd()))
    }
}
```

## Best Practices

### 1. Check All Three File Descriptors
Different behavior for each:

```go
stdinTTY := term.IsTerminal(int(os.Stdin.Fd()))
stdoutTTY := term.IsTerminal(int(os.Stdout.Fd()))
stderrTTY := term.IsTerminal(int(os.Stderr.Fd()))
```

### 2. Provide Override Flags
Users should be able to force behavior:

```go
if *forceInteractive {
    runInteractiveMode()
} else if isInputFromPipe() {
    runBatchMode()
}
```

### 3. Errors to Stderr
Always write errors to stderr, which might still be a terminal even when stdout is piped:

```go
fmt.Fprintf(os.Stderr, "Error: %v\n", err)
```

### 4. Respect NO_COLOR
The [NO_COLOR](https://no-color.org/) convention:

```go
func shouldUseColor() bool {
    if os.Getenv("NO_COLOR") != "" {
        return false
    }
    return term.IsTerminal(int(os.Stdout.Fd()))
}
```

## Common Pitfalls

{{< hint warning >}}
**SSH and Pseudo-terminals**
When SSHing, stdin might be a PTY but not truly interactive. Check for `SSH_TTY` environment variable if needed.
{{< /hint >}}

{{< hint warning >}}
**/dev/null**
`/dev/null` is a character device, so `os.ModeCharDevice` is set, but it's not a real terminal. Use `term.IsTerminal()` for accurate detection.
{{< /hint >}}

## Try It Yourself

```bash
# Interactive
$ go run main.go

# Piped input
$ echo "test" | go run main.go

# Piped output
$ go run main.go | cat

# Both piped
$ echo "test" | go run main.go | cat
```

## Related Patterns

- [PTY Control]({{< relref "05-pty-control" >}}) - Force programs to think they're in a terminal
- [Shell Wrapper]({{< relref "01-shell-wrapper" >}}) - Subshells inherit terminal state
