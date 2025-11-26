---
title: "LD_PRELOAD"
weight: 12
---

# LD_PRELOAD Injection

Force the dynamic linker to load a custom shared library before others, intercepting system calls without modifying the target binary.

## The Problem

You want to modify the behavior of a program without its source code:
- Mock network calls for testing
- Log all file operations
- Redirect files to different paths
- Inject debug hooks

Recompiling isn't an option. Kernel modules are too invasive.

## The Solution

Use `LD_PRELOAD` to load a custom shared library first. Functions in your library override libc functions, letting you intercept and modify behavior.

```
Without LD_PRELOAD              With LD_PRELOAD
┌─────────────────────┐        ┌─────────────────────┐
│ Application         │        │ Application         │
│      │              │        │      │              │
│      ▼              │        │      ▼              │
│ ┌─────────────────┐ │        │ ┌─────────────────┐ │
│ │ libc.so         │ │        │ │ mylib.so        │ │
│ │ open()          │ │        │ │ open() ──┐      │ │
│ │ read()          │ │        │ └──────────│──────┘ │
│ │ write()         │ │        │            ▼        │
│ └─────────────────┘ │        │ ┌─────────────────┐ │
│                     │        │ │ libc.so         │ │
│                     │        │ │ open()          │ │
│                     │        │ └─────────────────┘ │
└─────────────────────┘        └─────────────────────┘
```

## Linux Internals

### How Dynamic Linking Works
1. Program starts, kernel loads `ld.so` (dynamic linker)
2. `ld.so` reads `DT_NEEDED` entries to find required libraries
3. Libraries are loaded and symbols resolved
4. `LD_PRELOAD` libraries are loaded **first**

### Symbol Resolution
When the program calls `open()`:
1. Linker searches loaded libraries in order
2. First match wins
3. Your `open()` is found before libc's

### Calling the Original Function
Use `dlsym(RTLD_NEXT, "open")` to get the original function:

```c
static int (*real_open)(const char*, int, ...) = NULL;

int open(const char *path, int flags, ...) {
    if (!real_open) {
        real_open = dlsym(RTLD_NEXT, "open");
    }
    // Your logic here
    return real_open(path, flags);
}
```

## Implementation

### C Preload Library (hook_open.c)

```c
#define _GNU_SOURCE
#include <stdio.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <fcntl.h>

// Pointer to the real open function
static int (*real_open)(const char*, int, ...) = NULL;

// Our wrapper function
int open(const char *pathname, int flags, ...) {
    // Get the real open on first call
    if (!real_open) {
        real_open = dlsym(RTLD_NEXT, "open");
    }

    // Log the call
    fprintf(stderr, "[hook] open(\"%s\", %d)\n", pathname, flags);

    // Handle variadic argument for mode
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list args;
        va_start(args, flags);
        mode = va_arg(args, mode_t);
        va_end(args);
        return real_open(pathname, flags, mode);
    }

    return real_open(pathname, flags);
}
```

### Compile and Use

```bash
# Compile as shared library
gcc -shared -fPIC -o libhook.so hook_open.c -ldl

# Use with any program
LD_PRELOAD=./libhook.so cat /etc/passwd
# Output: [hook] open("/etc/passwd", 0)
#         root:x:0:0:...
```

### Redirect Files

```c
#define _GNU_SOURCE
#include <string.h>
#include <dlfcn.h>

static int (*real_open)(const char*, int, ...) = NULL;

int open(const char *pathname, int flags, ...) {
    if (!real_open) {
        real_open = dlsym(RTLD_NEXT, "open");
    }

    // Redirect /etc/passwd to our fake version
    if (strcmp(pathname, "/etc/passwd") == 0) {
        pathname = "/tmp/fake_passwd";
    }

    return real_open(pathname, flags);
}
```

### Mock Network Calls

```c
#define _GNU_SOURCE
#include <sys/socket.h>
#include <netinet/in.h>
#include <dlfcn.h>
#include <string.h>

static int (*real_connect)(int, const struct sockaddr*, socklen_t) = NULL;

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
    if (!real_connect) {
        real_connect = dlsym(RTLD_NEXT, "connect");
    }

    // Redirect connections to port 443 to localhost:8443
    if (addr->sa_family == AF_INET) {
        struct sockaddr_in *sin = (struct sockaddr_in*)addr;
        if (ntohs(sin->sin_port) == 443) {
            struct sockaddr_in new_addr = *sin;
            new_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            new_addr.sin_port = htons(8443);
            return real_connect(sockfd, (struct sockaddr*)&new_addr, addrlen);
        }
    }

    return real_connect(sockfd, addr, addrlen);
}
```

### Go Launcher for LD_PRELOAD

```go
package main

import (
    "os"
    "os/exec"
    "path/filepath"
)

func main() {
    if len(os.Args) < 2 {
        println("Usage: preload <command> [args...]")
        os.Exit(1)
    }

    // Get absolute path to our library
    libPath, _ := filepath.Abs("./libhook.so")

    cmd := exec.Command(os.Args[1], os.Args[2:]...)
    cmd.Env = append(os.Environ(), "LD_PRELOAD="+libPath)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    if err := cmd.Run(); err != nil {
        os.Exit(1)
    }
}
```

## Real-World Examples

| Tool | LD_PRELOAD Use |
|------|----------------|
| **faketime** | Mock time() for testing |
| **tsocks** | Transparently proxy through SOCKS |
| **electric-fence** | Memory debugging |
| **strace** | Uses ptrace, but LD_PRELOAD can log too |
| **jemalloc** | Replace memory allocator |

## Best Practices

### 1. Always Call the Real Function
Don't break the program—forward to the original:

```c
return real_open(pathname, flags, mode);
```

### 2. Thread Safety
Initialize function pointers atomically:

```c
#include <pthread.h>
static pthread_once_t init_once = PTHREAD_ONCE_INIT;

void init(void) {
    real_open = dlsym(RTLD_NEXT, "open");
}

int open(...) {
    pthread_once(&init_once, init);
    // ...
}
```

### 3. Handle All Variants
Programs might call `open64`, `openat`, etc.:

```c
int open64(const char *pathname, int flags, ...);
int openat(int dirfd, const char *pathname, int flags, ...);
```

### 4. Environment Propagation
Child processes don't inherit `LD_PRELOAD` by default with some wrappers.

## Common Pitfalls

{{< hint warning >}}
**setuid Binaries**
For security, the kernel ignores `LD_PRELOAD` for setuid/setgid binaries.
{{< /hint >}}

{{< hint warning >}}
**Static Binaries**
Statically linked binaries don't use dynamic linking—`LD_PRELOAD` has no effect.
{{< /hint >}}

{{< hint danger >}}
**Infinite Recursion**
If your hook calls a function that triggers your hook again, you'll crash. Be careful with logging.
{{< /hint >}}

{{< hint danger >}}
**Security Implications**
`LD_PRELOAD` can be used maliciously. Audit any preloaded libraries carefully.
{{< /hint >}}

## Go Note

Go programs are largely statically linked for Go code, but still use cgo for some operations. `LD_PRELOAD` affects cgo calls but not pure Go code.

For Go programs, consider using build-time dependency injection instead.

## Try It Yourself

1. Save the logging hook as `hook.c`
2. Compile: `gcc -shared -fPIC -o libhook.so hook.c -ldl`
3. Run: `LD_PRELOAD=./libhook.so cat /etc/hosts`
4. See the logged `open()` calls

## Related Patterns

- [Shim Executables]({{< relref "13-shim-executables" >}}) - Another interception approach
- [eBPF]({{< relref "14-ebpf" >}}) - Kernel-level interception
