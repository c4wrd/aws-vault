---
title: "Memfd Execution"
weight: 16
---

# Memfd Execution (Fileless)

Create memory-only files and execute binaries without touching the filesystem.

## The Problem

You want to run a binary without:
- Writing to disk (security, tmpfs limitations)
- Leaving traces in the filesystem
- Dealing with disk I/O latency
- Cleanup of temporary files

## The Solution

Use `memfd_create()` to create an anonymous file in memory. Write binary content to it, then execute directly from the file descriptor.

```
Traditional Execution                    Memfd Execution
┌──────────────────────────┐            ┌──────────────────────────┐
│ 1. Write to /tmp/binary  │            │ 1. memfd_create("prog")  │
│ 2. chmod +x              │            │    → fd 3                │
│ 3. exec /tmp/binary      │            │ 2. Write binary to fd    │
│ 4. rm /tmp/binary        │            │ 3. fexecve(fd, ...)      │
│                          │            │                          │
│ File visible on disk     │            │ Never touches disk       │
└──────────────────────────┘            └──────────────────────────┘
```

## Linux Internals

### memfd_create()
Creates an anonymous file backed by RAM:
- Returns a file descriptor
- File visible as `/proc/self/fd/N`
- Can be sealed (made immutable)
- Automatically cleaned up when FD closes

### fexecve()
Execute a program from a file descriptor:
- Available in glibc and via syscall
- File must be executable and seekable
- Replaces current process (like exec)

### Sealing
Prevent modifications with `fcntl(fd, F_ADD_SEALS, ...)`:
- `F_SEAL_WRITE` - No more writes
- `F_SEAL_SHRINK` - Can't shrink
- `F_SEAL_GROW` - Can't grow
- `F_SEAL_SEAL` - Can't add more seals

## Go Implementation

### Basic Memfd Execution

```go
package main

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// memfd_create syscall number (x86_64)
const SYS_MEMFD_CREATE = 319

// memfd_create flags
const (
    MFD_CLOEXEC       = 0x0001
    MFD_ALLOW_SEALING = 0x0002
)

func memfdCreate(name string, flags int) (int, error) {
    nameBytes := append([]byte(name), 0)

    fd, _, errno := syscall.Syscall(
        SYS_MEMFD_CREATE,
        uintptr(unsafe.Pointer(&nameBytes[0])),
        uintptr(flags),
        0,
    )

    if errno != 0 {
        return 0, errno
    }

    return int(fd), nil
}

func main() {
    // Read binary content (could come from network, embedded, etc.)
    binaryContent, err := os.ReadFile("/bin/echo")
    if err != nil {
        fmt.Printf("Error reading binary: %v\n", err)
        os.Exit(1)
    }

    // Create memfd
    fd, err := memfdCreate("myprogram", MFD_CLOEXEC)
    if err != nil {
        fmt.Printf("memfd_create failed: %v\n", err)
        os.Exit(1)
    }

    // Write binary content
    f := os.NewFile(uintptr(fd), "memfd")
    if _, err := f.Write(binaryContent); err != nil {
        fmt.Printf("Write failed: %v\n", err)
        os.Exit(1)
    }

    // Seek back to beginning
    f.Seek(0, 0)

    // Get path for exec
    fdPath := fmt.Sprintf("/proc/self/fd/%d", fd)

    // Execute
    err = syscall.Exec(fdPath, []string{"echo", "Hello from memfd!"}, os.Environ())
    if err != nil {
        fmt.Printf("Exec failed: %v\n", err)
        os.Exit(1)
    }
}
```

### With Sealing

```go
package main

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

const (
    SYS_MEMFD_CREATE  = 319
    MFD_CLOEXEC       = 0x0001
    MFD_ALLOW_SEALING = 0x0002

    F_ADD_SEALS  = 1033
    F_SEAL_WRITE = 0x0008
    F_SEAL_SEAL  = 0x0001
)

func memfdCreate(name string, flags int) (int, error) {
    nameBytes := append([]byte(name), 0)
    fd, _, errno := syscall.Syscall(
        SYS_MEMFD_CREATE,
        uintptr(unsafe.Pointer(&nameBytes[0])),
        uintptr(flags),
        0,
    )
    if errno != 0 {
        return 0, errno
    }
    return int(fd), nil
}

func sealFd(fd int) error {
    _, _, errno := syscall.Syscall(
        syscall.SYS_FCNTL,
        uintptr(fd),
        F_ADD_SEALS,
        F_SEAL_WRITE|F_SEAL_SEAL,
    )
    if errno != 0 {
        return errno
    }
    return nil
}

func main() {
    binary, _ := os.ReadFile("/bin/ls")

    // Create with sealing support
    fd, err := memfdCreate("sealed-program", MFD_CLOEXEC|MFD_ALLOW_SEALING)
    if err != nil {
        fmt.Printf("memfd_create: %v\n", err)
        os.Exit(1)
    }

    // Write binary
    f := os.NewFile(uintptr(fd), "memfd")
    f.Write(binary)
    f.Seek(0, 0)

    // Seal - no more modifications possible
    if err := sealFd(fd); err != nil {
        fmt.Printf("Sealing failed: %v\n", err)
    }

    fmt.Println("Binary is now sealed in memory")

    // Execute
    fdPath := fmt.Sprintf("/proc/self/fd/%d", fd)
    syscall.Exec(fdPath, []string{"ls", "-la"}, os.Environ())
}
```

### Subprocess with Memfd

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "syscall"
    "unsafe"
)

const SYS_MEMFD_CREATE = 319

func memfdCreate(name string) (int, error) {
    nameBytes := append([]byte(name), 0)
    fd, _, errno := syscall.Syscall(
        SYS_MEMFD_CREATE,
        uintptr(unsafe.Pointer(&nameBytes[0])),
        0, 0,
    )
    if errno != 0 {
        return 0, errno
    }
    return int(fd), nil
}

func runFromMemory(binaryContent []byte, args []string) error {
    fd, err := memfdCreate("subprocess")
    if err != nil {
        return err
    }

    f := os.NewFile(uintptr(fd), "memfd")
    defer f.Close()

    if _, err := f.Write(binaryContent); err != nil {
        return err
    }
    f.Seek(0, 0)

    fdPath := fmt.Sprintf("/proc/self/fd/%d", fd)

    cmd := exec.Command(fdPath, args...)
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    // Keep fd open across exec
    cmd.ExtraFiles = []*os.File{f}

    return cmd.Run()
}

func main() {
    // Read binary
    binary, _ := os.ReadFile("/bin/date")

    // Run from memory
    err := runFromMemory(binary, []string{"date"})
    if err != nil {
        fmt.Printf("Error: %v\n", err)
    }
}
```

## Real-World Examples

| Use Case | Description |
|----------|-------------|
| **Container runtimes** | Execute container init without disk |
| **Secure execution** | Run sensitive binaries without traces |
| **Network loaders** | Download and run without temp files |
| **Testing** | Run modified binaries in memory |

## Best Practices

### 1. Always Seal When Possible
Prevent tampering after writing:

```go
fd, _ := memfdCreate("prog", MFD_ALLOW_SEALING)
// Write content...
sealFd(fd, F_SEAL_WRITE | F_SEAL_SEAL)
```

### 2. Use MFD_CLOEXEC
Close the FD in child processes by default:

```go
fd, _ := memfdCreate("prog", MFD_CLOEXEC)
```

### 3. Verify Content Before Execution
Check signatures/hashes before running:

```go
hash := sha256.Sum256(binaryContent)
if hash != expectedHash {
    return errors.New("binary verification failed")
}
```

### 4. Clean Up on Error
The FD must be explicitly closed if exec fails:

```go
fd, _ := memfdCreate("prog", 0)
defer func() {
    if err != nil {
        syscall.Close(fd)
    }
}()
```

## Security Considerations

{{< hint warning >}}
**Detection**
While memfd execution leaves no files, it's still detectable via:
- `/proc/<pid>/exe` → `/memfd:name`
- `/proc/<pid>/fd/` entries
- Audit logs
{{< /hint >}}

{{< hint warning >}}
**Kernel Restrictions**
Some hardened systems restrict memfd execution. Check:
```bash
sysctl kernel.unprivileged_userns_clone
```
{{< /hint >}}

{{< hint danger >}}
**Malware Technique**
Memfd execution is commonly used by malware to avoid detection. Monitor for unexpected memfd activity in production.
{{< /hint >}}

## Limitations

1. **Linux only** - memfd_create is Linux-specific
2. **Kernel 3.17+** - Not available on older kernels
3. **Architecture dependent** - Syscall number varies
4. **Size limits** - Limited by available memory

## Alternative: Using /dev/shm

If memfd isn't available:

```go
// Create file in tmpfs (usually RAM-backed)
f, _ := os.CreateTemp("/dev/shm", "binary-*")
f.Write(binaryContent)
os.Chmod(f.Name(), 0700)

// Execute
exec.Command(f.Name(), args...).Run()

// Clean up
os.Remove(f.Name())
```

## Try It Yourself

1. Save the basic example
2. Run: `go run main.go`
3. Check for leftover files (there are none)
4. Look at `/proc/self/fd/` during execution

## Related Patterns

- [Embedded Assets]({{< relref "07-embedded-assets" >}}) - Source content for memfd
- [Self-Updating]({{< relref "06-self-updating" >}}) - Update and run without disk
- [Namespaces]({{< relref "09-namespaces" >}}) - Combine with mount namespace isolation
