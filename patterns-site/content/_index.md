---
title: "Linux & Go Patterns"
type: docs
---

# Linux & Go Patterns

A comprehensive guide to powerful system programming patterns found in advanced developer tools like `aws-vault`, `docker`, `terraform`, and more. These patterns leverage Linux internals and Go's runtime to create robust, interactive, and efficient CLI experiences.

## What You'll Learn

These patterns are the building blocks used by production-grade CLI tools. Each pattern includes:

- **Concept Overview** - What problem does this solve?
- **Linux Internals** - How does the kernel/OS enable this?
- **Go Implementation** - Complete, runnable code examples
- **Real-World Examples** - Which popular tools use this?
- **Best Practices** - Common pitfalls and how to avoid them

## Pattern Categories

{{< columns >}}
### Process Management
- [Shell Wrapper]({{< relref "/patterns/01-shell-wrapper" >}})
- [Graceful Shutdown]({{< relref "/patterns/02-graceful-shutdown" >}})
- [Daemonization]({{< relref "/patterns/03-daemonization" >}})

<--->

### File System
- [File Locking]({{< relref "/patterns/04-file-locking" >}})
- [File Watching]({{< relref "/patterns/11-file-watching" >}})
- [Embedded Assets]({{< relref "/patterns/07-embedded-assets" >}})
{{< /columns >}}

{{< columns >}}
### IPC & Networking
- [Unix Domain Sockets]({{< relref "/patterns/10-unix-domain-sockets" >}})
- [PTY Control]({{< relref "/patterns/05-pty-control" >}})
- [Stdin Detection]({{< relref "/patterns/08-stdin-detection" >}})

<--->

### Security & Isolation
- [Namespaces]({{< relref "/patterns/09-namespaces" >}})
- [LD_PRELOAD]({{< relref "/patterns/12-ld-preload" >}})
- [Memfd Execution]({{< relref "/patterns/16-memfd-execution" >}})
{{< /columns >}}

{{< columns >}}
### Binary Manipulation
- [Self-Updating]({{< relref "/patterns/06-self-updating" >}})
- [ELF Modification]({{< relref "/patterns/15-elf-modification" >}})
- [Shim Executables]({{< relref "/patterns/13-shim-executables" >}})
- [eBPF]({{< relref "/patterns/14-ebpf" >}})

<--->

{{< /columns >}}

## Getting Started

Browse the patterns using the sidebar navigation, or start with [Shell Wrapper]({{< relref "/patterns/01-shell-wrapper" >}}) to understand how tools like `aws-vault` spawn credential-injected subshells.
