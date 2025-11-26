---
title: "ELF Modification"
weight: 15
---

# ELF Binary Modification

Parse and alter compiled ELF binaries post-build for analysis, patching, or metadata injection.

## The Problem

You need to work with compiled binaries:
- Analyze what's inside an executable
- Inject build metadata or security tags
- Verify integrity before execution
- Patch binaries without recompiling

## The Solution

Use Go's `debug/elf` package to read and manipulate ELF (Executable and Linkable Format) files—the standard binary format on Linux.

```
┌─────────────────────────────────────────────────────────────┐
│ ELF Binary Structure                                        │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ ELF Header                                              │ │
│ │ - Magic: 0x7F 'E' 'L' 'F'                               │ │
│ │ - Class (32/64 bit)                                     │ │
│ │ - Entry point                                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Program Headers (Segments)                              │ │
│ │ - LOAD segments (code, data)                            │ │
│ │ - DYNAMIC (linking info)                                │ │
│ │ - INTERP (dynamic linker path)                          │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Section Headers (Sections)                              │ │
│ │ - .text (code)                                          │ │
│ │ - .data, .rodata (data)                                 │ │
│ │ - .symtab (symbols)                                     │ │
│ │ - .note.* (metadata)                                    │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Go Implementation

### Reading ELF Information

```go
package main

import (
    "debug/elf"
    "fmt"
    "os"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: elfinfo <binary>")
        os.Exit(1)
    }

    f, err := elf.Open(os.Args[1])
    if err != nil {
        fmt.Printf("Error opening ELF: %v\n", err)
        os.Exit(1)
    }
    defer f.Close()

    // Basic info
    fmt.Printf("Class:      %s\n", f.Class)
    fmt.Printf("Type:       %s\n", f.Type)
    fmt.Printf("Machine:    %s\n", f.Machine)
    fmt.Printf("Entry:      0x%x\n", f.Entry)
    fmt.Printf("ByteOrder:  %s\n", f.ByteOrder)

    // Sections
    fmt.Println("\nSections:")
    for _, s := range f.Sections {
        fmt.Printf("  %-20s Type=%-12s Size=%d\n",
            s.Name, s.Type, s.Size)
    }

    // Symbols
    symbols, err := f.Symbols()
    if err == nil {
        fmt.Printf("\nSymbols (%d):\n", len(symbols))
        for _, sym := range symbols[:min(10, len(symbols))] {
            fmt.Printf("  %s\n", sym.Name)
        }
        if len(symbols) > 10 {
            fmt.Printf("  ... and %d more\n", len(symbols)-10)
        }
    }
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}
```

### Finding Dynamic Dependencies

```go
package main

import (
    "debug/elf"
    "fmt"
    "os"
)

func main() {
    f, _ := elf.Open(os.Args[1])
    defer f.Close()

    // Get imported libraries
    libs, err := f.ImportedLibraries()
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        return
    }

    fmt.Println("Dynamic libraries:")
    for _, lib := range libs {
        fmt.Printf("  %s\n", lib)
    }

    // Get imported symbols
    symbols, err := f.ImportedSymbols()
    if err == nil {
        fmt.Println("\nImported symbols:")
        for _, sym := range symbols[:min(20, len(symbols))] {
            fmt.Printf("  %s (%s)\n", sym.Name, sym.Library)
        }
    }
}
```

### Extracting Embedded Data

```go
package main

import (
    "debug/elf"
    "fmt"
    "os"
)

func main() {
    f, _ := elf.Open(os.Args[1])
    defer f.Close()

    // Read .rodata section (read-only data, often contains strings)
    rodata := f.Section(".rodata")
    if rodata != nil {
        data, _ := rodata.Data()
        fmt.Printf(".rodata: %d bytes\n", len(data))

        // Find strings (printable sequences)
        findStrings(data, 4) // minimum length 4
    }

    // Read Go-specific sections
    gopclntab := f.Section(".gopclntab")
    if gopclntab != nil {
        fmt.Printf("\nGo pclntab found (%d bytes) - this is a Go binary\n",
            gopclntab.Size)
    }
}

func findStrings(data []byte, minLen int) {
    var current []byte
    for _, b := range data {
        if b >= 32 && b < 127 {
            current = append(current, b)
        } else {
            if len(current) >= minLen {
                fmt.Printf("  \"%s\"\n", string(current))
            }
            current = nil
        }
    }
}
```

### Detecting Binary Type

```go
package main

import (
    "debug/elf"
    "fmt"
    "os"
)

type BinaryInfo struct {
    IsGo     bool
    IsStatic bool
    IsPIE    bool
    HasDebug bool
}

func analyzeBinary(path string) (*BinaryInfo, error) {
    f, err := elf.Open(path)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    info := &BinaryInfo{}

    // Check for Go binary
    if f.Section(".gopclntab") != nil || f.Section(".go.buildinfo") != nil {
        info.IsGo = true
    }

    // Check if statically linked
    info.IsStatic = true
    for _, p := range f.Progs {
        if p.Type == elf.PT_INTERP {
            info.IsStatic = false
            break
        }
    }

    // Check if PIE (Position Independent Executable)
    if f.Type == elf.ET_DYN {
        info.IsPIE = true
    }

    // Check for debug info
    if f.Section(".debug_info") != nil || f.Section(".zdebug_info") != nil {
        info.HasDebug = true
    }

    return info, nil
}

func main() {
    info, err := analyzeBinary(os.Args[1])
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Go binary:    %v\n", info.IsGo)
    fmt.Printf("Static:       %v\n", info.IsStatic)
    fmt.Printf("PIE:          %v\n", info.IsPIE)
    fmt.Printf("Debug info:   %v\n", info.HasDebug)
}
```

### Reading Build Info from Go Binaries

```go
package main

import (
    "debug/buildinfo"
    "fmt"
    "os"
)

func main() {
    info, err := buildinfo.ReadFile(os.Args[1])
    if err != nil {
        fmt.Printf("Not a Go binary or error: %v\n", err)
        os.Exit(1)
    }

    fmt.Printf("Go version: %s\n", info.GoVersion)
    fmt.Printf("Path:       %s\n", info.Path)
    fmt.Printf("Main:       %s@%s\n", info.Main.Path, info.Main.Version)

    fmt.Println("\nDependencies:")
    for _, dep := range info.Deps {
        fmt.Printf("  %s@%s\n", dep.Path, dep.Version)
    }

    fmt.Println("\nBuild settings:")
    for _, s := range info.Settings {
        fmt.Printf("  %s=%s\n", s.Key, s.Value)
    }
}
```

### Adding Custom Sections (Note)

```go
package main

import (
    "bytes"
    "encoding/binary"
    "io"
    "os"
)

// Add a custom note section to an ELF binary
// This is a simplified example - production code needs more validation

type Note struct {
    Name string
    Desc []byte
    Type uint32
}

func addNote(input, output string, note Note) error {
    // Read original binary
    data, err := os.ReadFile(input)
    if err != nil {
        return err
    }

    // Build note section
    var noteBuf bytes.Buffer

    nameBytes := []byte(note.Name + "\x00")
    // Pad to 4-byte alignment
    for len(nameBytes)%4 != 0 {
        nameBytes = append(nameBytes, 0)
    }

    descBytes := note.Desc
    for len(descBytes)%4 != 0 {
        descBytes = append(descBytes, 0)
    }

    binary.Write(&noteBuf, binary.LittleEndian, uint32(len(note.Name)+1))
    binary.Write(&noteBuf, binary.LittleEndian, uint32(len(note.Desc)))
    binary.Write(&noteBuf, binary.LittleEndian, note.Type)
    noteBuf.Write(nameBytes)
    noteBuf.Write(descBytes)

    // In practice, you'd need to:
    // 1. Parse the ELF header
    // 2. Add a new section header
    // 3. Update section header count
    // 4. Append note data
    // 5. Update all offsets

    // This is complex - consider using a library like go-elf

    return nil
}
```

## Real-World Examples

| Tool | ELF Use |
|------|---------|
| **file** | Identify binary type |
| **readelf** | Display ELF info |
| **objdump** | Disassemble sections |
| **strip** | Remove symbols/debug info |
| **patchelf** | Modify rpath, interpreter |

### Common Analysis Tasks

```bash
# List sections
readelf -S binary

# List symbols
readelf -s binary

# Show dynamic dependencies
readelf -d binary | grep NEEDED

# Extract Go build info
go version -m binary
```

## Best Practices

### 1. Read-Only Analysis First
Only modify binaries when absolutely necessary:

```go
f, _ := elf.Open(path)  // Read-only
defer f.Close()
```

### 2. Validate Before Modification
Check binary integrity before and after:

```go
// Compute hash before
hashBefore := sha256sum(path)

// Make changes...

// Verify binary still works
cmd := exec.Command(path, "--version")
if err := cmd.Run(); err != nil {
    // Rollback
}
```

### 3. Preserve Section Alignment
ELF sections have alignment requirements:

```go
// Align to 4 bytes
for len(data)%4 != 0 {
    data = append(data, 0)
}
```

### 4. Use Established Libraries for Modification
`debug/elf` is read-only. For modification, consider:
- `github.com/Binject/debug/elf` (modified fork)
- External tools like `patchelf`

## Common Pitfalls

{{< hint warning >}}
**Code Signing**
Modifying signed binaries invalidates signatures. Plan accordingly.
{{< /hint >}}

{{< hint warning >}}
**Section vs Segment**
Sections are for linking; segments are for loading. Not all sections end up in segments.
{{< /hint >}}

{{< hint danger >}}
**Stripped Binaries**
Production binaries often lack symbols (`.symtab`). Use dynamic symbols (`.dynsym`) instead.
{{< /hint >}}

## Try It Yourself

1. Build a Go binary: `go build -o test ./main.go`
2. Run: `go run elfinfo.go test`
3. Compare with: `readelf -a test`
4. Try on system binaries: `/bin/ls`, `/usr/bin/git`

## Related Patterns

- [Self-Updating]({{< relref "06-self-updating" >}}) - Verify binary before replacing
- [Embedded Assets]({{< relref "07-embedded-assets" >}}) - Assets are stored in ELF sections
