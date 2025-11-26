---
title: "Shim Executables"
weight: 13
---

# Shim Executables

A lightweight entry-point binary that determines context (environment, version) and then executes the appropriate underlying tool.

## The Problem

Version managers need to intercept commands:
- `node` should run the version specified in `.nvmrc`
- `python` should use the virtualenv's interpreter
- `ruby` should respect `.ruby-version`

How do you make `node` point to different binaries depending on context?

## The Solution

Create a **shim**—a small executable that:
1. Intercepts the command
2. Reads configuration (env vars, dotfiles)
3. Resolves the actual binary path
4. Executes the real tool

```
User runs: node script.js
      │
      ▼
┌─────────────────────────────────────────┐
│ Shim: ~/.local/bin/node                 │
│                                         │
│ 1. Check .nvmrc → "18.0.0"              │
│ 2. Find ~/.nvm/versions/node/v18.0.0    │
│ 3. exec() that node                     │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ Real Node: ~/.nvm/versions/.../node     │
│                                         │
│ Runs script.js                          │
└─────────────────────────────────────────┘
```

## How Version Managers Work

### The PATH Trick
Shims are placed early in `$PATH`:

```bash
# ~/.bashrc
export PATH="$HOME/.mymanager/shims:$PATH"

# Result
$ which node
/home/user/.mymanager/shims/node  # Shim, not real node
```

### Version Resolution Order
Typical resolution (most specific to least):

1. `MYMANAGER_NODE_VERSION` environment variable
2. `.node-version` in current directory
3. `.node-version` in parent directories
4. `~/.mymanager/version` (global default)

## Go Implementation

### Basic Shim

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "syscall"
)

func main() {
    // What tool are we shimming?
    shimName := filepath.Base(os.Args[0])

    // Resolve the version
    version := resolveVersion(shimName)
    if version == "" {
        fmt.Fprintf(os.Stderr, "No %s version configured\n", shimName)
        os.Exit(1)
    }

    // Find the real binary
    realBinary := findBinary(shimName, version)
    if realBinary == "" {
        fmt.Fprintf(os.Stderr, "%s version %s not installed\n", shimName, version)
        os.Exit(1)
    }

    // Execute it (replaces current process)
    err := syscall.Exec(realBinary, os.Args, os.Environ())
    if err != nil {
        fmt.Fprintf(os.Stderr, "Failed to exec: %v\n", err)
        os.Exit(1)
    }
}

func resolveVersion(tool string) string {
    envVar := strings.ToUpper(tool) + "_VERSION"

    // 1. Check environment variable
    if v := os.Getenv(envVar); v != "" {
        return v
    }

    // 2. Check .tool-version in current/parent directories
    dir, _ := os.Getwd()
    for dir != "/" {
        versionFile := filepath.Join(dir, "."+tool+"-version")
        if data, err := os.ReadFile(versionFile); err == nil {
            return strings.TrimSpace(string(data))
        }
        dir = filepath.Dir(dir)
    }

    // 3. Check global default
    home, _ := os.UserHomeDir()
    globalFile := filepath.Join(home, ".mymanager", "default-"+tool)
    if data, err := os.ReadFile(globalFile); err == nil {
        return strings.TrimSpace(string(data))
    }

    return ""
}

func findBinary(tool, version string) string {
    home, _ := os.UserHomeDir()

    // Look in ~/.mymanager/versions/<tool>/<version>/bin/<tool>
    binaryPath := filepath.Join(
        home, ".mymanager", "versions", tool, version, "bin", tool,
    )

    if _, err := os.Stat(binaryPath); err == nil {
        return binaryPath
    }

    return ""
}
```

### Multi-Tool Shim

```go
package main

import (
    "os"
    "os/exec"
    "path/filepath"
    "syscall"
)

// Single binary that acts as multiple shims based on argv[0]
func main() {
    shimName := filepath.Base(os.Args[0])

    switch shimName {
    case "node", "npm", "npx":
        runNodeTool(shimName)
    case "python", "pip":
        runPythonTool(shimName)
    case "ruby", "gem", "bundle":
        runRubyTool(shimName)
    default:
        os.Exit(1)
    }
}

func runNodeTool(tool string) {
    version := resolveNodeVersion()
    home, _ := os.UserHomeDir()

    binary := filepath.Join(home, ".mymanager/versions/node", version, "bin", tool)
    syscall.Exec(binary, os.Args, os.Environ())
}

// ... similar for other tools
```

### Shim Generator

```go
package main

import (
    "fmt"
    "os"
    "path/filepath"
)

func installShims() error {
    home, _ := os.UserHomeDir()
    shimDir := filepath.Join(home, ".mymanager", "shims")

    os.MkdirAll(shimDir, 0755)

    // List of tools to create shims for
    tools := []string{"node", "npm", "npx", "python", "pip", "ruby", "gem"}

    // Get path to our main binary
    mainBinary, _ := os.Executable()

    for _, tool := range tools {
        shimPath := filepath.Join(shimDir, tool)

        // Create symlink to main binary
        // The shim will use os.Args[0] to determine which tool to run
        os.Remove(shimPath)
        if err := os.Symlink(mainBinary, shimPath); err != nil {
            return fmt.Errorf("failed to create shim for %s: %w", tool, err)
        }

        fmt.Printf("Created shim: %s\n", shimPath)
    }

    return nil
}
```

### Hook-Based Shim (shell function)

Some version managers use shell functions instead of binaries:

```bash
# In .bashrc
node() {
    local version
    version=$(cat .node-version 2>/dev/null || echo "default")
    "$HOME/.mymanager/versions/node/$version/bin/node" "$@"
}
```

But shell functions don't work in scripts with `#!/usr/bin/env node`.

## Real-World Examples

| Tool | Shim Location |
|------|---------------|
| **rbenv** | `~/.rbenv/shims/*` |
| **pyenv** | `~/.pyenv/shims/*` |
| **nvm** | Uses shell functions (no shims) |
| **volta** | `~/.volta/bin/*` |
| **asdf** | `~/.asdf/shims/*` |

### How rbenv Works

```bash
$ which ruby
/home/user/.rbenv/shims/ruby

$ cat /home/user/.rbenv/shims/ruby
#!/usr/bin/env bash
set -e
[ -n "$RBENV_DEBUG" ] && set -x

program="${0##*/}"
export RBENV_ROOT="/home/user/.rbenv"
exec "/home/user/.rbenv/libexec/rbenv" exec "$program" "$@"
```

## Best Practices

### 1. Use syscall.Exec
Replace the shim process entirely—don't leave a parent process around:

```go
syscall.Exec(realBinary, os.Args, os.Environ())
// This never returns
```

### 2. Preserve All Arguments
Pass `os.Args` directly—don't lose arguments:

```go
syscall.Exec(binary, os.Args, os.Environ())
//                   ^^^^^^^ includes original argv[0]
```

### 3. Handle Missing Versions Gracefully

```go
if version == "" {
    fmt.Fprintf(os.Stderr, "No version set. Run 'mymanager install <version>'\n")
    os.Exit(1)
}
```

### 4. Support Multiple Version File Formats
Different tools use different files:

```go
versionFiles := []string{
    ".node-version",
    ".nvmrc",
    ".tool-versions", // asdf format
}
```

### 5. Fast Startup
Shims run on every command. Keep resolution fast:
- Cache resolved paths
- Avoid network calls
- Minimize file reads

## Common Pitfalls

{{< hint warning >}}
**PATH Order**
If the real binary comes before the shim in `$PATH`, the shim is bypassed. Always prepend shim directories.
{{< /hint >}}

{{< hint warning >}}
**Hashbang Scripts**
`#!/usr/bin/env python` looks up `python` in PATH and will find your shim—this is usually what you want.
{{< /hint >}}

{{< hint danger >}}
**Recursive Shims**
If your shim accidentally calls itself, you get infinite recursion. Ensure the real binary path excludes the shim directory.
{{< /hint >}}

## Performance Tip: Compiled Shims

Shell-based shims (like rbenv's) have startup overhead. Go/Rust shims are faster:

```bash
# Shell shim: ~30ms overhead
$ time rbenv exec ruby -v
real    0m0.035s

# Compiled shim: ~5ms overhead
$ time volta run node -v
real    0m0.008s
```

## Try It Yourself

1. Build the basic shim: `go build -o ~/.local/bin/node`
2. Create a version file: `echo "18.0.0" > .node-version`
3. Install Node 18 somewhere
4. Run `node --version` and watch it resolve

## Related Patterns

- [Shell Wrapper]({{< relref "01-shell-wrapper" >}}) - Similar exec-based pattern
- [LD_PRELOAD]({{< relref "12-ld-preload" >}}) - Alternative interception approach
- [Embedded Assets]({{< relref "07-embedded-assets" >}}) - Embed version mappings
