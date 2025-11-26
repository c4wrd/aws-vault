---
title: "Embedded Assets"
weight: 7
---

# Embedded Build Artifacts

Compile static files (templates, configs, SQL migrations, web assets) directly into your Go binary for zero-dependency distribution.

## The Problem

Distributing a Go binary often means also distributing supporting files:
- Configuration templates
- SQL migration scripts
- HTML/CSS/JS for web UIs
- License files, default configs

This complicates installation and creates potential "file not found" errors if paths don't match.

## The Solution

Use Go's `//go:embed` directive to include files at compile time. The binary becomes entirely self-contained.

```
Build Time                          Runtime
┌──────────────────────┐           ┌──────────────────────┐
│ main.go              │           │ Single Binary        │
│ templates/           │ ────────▶ │ ┌──────────────────┐ │
│   └─ config.yaml     │   embed   │ │ Code             │ │
│   └─ init.sql        │           │ │ ────────────────  │ │
│ web/                 │           │ │ templates/       │ │
│   └─ index.html      │           │ │   config.yaml    │ │
└──────────────────────┘           │ │   init.sql       │ │
                                   │ │ web/             │ │
                                   │ │   index.html     │ │
                                   │ └──────────────────┘ │
                                   └──────────────────────┘
```

## Go Implementation

### Basic Embedding

```go
package main

import (
    _ "embed"
    "fmt"
)

//go:embed templates/config.yaml
var defaultConfig string

//go:embed templates/init.sql
var initSQL []byte

func main() {
    fmt.Println("Default Config:")
    fmt.Println(defaultConfig)

    fmt.Println("\nInit SQL:")
    fmt.Println(string(initSQL))
}
```

### Embedding Directories

```go
package main

import (
    "embed"
    "fmt"
    "io/fs"
)

//go:embed templates/*
var templatesFS embed.FS

//go:embed web/static/*
var staticFS embed.FS

func main() {
    // List all embedded files
    fs.WalkDir(templatesFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil {
            return err
        }
        fmt.Println(path)
        return nil
    })

    // Read a specific file
    content, _ := templatesFS.ReadFile("templates/config.yaml")
    fmt.Println(string(content))
}
```

### Serving Embedded Web Assets

```go
package main

import (
    "embed"
    "io/fs"
    "net/http"
)

//go:embed web/static
var staticFiles embed.FS

func main() {
    // Strip the "web/static" prefix for cleaner URLs
    staticFS, _ := fs.Sub(staticFiles, "web/static")

    http.Handle("/static/", http.StripPrefix("/static/",
        http.FileServer(http.FS(staticFS))))

    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Serve index.html from embedded files
        content, _ := staticFiles.ReadFile("web/static/index.html")
        w.Write(content)
    })

    http.ListenAndServe(":8080", nil)
}
```

### Embedding with Patterns

```go
package main

import (
    "embed"
)

// Embed all .sql files in migrations directory
//go:embed migrations/*.sql
var migrations embed.FS

// Embed all files recursively
//go:embed assets/*
var assets embed.FS

// Embed multiple patterns
//go:embed static/*.css static/*.js templates/*.html
var webAssets embed.FS

// Exclude certain files with all: prefix
//go:embed all:config/*
var configWithHidden embed.FS // Includes files starting with . or _
```

### Database Migrations

```go
package main

import (
    "database/sql"
    "embed"
    "fmt"
    "io/fs"
    "sort"
    "strings"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Migration struct {
    Name    string
    Content string
}

func loadMigrations() ([]Migration, error) {
    var migrations []Migration

    entries, err := migrationsFS.ReadDir("migrations")
    if err != nil {
        return nil, err
    }

    for _, entry := range entries {
        if !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }

        content, err := migrationsFS.ReadFile("migrations/" + entry.Name())
        if err != nil {
            return nil, err
        }

        migrations = append(migrations, Migration{
            Name:    entry.Name(),
            Content: string(content),
        })
    }

    // Sort by filename (001_init.sql, 002_users.sql, etc.)
    sort.Slice(migrations, func(i, j int) bool {
        return migrations[i].Name < migrations[j].Name
    })

    return migrations, nil
}

func runMigrations(db *sql.DB) error {
    migrations, err := loadMigrations()
    if err != nil {
        return err
    }

    for _, m := range migrations {
        fmt.Printf("Running migration: %s\n", m.Name)
        if _, err := db.Exec(m.Content); err != nil {
            return fmt.Errorf("migration %s failed: %w", m.Name, err)
        }
    }

    return nil
}
```

### HTML Templates

```go
package main

import (
    "embed"
    "html/template"
    "os"
)

//go:embed templates/*.html
var templateFS embed.FS

func main() {
    // Parse all templates from embedded filesystem
    tmpl, err := template.ParseFS(templateFS, "templates/*.html")
    if err != nil {
        panic(err)
    }

    data := map[string]string{
        "Title":   "Hello",
        "Content": "World",
    }

    tmpl.ExecuteTemplate(os.Stdout, "page.html", data)
}
```

## Real-World Examples

| Tool | Embedded Assets |
|------|-----------------|
| **Hugo** | Default themes |
| **Caddy** | Admin UI |
| **CockroachDB** | Web UI assets |
| **Terraform** | Provider schemas |

## Best Practices

### 1. Use `all:` for Hidden Files
By default, `//go:embed` skips files starting with `.` or `_`:

```go
//go:embed all:config/*     // Includes .env, _defaults.yaml
//go:embed config/*         // Skips hidden files
```

### 2. Organize Embedded Files
Keep embedded files in clearly named directories:

```
internal/
  embed/
    templates/
    migrations/
    static/
```

### 3. Provide Override Options
Let users provide their own files while defaulting to embedded:

```go
func loadConfig(customPath string) ([]byte, error) {
    if customPath != "" {
        return os.ReadFile(customPath)
    }
    return configFS.ReadFile("defaults/config.yaml")
}
```

### 4. Extract for Debugging
Allow extraction of embedded files for debugging:

```go
func extractEmbedded(destDir string) error {
    return fs.WalkDir(embeddedFS, ".", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }

        content, _ := embeddedFS.ReadFile(path)
        destPath := filepath.Join(destDir, path)
        os.MkdirAll(filepath.Dir(destPath), 0755)
        return os.WriteFile(destPath, content, 0644)
    })
}
```

## Common Pitfalls

{{< hint warning >}}
**Build Directory Matters**
Embedded paths are relative to the Go source file. If you move the source file, update the embed paths.
{{< /hint >}}

{{< hint warning >}}
**Binary Size**
Large assets increase binary size. Consider compression or loading from network for huge files.
{{< /hint >}}

{{< hint info >}}
**Read-Only**
Embedded files are read-only. You can't modify them at runtime—extract to a temp directory if needed.
{{< /hint >}}

## Embedding Version Info

Combine with `ldflags` for build metadata:

```go
package main

import (
    _ "embed"
    "fmt"
)

var (
    version = "dev"  // Set via -ldflags
    commit  = "none"
)

//go:embed VERSION
var embeddedVersion string

func main() {
    fmt.Printf("Version: %s (%s)\n", version, commit)
}
```

Build with:
```bash
go build -ldflags "-X main.version=1.0.0 -X main.commit=$(git rev-parse HEAD)"
```

## Try It Yourself

1. Create `templates/hello.txt` with content "Hello, embedded world!"
2. Add `//go:embed templates/hello.txt`
3. Print the content at runtime
4. Notice there's no `templates/` directory needed alongside the binary

## Related Patterns

- [Self-Updating]({{< relref "06-self-updating" >}}) - Embed version info for update checks
- [Shim Executables]({{< relref "13-shim-executables" >}}) - Embedded config for version detection
