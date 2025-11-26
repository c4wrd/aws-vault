---
title: "Unix Domain Sockets"
weight: 10
---

# Unix Domain Sockets (UDS)

Inter-process communication using filesystem paths instead of network ports—faster, more secure, and permission-controlled.

## The Problem

You need processes on the same machine to communicate:
- CLI client talking to a daemon
- Container runtime receiving commands
- Database local connections

TCP/IP works but has overhead and security concerns (any process can connect to a port).

## The Solution

Unix Domain Sockets use filesystem paths as addresses. They're:
- **Faster** - No network stack overhead
- **Secure** - File permissions control access
- **Simple** - Same socket API as TCP

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Client Process                     Server Process          │
│  ┌─────────────┐                   ┌─────────────┐          │
│  │ net.Dial    │                   │ net.Listen  │          │
│  │ "unix"      │                   │ "unix"      │          │
│  │ /tmp/my.sock├───────────────────▶/tmp/my.sock │          │
│  └─────────────┘                   └─────────────┘          │
│                                                             │
│  $ ls -la /tmp/my.sock                                      │
│  srwxr-xr-x 1 user user 0 Jan 1 00:00 /tmp/my.sock          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Linux Internals

### Socket Types

| Type | Description |
|------|-------------|
| `SOCK_STREAM` | Connection-oriented, like TCP |
| `SOCK_DGRAM` | Connectionless, like UDP |
| `SOCK_SEQPACKET` | Connection-oriented with message boundaries |

### File Permissions
The socket file has regular Unix permissions:

```bash
$ ls -la /var/run/docker.sock
srw-rw---- 1 root docker 0 Jan 1 00:00 /var/run/docker.sock
#  ^^ Only root and docker group can connect
```

### Abstract Sockets (Linux-specific)
Prefixing with `\0` creates a socket without a filesystem entry:

```go
net.Listen("unix", "\x00/tmp/my.sock")
```

Abstract sockets:
- Don't appear in filesystem
- Disappear automatically when server closes
- Not affected by file permissions

## Go Implementation

### Simple Server

```go
package main

import (
    "bufio"
    "fmt"
    "net"
    "os"
    "os/signal"
    "syscall"
)

const socketPath = "/tmp/myapp.sock"

func main() {
    // Clean up any existing socket
    os.Remove(socketPath)

    listener, err := net.Listen("unix", socketPath)
    if err != nil {
        fmt.Printf("Failed to listen: %v\n", err)
        os.Exit(1)
    }
    defer listener.Close()
    defer os.Remove(socketPath)

    // Handle shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
    go func() {
        <-sigCh
        listener.Close()
        os.Remove(socketPath)
        os.Exit(0)
    }()

    fmt.Printf("Listening on %s\n", socketPath)

    for {
        conn, err := listener.Accept()
        if err != nil {
            continue
        }
        go handleConnection(conn)
    }
}

func handleConnection(conn net.Conn) {
    defer conn.Close()

    scanner := bufio.NewScanner(conn)
    for scanner.Scan() {
        line := scanner.Text()
        fmt.Printf("Received: %s\n", line)

        response := fmt.Sprintf("Echo: %s\n", line)
        conn.Write([]byte(response))
    }
}
```

### Simple Client

```go
package main

import (
    "bufio"
    "fmt"
    "net"
    "os"
)

const socketPath = "/tmp/myapp.sock"

func main() {
    conn, err := net.Dial("unix", socketPath)
    if err != nil {
        fmt.Printf("Failed to connect: %v\n", err)
        os.Exit(1)
    }
    defer conn.Close()

    // Send message
    message := "Hello, server!\n"
    conn.Write([]byte(message))

    // Read response
    reader := bufio.NewReader(conn)
    response, _ := reader.ReadString('\n')
    fmt.Printf("Server says: %s", response)
}
```

### HTTP Over Unix Socket

```go
package main

import (
    "fmt"
    "net"
    "net/http"
    "os"
)

const socketPath = "/tmp/myhttp.sock"

func main() {
    os.Remove(socketPath)

    listener, _ := net.Listen("unix", socketPath)
    defer listener.Close()

    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Hello from Unix socket!")
    })

    http.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Path: %s\nMethod: %s\n", r.URL.Path, r.Method)
    })

    fmt.Println("HTTP server on", socketPath)
    http.Serve(listener, nil)
}
```

### HTTP Client Over Unix Socket

```go
package main

import (
    "context"
    "fmt"
    "io"
    "net"
    "net/http"
)

const socketPath = "/tmp/myhttp.sock"

func main() {
    client := &http.Client{
        Transport: &http.Transport{
            DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
                return net.Dial("unix", socketPath)
            },
        },
    }

    // The host in URL is ignored for Unix sockets
    resp, err := client.Get("http://unix/info")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        return
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Println(string(body))
}
```

### Passing File Descriptors

Unix sockets can pass file descriptors between processes:

```go
package main

import (
    "fmt"
    "net"
    "os"
    "syscall"
)

func sendFD(conn *net.UnixConn, file *os.File) error {
    rights := syscall.UnixRights(int(file.Fd()))
    _, _, err := conn.WriteMsgUnix([]byte("fd"), rights, nil)
    return err
}

func receiveFD(conn *net.UnixConn) (*os.File, error) {
    buf := make([]byte, 32)
    oob := make([]byte, 32)

    _, oobn, _, _, err := conn.ReadMsgUnix(buf, oob)
    if err != nil {
        return nil, err
    }

    msgs, err := syscall.ParseSocketControlMessage(oob[:oobn])
    if err != nil || len(msgs) == 0 {
        return nil, fmt.Errorf("no control message")
    }

    fds, err := syscall.ParseUnixRights(&msgs[0])
    if err != nil || len(fds) == 0 {
        return nil, fmt.Errorf("no file descriptor")
    }

    return os.NewFile(uintptr(fds[0]), "received"), nil
}
```

## Real-World Examples

| Tool | Socket Path |
|------|-------------|
| **Docker** | `/var/run/docker.sock` |
| **PostgreSQL** | `/var/run/postgresql/.s.PGSQL.5432` |
| **MySQL** | `/var/run/mysqld/mysqld.sock` |
| **SSH Agent** | `$SSH_AUTH_SOCK` |
| **systemd** | `/run/systemd/private` |

### Docker Socket Example

```go
package main

import (
    "context"
    "fmt"
    "io"
    "net"
    "net/http"
)

func main() {
    client := &http.Client{
        Transport: &http.Transport{
            DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
                return net.Dial("unix", "/var/run/docker.sock")
            },
        },
    }

    resp, _ := client.Get("http://docker/containers/json")
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Println(string(body))
}
```

## Best Practices

### 1. Clean Up Socket Files
Remove the socket file before listening and on exit:

```go
os.Remove(socketPath)
listener, _ := net.Listen("unix", socketPath)
defer os.Remove(socketPath)
```

### 2. Set Proper Permissions

```go
listener, _ := net.Listen("unix", socketPath)
os.Chmod(socketPath, 0600) // Owner only
```

### 3. Use Standard Paths

```go
// System service
"/var/run/myapp.sock"

// User service
filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "myapp.sock")

// Project-specific
filepath.Join(projectDir, ".myapp.sock")
```

### 4. Check Connection Credentials
Verify the connecting process's UID/GID:

```go
func getClientCreds(conn *net.UnixConn) (*syscall.Ucred, error) {
    raw, _ := conn.SyscallConn()
    var cred *syscall.Ucred

    raw.Control(func(fd uintptr) {
        cred, _ = syscall.GetsockoptUcred(int(fd),
            syscall.SOL_SOCKET, syscall.SO_PEERCRED)
    })

    return cred, nil
}
```

## Common Pitfalls

{{< hint warning >}}
**Stale Socket Files**
If a server crashes without cleanup, the socket file remains. Check if it's active before deleting.
{{< /hint >}}

{{< hint warning >}}
**Path Length Limit**
Socket paths are limited to ~100 characters on many systems. Use short paths or abstract sockets.
{{< /hint >}}

{{< hint danger >}}
**Security: Docker Socket Access**
Access to `/var/run/docker.sock` is essentially root access. Be very careful with socket permissions.
{{< /hint >}}

## Try It Yourself

1. Run the server in one terminal
2. Run the client in another
3. Check socket with `ls -la /tmp/myapp.sock`
4. Try connecting with `nc -U /tmp/myapp.sock`

## Related Patterns

- [Daemonization]({{< relref "03-daemonization" >}}) - Daemons typically expose Unix sockets
- [Namespaces]({{< relref "09-namespaces" >}}) - Sockets can cross namespace boundaries
- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Clean up sockets on exit
