---
title: "Self-Updating"
weight: 6
---

# Self-Updating Binaries

Build tools that can detect new versions and replace themselves on disk—enabling seamless updates outside of package managers.

## The Problem

CLI tools distributed as standalone binaries (not via apt, brew, etc.) need a way to update. Users shouldn't have to manually download and replace files.

## The Solution

The tool:
1. Checks for new versions (via API, GitHub releases, etc.)
2. Downloads the new binary to a temp location
3. Verifies integrity (checksum/signature)
4. Atomically replaces the running executable

```
┌──────────────────────────────────────────────────────────────┐
│ $ mytool update                                              │
│                                                              │
│ 1. Check version ────────────────────▶ GitHub API            │
│    Current: v1.0.0                       │                   │
│    Latest:  v1.1.0                       │                   │
│                     ◀────────────────────┘                   │
│                                                              │
│ 2. Download binary ──────────────────▶ /tmp/mytool-new       │
│                                                              │
│ 3. Verify checksum ──────────────────▶ SHA256 matches        │
│                                                              │
│ 4. Atomic replace ───────────────────▶ rename() to /usr/local/bin/mytool
│                                                              │
│ ✓ Updated to v1.1.0                                          │
└──────────────────────────────────────────────────────────────┘
```

## Linux Internals

### Why You Can't Overwrite a Running Binary
On Linux, you **can** `rename()` over an executing binary, but not write to it directly:

```bash
$ cp new_binary /usr/bin/running_binary
cp: cannot create regular file '/usr/bin/running_binary': Text file busy
```

This is because the kernel has the file mapped into memory.

### The `rename()` Trick
`rename()` is atomic and works differently:
- Creates a new directory entry pointing to the new file's inode
- The old inode remains valid for any running process
- New executions use the new file

```go
os.Rename("/tmp/new_binary", "/usr/local/bin/mytool")
```

### Inode Preservation
After rename, the old process continues running from the old inode (still in memory). The next execution loads the new inode.

## Go Implementation

### Basic Self-Updater

```go
package main

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
    "os"
    "runtime"
)

const (
    currentVersion = "1.0.0"
    updateURL      = "https://releases.example.com/mytool"
)

type Release struct {
    Version  string
    URL      string
    Checksum string
}

func main() {
    if len(os.Args) > 1 && os.Args[1] == "update" {
        if err := doUpdate(); err != nil {
            fmt.Printf("Update failed: %v\n", err)
            os.Exit(1)
        }
        return
    }

    fmt.Printf("mytool version %s\n", currentVersion)
}

func doUpdate() error {
    // 1. Check for new version
    release, err := checkLatestRelease()
    if err != nil {
        return fmt.Errorf("failed to check for updates: %w", err)
    }

    if release.Version == currentVersion {
        fmt.Println("Already up to date!")
        return nil
    }

    fmt.Printf("New version available: %s (current: %s)\n",
        release.Version, currentVersion)

    // 2. Download to temp file
    tmpFile, err := os.CreateTemp("", "mytool-update-*")
    if err != nil {
        return fmt.Errorf("failed to create temp file: %w", err)
    }
    tmpPath := tmpFile.Name()
    defer os.Remove(tmpPath) // Clean up on failure

    fmt.Println("Downloading...")
    if err := downloadFile(release.URL, tmpFile); err != nil {
        tmpFile.Close()
        return fmt.Errorf("download failed: %w", err)
    }
    tmpFile.Close()

    // 3. Verify checksum
    if err := verifyChecksum(tmpPath, release.Checksum); err != nil {
        return fmt.Errorf("checksum verification failed: %w", err)
    }
    fmt.Println("Checksum verified")

    // 4. Make executable
    if err := os.Chmod(tmpPath, 0755); err != nil {
        return fmt.Errorf("failed to set permissions: %w", err)
    }

    // 5. Get current executable path
    execPath, err := os.Executable()
    if err != nil {
        return fmt.Errorf("failed to get executable path: %w", err)
    }

    // 6. Atomic replace
    fmt.Println("Installing...")
    if err := os.Rename(tmpPath, execPath); err != nil {
        return fmt.Errorf("failed to replace binary: %w", err)
    }

    fmt.Printf("Updated to version %s\n", release.Version)
    return nil
}

func checkLatestRelease() (*Release, error) {
    // In reality, fetch from GitHub API or similar
    return &Release{
        Version:  "1.1.0",
        URL:      fmt.Sprintf("%s/%s/%s/mytool", updateURL, runtime.GOOS, runtime.GOARCH),
        Checksum: "abc123...",
    }, nil
}

func downloadFile(url string, dest *os.File) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("bad status: %s", resp.Status)
    }

    _, err = io.Copy(dest, resp.Body)
    return err
}

func verifyChecksum(path, expected string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    h := sha256.New()
    if _, err := io.Copy(h, f); err != nil {
        return err
    }

    actual := hex.EncodeToString(h.Sum(nil))
    if actual != expected {
        return fmt.Errorf("checksum mismatch: got %s, expected %s", actual, expected)
    }
    return nil
}
```

### Using go-selfupdate Library

```go
package main

import (
    "fmt"

    "github.com/blang/semver"
    "github.com/rhysd/go-selfupdate/selfupdate"
)

var version = "1.0.0"

func main() {
    if len(os.Args) > 1 && os.Args[1] == "update" {
        doUpdate()
        return
    }
    // Normal execution...
}

func doUpdate() {
    v := semver.MustParse(version)

    latest, found, err := selfupdate.DetectLatest("myorg/myrepo")
    if err != nil {
        fmt.Println("Error checking for updates:", err)
        return
    }

    if !found || latest.Version.LTE(v) {
        fmt.Println("Already up to date!")
        return
    }

    fmt.Printf("Updating to %s...\n", latest.Version)

    exe, err := os.Executable()
    if err != nil {
        fmt.Println("Could not find executable:", err)
        return
    }

    if err := selfupdate.UpdateTo(latest.AssetURL, exe); err != nil {
        fmt.Println("Update failed:", err)
        return
    }

    fmt.Println("Updated successfully!")
}
```

### GitHub Release Check

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "strings"
)

type GitHubRelease struct {
    TagName string `json:"tag_name"`
    Assets  []struct {
        Name               string `json:"name"`
        BrowserDownloadURL string `json:"browser_download_url"`
    } `json:"assets"`
}

func getLatestRelease(owner, repo string) (*GitHubRelease, error) {
    url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", owner, repo)

    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var release GitHubRelease
    if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
        return nil, err
    }

    return &release, nil
}

func findAsset(release *GitHubRelease, goos, goarch string) string {
    pattern := fmt.Sprintf("%s_%s", goos, goarch)
    for _, asset := range release.Assets {
        if strings.Contains(asset.Name, pattern) {
            return asset.BrowserDownloadURL
        }
    }
    return ""
}
```

## Real-World Examples

| Tool | Update Mechanism |
|------|------------------|
| **kubectl** | Plugins use self-update |
| **gh** (GitHub CLI) | `gh upgrade` |
| **docker-compose** | Self-update with checksums |
| **rustup** | `rustup self update` |

## Best Practices

### 1. Always Verify Checksums
Never trust downloaded binaries without verification:

```go
if !verifyChecksum(downloaded, expected) {
    return errors.New("checksum mismatch - possible tampering")
}
```

### 2. Sign Releases
For maximum security, use GPG or cosign signatures:

```bash
# Sign release
gpg --armor --detach-sign mytool

# Verify in code
exec.Command("gpg", "--verify", "mytool.asc", "mytool")
```

### 3. Support Rollback
Keep one backup version:

```go
backupPath := execPath + ".backup"
os.Rename(execPath, backupPath)
if err := os.Rename(tmpPath, execPath); err != nil {
    os.Rename(backupPath, execPath) // Rollback
    return err
}
```

### 4. Handle Permission Errors
Not all users can write to `/usr/local/bin`:

```go
if os.IsPermission(err) {
    fmt.Println("Permission denied. Try running with sudo.")
}
```

### 5. Check Version Before Download
Don't download if already current:

```go
if currentVersion == latestVersion {
    fmt.Println("Already up to date")
    return nil
}
```

## Common Pitfalls

{{< hint warning >}}
**Cross-Platform Paths**
On Windows, you can't rename over a running exe. Delete + rename or use a helper process.
{{< /hint >}}

{{< hint warning >}}
**Rate Limiting**
GitHub API has rate limits. Cache version checks or use authenticated requests.
{{< /hint >}}

{{< hint danger >}}
**Supply Chain Attacks**
If your update server is compromised, all users are at risk. Always verify checksums/signatures and consider code signing.
{{< /hint >}}

## Try It Yourself

1. Build with version: `go build -ldflags "-X main.version=1.0.0"`
2. Create a "new version" binary
3. Host it locally: `python -m http.server 8080`
4. Run `./mytool update` pointing to localhost

## Related Patterns

- [Embedded Assets]({{< relref "07-embedded-assets" >}}) - Embed version info at build time
- [Graceful Shutdown]({{< relref "02-graceful-shutdown" >}}) - Handle updates of running services
