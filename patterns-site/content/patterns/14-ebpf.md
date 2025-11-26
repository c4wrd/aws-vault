---
title: "eBPF"
weight: 14
---

# eBPF Instrumentation

Inject safe, sandboxed bytecode into the Linux kernel for high-performance observability, networking, and security without kernel modules.

## The Problem

You need deep system visibility or control:
- Trace all syscalls from a process
- Monitor network traffic at the kernel level
- Implement custom firewall rules
- Profile performance with minimal overhead

Kernel modules are risky and require maintenance. User-space polling is too slow.

## The Solution

**eBPF (extended Berkeley Packet Filter)** lets you run verified, sandboxed programs in the kernel. These programs attach to kernel events and run with near-native speed.

```
User Space                              Kernel Space
┌────────────────────────┐             ┌────────────────────────┐
│ Go Application         │             │                        │
│ ┌──────────────────┐   │   load      │  eBPF Bytecode         │
│ │ eBPF program     │───┼────────────▶│  ┌──────────────────┐  │
│ │ (compiled)       │   │             │  │ Attached to:     │  │
│ └──────────────────┘   │             │  │ - syscalls       │  │
│                        │             │  │ - network        │  │
│ ┌──────────────────┐   │   read      │  │ - tracepoints    │  │
│ │ Maps (shared     │◀──┼────────────▶│  └──────────────────┘  │
│ │ data)            │   │             │                        │
│ └──────────────────┘   │             │  Verifier ensures      │
│                        │             │  safety before running │
└────────────────────────┘             └────────────────────────┘
```

## Linux Internals

### eBPF Program Types

| Type | Attach Point | Use Case |
|------|--------------|----------|
| `BPF_PROG_TYPE_KPROBE` | Kernel functions | Tracing, debugging |
| `BPF_PROG_TYPE_TRACEPOINT` | Static kernel events | Stable tracing |
| `BPF_PROG_TYPE_XDP` | Network driver | Packet filtering/routing |
| `BPF_PROG_TYPE_SOCKET_FILTER` | Sockets | Packet capture |
| `BPF_PROG_TYPE_CGROUP_SKB` | Cgroup sockets | Container networking |

### The Verifier
Before loading, the kernel verifies your program:
- No loops (must terminate)
- No invalid memory access
- No unsafe operations
- Bounded execution time

### eBPF Maps
Shared data structures between eBPF and user space:
- **Hash maps** - Key-value storage
- **Arrays** - Index-based storage
- **Ring buffers** - Event streaming
- **Per-CPU maps** - Lock-free per-CPU data

## Go Implementation

### Using cilium/ebpf

First, write the eBPF program in C:

```c
// trace_exec.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct event {
    u32 pid;
    char comm[16];
};

// Ring buffer for events
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");

// Attach to execve syscall
SEC("tracepoint/syscalls/sys_enter_execve")
int trace_execve(struct trace_event_raw_sys_enter *ctx) {
    struct event *e;

    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) return 0;

    e->pid = bpf_get_current_pid_tgid() >> 32;
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

Compile with:
```bash
clang -O2 -target bpf -c trace_exec.c -o trace_exec.o
```

Go loader:

```go
package main

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "os"
    "os/signal"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go trace trace_exec.c

type Event struct {
    PID  uint32
    Comm [16]byte
}

func main() {
    // Load compiled eBPF program
    objs := traceObjects{}
    if err := loadTraceObjects(&objs, nil); err != nil {
        fmt.Printf("Loading eBPF: %v\n", err)
        os.Exit(1)
    }
    defer objs.Close()

    // Attach to tracepoint
    tp, err := link.Tracepoint("syscalls", "sys_enter_execve", objs.TraceExecve, nil)
    if err != nil {
        fmt.Printf("Attaching tracepoint: %v\n", err)
        os.Exit(1)
    }
    defer tp.Close()

    // Read events from ring buffer
    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        fmt.Printf("Creating reader: %v\n", err)
        os.Exit(1)
    }
    defer rd.Close()

    // Handle Ctrl+C
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, os.Interrupt)
    go func() {
        <-sig
        rd.Close()
    }()

    fmt.Println("Tracing execve calls... (Ctrl+C to stop)")

    for {
        record, err := rd.Read()
        if err != nil {
            break
        }

        var event Event
        binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &event)

        comm := string(bytes.TrimRight(event.Comm[:], "\x00"))
        fmt.Printf("PID %d executed: %s\n", event.PID, comm)
    }
}
```

### XDP Packet Filter

```c
// xdp_drop.c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <bpf/bpf_helpers.h>

SEC("xdp")
int xdp_drop_icmp(struct xdp_md *ctx) {
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (eth->h_proto != __constant_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Drop ICMP (ping)
    if (ip->protocol == IPPROTO_ICMP)
        return XDP_DROP;

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

### Counting with Maps

```c
// counter.c
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, u32);    // syscall number
    __type(value, u64);  // count
} syscall_counts SEC(".maps");

SEC("tracepoint/raw_syscalls/sys_enter")
int count_syscalls(struct trace_event_raw_sys_enter *ctx) {
    u32 syscall = ctx->id;
    u64 *count, init = 1;

    count = bpf_map_lookup_elem(&syscall_counts, &syscall);
    if (count) {
        __sync_fetch_and_add(count, 1);
    } else {
        bpf_map_update_elem(&syscall_counts, &syscall, &init, BPF_ANY);
    }

    return 0;
}
```

## Real-World Examples

| Tool | eBPF Use |
|------|----------|
| **Cilium** | Kubernetes networking & security |
| **Falco** | Runtime security monitoring |
| **bpftrace** | Dynamic tracing scripts |
| **Pixie** | Kubernetes observability |
| **Katran** | Facebook's load balancer |

## Best Practices

### 1. Use CO-RE (Compile Once, Run Everywhere)
Avoid kernel header dependencies:

```c
#include "vmlinux.h"  // BTF-generated headers
#include <bpf/bpf_core_read.h>

// Works across kernel versions
pid = BPF_CORE_READ(task, pid);
```

### 2. Use Ring Buffers for Events
More efficient than perf buffers:

```c
struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);
} events SEC(".maps");
```

### 3. Minimize Kernel Impact
eBPF runs in hot paths—keep programs small:

```c
// Bad: Complex logic in eBPF
// Good: Filter in eBPF, process in user space
```

### 4. Handle Verifier Errors
The verifier can be strict. Common fixes:
- Add bounds checks
- Use `bpf_probe_read_*` for pointers
- Limit loop unrolling

## Common Pitfalls

{{< hint warning >}}
**Kernel Version Requirements**
Different features require different kernel versions. Check compatibility before deploying.
{{< /hint >}}

{{< hint warning >}}
**BTF Availability**
CO-RE requires BTF (BPF Type Format). Check if your kernel has `/sys/kernel/btf/vmlinux`.
{{< /hint >}}

{{< hint danger >}}
**Performance Impact**
While eBPF is efficient, attaching to high-frequency events (like every syscall) can impact performance. Profile carefully.
{{< /hint >}}

## Prerequisites

```bash
# Install dependencies (Ubuntu)
sudo apt install clang llvm libelf-dev libbpf-dev

# Check BTF support
ls /sys/kernel/btf/vmlinux

# Check kernel version (5.8+ recommended)
uname -r
```

## Try It Yourself

1. Install cilium/ebpf: `go get github.com/cilium/ebpf`
2. Compile the eBPF program with clang
3. Generate Go bindings with bpf2go
4. Run and watch execve events

## Related Patterns

- [Namespaces]({{< relref "09-namespaces" >}}) - eBPF can work with cgroup namespaces
- [LD_PRELOAD]({{< relref "12-ld-preload" >}}) - User-space alternative for interception
