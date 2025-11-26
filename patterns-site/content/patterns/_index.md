---
title: "Patterns"
weight: 1
bookFlatSection: true
---

# All Patterns

This section contains detailed documentation for each Linux & Go pattern. Each pattern includes complete, runnable code examples and explanations of the underlying OS concepts.

## Process Management

| Pattern | Description |
|---------|-------------|
| [Shell Wrapper]({{< relref "01-shell-wrapper" >}}) | Spawn subshells with modified environments |
| [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) | Handle signals and clean up resources |
| [Daemonization]({{< relref "03-daemonization" >}}) | Run processes in the background |

## File System

| Pattern | Description |
|---------|-------------|
| [File Locking]({{< relref "04-file-locking" >}}) | Synchronize access with flock |
| [Embedded Assets]({{< relref "07-embedded-assets" >}}) | Compile static files into binaries |
| [File Watching]({{< relref "11-file-watching" >}}) | React to filesystem changes |

## IPC & Networking

| Pattern | Description |
|---------|-------------|
| [PTY Control]({{< relref "05-pty-control" >}}) | Pseudo-terminal manipulation |
| [Stdin Detection]({{< relref "08-stdin-detection" >}}) | Detect piping vs interactive mode |
| [Unix Domain Sockets]({{< relref "10-unix-domain-sockets" >}}) | Local IPC with filesystem paths |

## Security & Isolation

| Pattern | Description |
|---------|-------------|
| [Namespaces]({{< relref "09-namespaces" >}}) | Lightweight process isolation |
| [LD_PRELOAD]({{< relref "12-ld-preload" >}}) | Dynamic library injection |
| [Memfd Execution]({{< relref "16-memfd-execution" >}}) | Fileless binary execution |

## Binary Manipulation

| Pattern | Description |
|---------|-------------|
| [Self-Updating]({{< relref "06-self-updating" >}}) | Binaries that update themselves |
| [Shim Executables]({{< relref "13-shim-executables" >}}) | Version manager entry points |
| [eBPF]({{< relref "14-ebpf" >}}) | Kernel-level instrumentation |
| [ELF Modification]({{< relref "15-elf-modification" >}}) | Post-build binary manipulation |
