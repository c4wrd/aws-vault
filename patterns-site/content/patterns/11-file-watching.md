---
title: "File Watching"
weight: 11
---

# File Watching (inotify/FSEvents)

Subscribe to kernel events to react immediately to file and directory changes—the foundation of hot-reload tooling.

## The Problem

You want to automatically react when files change:
- Rebuild when source code changes
- Restart server on config updates
- Sync files to remote
- Run tests on save

Polling is inefficient and introduces latency. There must be a better way.

## The Solution

Use kernel-level file notification systems:
- **Linux**: inotify
- **macOS**: FSEvents
- **Windows**: ReadDirectoryChangesW
- **BSD**: kqueue

The **fsnotify** library abstracts these into a consistent Go API.

```
┌─────────────────────────────────────────────────────────────┐
│ File System                              Your Application   │
│                                                             │
│ ┌─────────┐                             ┌─────────────┐    │
│ │ write() │ ────▶ Kernel ────▶ inotify ─▶│ fsnotify    │    │
│ │ rename()│                              │ watcher     │    │
│ │ delete()│                              └──────┬──────┘    │
│ └─────────┘                                     │           │
│                                                 ▼           │
│                                          Rebuild/Restart    │
└─────────────────────────────────────────────────────────────┘
```

## Linux Internals

### inotify Events

| Event | Trigger |
|-------|---------|
| `IN_CREATE` | File/dir created |
| `IN_DELETE` | File/dir deleted |
| `IN_MODIFY` | File modified |
| `IN_MOVED_FROM` | File moved out |
| `IN_MOVED_TO` | File moved in |
| `IN_ATTRIB` | Metadata changed |
| `IN_CLOSE_WRITE` | Writable file closed |

### How inotify Works
1. `inotify_init()` creates an inotify instance (returns fd)
2. `inotify_add_watch()` adds paths to monitor
3. `read()` on the fd blocks until events occur
4. Events contain: watch descriptor, event mask, filename

### Limits
Check/increase limits if watching many files:

```bash
# Maximum watches per user
$ cat /proc/sys/fs/inotify/max_user_watches
524288

# Increase temporarily
$ sudo sysctl fs.inotify.max_user_watches=1048576
```

## Go Implementation

### Basic File Watcher

```go
package main

import (
    "fmt"
    "log"

    "github.com/fsnotify/fsnotify"
)

func main() {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        log.Fatal(err)
    }
    defer watcher.Close()

    // Start listening for events
    go func() {
        for {
            select {
            case event, ok := <-watcher.Events:
                if !ok {
                    return
                }
                fmt.Printf("Event: %s %s\n", event.Op, event.Name)

                if event.Op&fsnotify.Write == fsnotify.Write {
                    fmt.Println("Modified file:", event.Name)
                }

            case err, ok := <-watcher.Errors:
                if !ok {
                    return
                }
                fmt.Println("Error:", err)
            }
        }
    }()

    // Add paths to watch
    err = watcher.Add("/tmp/watched")
    if err != nil {
        log.Fatal(err)
    }

    fmt.Println("Watching /tmp/watched...")

    // Block forever
    select {}
}
```

### Hot Reload Server

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/exec"
    "path/filepath"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"
)

type HotReloader struct {
    watcher    *fsnotify.Watcher
    cmd        *exec.Cmd
    mu         sync.Mutex
    debounce   *time.Timer
    buildCmd   string
    runCmd     string
    watchPaths []string
}

func NewHotReloader(build, run string, paths []string) (*HotReloader, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, err
    }

    return &HotReloader{
        watcher:    watcher,
        buildCmd:   build,
        runCmd:     run,
        watchPaths: paths,
    }, nil
}

func (h *HotReloader) Start() error {
    // Add all paths
    for _, p := range h.watchPaths {
        if err := h.addRecursive(p); err != nil {
            return err
        }
    }

    // Initial build and run
    h.rebuild()

    // Watch for changes
    go h.watchLoop()

    return nil
}

func (h *HotReloader) addRecursive(root string) error {
    return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
        if err != nil {
            return err
        }
        if info.IsDir() {
            return h.watcher.Add(path)
        }
        return nil
    })
}

func (h *HotReloader) watchLoop() {
    for {
        select {
        case event := <-h.watcher.Events:
            if shouldIgnore(event.Name) {
                continue
            }

            // Debounce: wait for writes to settle
            h.mu.Lock()
            if h.debounce != nil {
                h.debounce.Stop()
            }
            h.debounce = time.AfterFunc(100*time.Millisecond, h.rebuild)
            h.mu.Unlock()

        case err := <-h.watcher.Errors:
            fmt.Printf("Watcher error: %v\n", err)
        }
    }
}

func (h *HotReloader) rebuild() {
    h.mu.Lock()
    defer h.mu.Unlock()

    // Stop current process
    if h.cmd != nil && h.cmd.Process != nil {
        h.cmd.Process.Kill()
        h.cmd.Wait()
    }

    fmt.Println("\n🔄 Rebuilding...")

    // Build
    build := exec.Command("sh", "-c", h.buildCmd)
    build.Stdout = os.Stdout
    build.Stderr = os.Stderr
    if err := build.Run(); err != nil {
        fmt.Printf("❌ Build failed: %v\n", err)
        return
    }

    fmt.Println("✅ Build succeeded, restarting...")

    // Run
    h.cmd = exec.Command("sh", "-c", h.runCmd)
    h.cmd.Stdout = os.Stdout
    h.cmd.Stderr = os.Stderr
    h.cmd.Start()
}

func shouldIgnore(path string) bool {
    // Ignore temp files, hidden files, etc.
    base := filepath.Base(path)
    return base[0] == '.' ||
        filepath.Ext(path) == ".swp" ||
        filepath.Ext(path) == ".tmp"
}

func main() {
    reloader, _ := NewHotReloader(
        "go build -o ./app ./cmd/server",
        "./app",
        []string{"./cmd", "./internal"},
    )

    reloader.Start()

    // Keep running
    select {}
}
```

### Config Watcher

```go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "sync"

    "github.com/fsnotify/fsnotify"
)

type Config struct {
    Port     int    `json:"port"`
    LogLevel string `json:"log_level"`
}

type ConfigManager struct {
    path    string
    config  Config
    mu      sync.RWMutex
    watcher *fsnotify.Watcher
    onChange func(Config)
}

func NewConfigManager(path string, onChange func(Config)) (*ConfigManager, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, err
    }

    cm := &ConfigManager{
        path:     path,
        watcher:  watcher,
        onChange: onChange,
    }

    // Initial load
    if err := cm.reload(); err != nil {
        return nil, err
    }

    // Watch for changes
    if err := watcher.Add(path); err != nil {
        return nil, err
    }

    go cm.watch()

    return cm, nil
}

func (cm *ConfigManager) reload() error {
    data, err := os.ReadFile(cm.path)
    if err != nil {
        return err
    }

    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return err
    }

    cm.mu.Lock()
    cm.config = config
    cm.mu.Unlock()

    if cm.onChange != nil {
        cm.onChange(config)
    }

    return nil
}

func (cm *ConfigManager) Get() Config {
    cm.mu.RLock()
    defer cm.mu.RUnlock()
    return cm.config
}

func (cm *ConfigManager) watch() {
    for {
        select {
        case event := <-cm.watcher.Events:
            if event.Op&fsnotify.Write == fsnotify.Write {
                fmt.Println("Config changed, reloading...")
                if err := cm.reload(); err != nil {
                    fmt.Printf("Error reloading config: %v\n", err)
                }
            }
        case err := <-cm.watcher.Errors:
            fmt.Printf("Watcher error: %v\n", err)
        }
    }
}

func main() {
    cm, _ := NewConfigManager("config.json", func(c Config) {
        fmt.Printf("Config updated: port=%d, level=%s\n", c.Port, c.LogLevel)
    })

    fmt.Printf("Initial config: %+v\n", cm.Get())

    // Keep running
    select {}
}
```

## Real-World Examples

| Tool | Watch Purpose |
|------|---------------|
| **air** | Go hot reload |
| **nodemon** | Node.js restart on change |
| **webpack** | Bundle on source change |
| **entr** | Generic command runner |
| **watchexec** | Cross-platform watcher |

## Best Practices

### 1. Debounce Events
File saves often generate multiple events. Wait for them to settle:

```go
var debounceTimer *time.Timer

case event := <-watcher.Events:
    if debounceTimer != nil {
        debounceTimer.Stop()
    }
    debounceTimer = time.AfterFunc(100*time.Millisecond, handleChange)
```

### 2. Ignore Editor Files
Editors create temporary files:

```go
func shouldIgnore(path string) bool {
    patterns := []string{
        "*.swp", "*.swo",  // vim
        "*~",              // emacs
        ".#*",             // emacs lock
        "*.tmp",
        ".git/*",
    }
    // ... match against patterns
}
```

### 3. Watch Directories Recursively
fsnotify only watches direct children. Walk and add subdirectories:

```go
filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
    if info.IsDir() {
        watcher.Add(path)
    }
    return nil
})
```

### 4. Handle New Directories
When a directory is created, add it to the watch:

```go
if event.Op&fsnotify.Create == fsnotify.Create {
    if info, _ := os.Stat(event.Name); info.IsDir() {
        watcher.Add(event.Name)
    }
}
```

## Common Pitfalls

{{< hint warning >}}
**inotify Limits**
Watching thousands of directories can hit system limits. Increase `max_user_watches` or use fewer watches.
{{< /hint >}}

{{< hint warning >}}
**Rename Events**
Some editors save by renaming (write to temp, rename over original). Watch for both `Write` and `Rename` events.
{{< /hint >}}

{{< hint warning >}}
**Network Filesystems**
inotify doesn't work over NFS, CIFS, or FUSE. Use polling as fallback.
{{< /hint >}}

## Try It Yourself

1. Install: `go get github.com/fsnotify/fsnotify`
2. Run the basic watcher
3. In another terminal: `touch /tmp/watched/test.txt`
4. Modify the file: `echo "hello" >> /tmp/watched/test.txt`
5. Watch the events

## Related Patterns

- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Stop watchers cleanly
- [Daemonization]({{< relref "03-daemonization" >}}) - Background file watchers
