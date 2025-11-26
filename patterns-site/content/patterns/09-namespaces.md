---
title: "Namespaces"
weight: 9
---

# Namespaces (Lightweight Isolation)

Restrict a process's view of the system—network, filesystem, PIDs—without the overhead of full virtualization.

## The Problem

You need to:
- Run untrusted code in isolation
- Test networking without affecting the host
- Create reproducible build environments
- Sandbox processes with minimal overhead

Full VMs are heavyweight. Docker is complex for simple use cases. What's the primitive they're built on?

## The Solution

Linux **namespaces** partition kernel resources. A process in a namespace sees its own isolated view of that resource.

```
Host System                         Namespaced Process
┌────────────────────────────────────────────────────────┐
│ PIDs: 1, 2, 3, ... 50000         PIDs: 1, 2, 3        │
│ Network: eth0, 192.168.1.5       Network: lo only      │
│ Mounts: /, /home, /var           Mounts: /app          │
│ Hostname: server01               Hostname: sandbox     │
└────────────────────────────────────────────────────────┘
```

## Linux Internals

### Namespace Types

| Namespace | Isolates | Flag |
|-----------|----------|------|
| **PID** | Process IDs | `CLONE_NEWPID` |
| **NET** | Network stack | `CLONE_NEWNET` |
| **MNT** | Mount points | `CLONE_NEWNS` |
| **UTS** | Hostname | `CLONE_NEWUTS` |
| **IPC** | IPC mechanisms | `CLONE_NEWIPC` |
| **USER** | User/group IDs | `CLONE_NEWUSER` |
| **CGROUP** | Cgroup root | `CLONE_NEWCGROUP` |

### Creating Namespaces
Three ways to create:
1. `clone()` with namespace flags - new process in new namespace
2. `unshare()` - current process enters new namespace
3. `setns()` - join existing namespace

### Namespace Files
Each process's namespaces are visible at `/proc/<pid>/ns/`:

```bash
$ ls -la /proc/self/ns/
lrwxrwxrwx 1 user user 0 Jan 1 00:00 mnt -> 'mnt:[4026531840]'
lrwxrwxrwx 1 user user 0 Jan 1 00:00 net -> 'net:[4026531992]'
lrwxrwxrwx 1 user user 0 Jan 1 00:00 pid -> 'pid:[4026531836]'
```

The number in brackets is the namespace ID. Same ID = same namespace.

## Go Implementation

### Basic Namespace Isolation

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "syscall"
)

func main() {
    if len(os.Args) > 1 && os.Args[1] == "child" {
        runChild()
        return
    }

    runParent()
}

func runParent() {
    cmd := exec.Command("/proc/self/exe", "child")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWUTS |  // New hostname
                    syscall.CLONE_NEWPID |  // New PID namespace
                    syscall.CLONE_NEWNS,    // New mount namespace
    }

    if err := cmd.Run(); err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }
}

func runChild() {
    fmt.Println("Child process in new namespaces")

    // Set hostname in UTS namespace
    if err := syscall.Sethostname([]byte("container")); err != nil {
        fmt.Printf("Failed to set hostname: %v\n", err)
    }

    // In PID namespace, we're PID 1
    fmt.Printf("PID: %d\n", os.Getpid())

    hostname, _ := os.Hostname()
    fmt.Printf("Hostname: %s\n", hostname)

    // Run a shell
    cmd := exec.Command("/bin/sh")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Run()
}
```

{{< hint warning >}}
**Root Required**: Creating most namespaces requires root privileges. User namespaces (CLONE_NEWUSER) can be created by unprivileged users on some systems.
{{< /hint >}}

### Network Namespace Isolation

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "syscall"
)

func main() {
    if os.Args[1] == "child" {
        runInNetNS()
        return
    }

    // Create process in new network namespace
    cmd := exec.Command("/proc/self/exe", "child")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWNET,
    }

    cmd.Run()
}

func runInNetNS() {
    fmt.Println("In new network namespace")

    // Only loopback exists, and it's down by default
    cmd := exec.Command("ip", "link", "show")
    cmd.Stdout = os.Stdout
    cmd.Run()

    // Bring up loopback
    exec.Command("ip", "link", "set", "lo", "up").Run()

    fmt.Println("\nAfter bringing up loopback:")
    exec.Command("ip", "addr", "show").Run()

    // Network to host is completely isolated
    fmt.Println("\nTrying to ping host (will fail):")
    exec.Command("ping", "-c", "1", "8.8.8.8").Run()
}
```

### User Namespace (Unprivileged)

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "syscall"
)

func main() {
    if len(os.Args) > 1 && os.Args[1] == "child" {
        fmt.Printf("Inside user namespace:\n")
        fmt.Printf("UID: %d, GID: %d\n", os.Getuid(), os.Getgid())

        // We appear as root inside!
        exec.Command("id").Run()
        return
    }

    cmd := exec.Command("/proc/self/exe", "child")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWUSER,
        UidMappings: []syscall.SysProcIDMap{
            {
                ContainerID: 0,                // root inside container
                HostID:      os.Getuid(),      // maps to our UID
                Size:        1,
            },
        },
        GidMappings: []syscall.SysProcIDMap{
            {
                ContainerID: 0,
                HostID:      os.Getgid(),
                Size:        1,
            },
        },
    }

    fmt.Printf("Outside namespace - UID: %d\n", os.Getuid())
    cmd.Run()
}
```

### Mount Namespace with Pivot Root

```go
package main

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "syscall"
)

func main() {
    if os.Args[1] == "child" {
        setupRootfs()
        runChild()
        return
    }

    cmd := exec.Command("/proc/self/exe", "child")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWNS |
                    syscall.CLONE_NEWPID |
                    syscall.CLONE_NEWUTS,
    }

    cmd.Run()
}

func setupRootfs() {
    rootfs := "/tmp/container-root"

    // Make mount namespace private
    syscall.Mount("", "/", "", syscall.MS_PRIVATE|syscall.MS_REC, "")

    // Bind mount new root
    syscall.Mount(rootfs, rootfs, "", syscall.MS_BIND, "")

    // Create put_old directory
    putOld := filepath.Join(rootfs, ".pivot_root")
    os.MkdirAll(putOld, 0700)

    // Pivot root
    syscall.PivotRoot(rootfs, putOld)
    os.Chdir("/")

    // Unmount old root
    syscall.Unmount("/.pivot_root", syscall.MNT_DETACH)
    os.RemoveAll("/.pivot_root")

    // Mount proc
    os.MkdirAll("/proc", 0755)
    syscall.Mount("proc", "/proc", "proc", 0, "")
}

func runChild() {
    syscall.Sethostname([]byte("container"))

    cmd := exec.Command("/bin/sh")
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr
    cmd.Run()
}
```

## Real-World Examples

| Tool | Namespace Usage |
|------|-----------------|
| **Docker** | All namespaces for container isolation |
| **systemd-nspawn** | Lightweight container tool |
| **Flatpak** | App sandboxing |
| **Firejail** | Security sandboxing |
| **Chrome** | Renderer process sandboxing |

## Best Practices

### 1. Combine with Cgroups
Namespaces isolate visibility; cgroups limit resources:

```go
// Limit memory to 100MB
os.WriteFile("/sys/fs/cgroup/memory/mycontainer/memory.limit_in_bytes",
    []byte("100000000"), 0644)
```

### 2. Drop Capabilities
Even as "root" in a user namespace, drop unnecessary capabilities:

```go
cmd.SysProcAttr.AmbientCaps = []uintptr{}
```

### 3. Use Seccomp
Restrict syscalls the sandboxed process can make.

### 4. Mount tmpfs for Ephemeral Storage

```go
syscall.Mount("tmpfs", "/tmp", "tmpfs", 0, "size=64M")
```

## Common Pitfalls

{{< hint warning >}}
**PID 1 Responsibilities**
In a PID namespace, your process becomes init (PID 1). It must reap zombie processes.
{{< /hint >}}

{{< hint warning >}}
**Nested Namespaces**
User namespaces can create other namespaces without root. This is powerful but complex.
{{< /hint >}}

{{< hint danger >}}
**Escape Vulnerabilities**
Namespace isolation isn't perfect. Kernel vulnerabilities can allow escapes. Layer defenses.
{{< /hint >}}

## Try It Yourself

1. Save the UTS namespace example
2. Run with `sudo go run main.go`
3. Inside the shell, run `hostname`
4. Exit and check host's hostname is unchanged

## Related Patterns

- [Daemonization]({{< relref "03-daemonization" >}}) - Daemons often use namespaces
- [Unix Domain Sockets]({{< relref "10-unix-domain-sockets" >}}) - Communicate across namespace boundaries
