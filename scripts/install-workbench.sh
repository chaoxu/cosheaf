#!/usr/bin/env bash
# Cosheaf Workbench Installer/Updater
#
# Downloads the latest pre-packed Cosheaf Workbench bundle from GitHub (default) or Gitea
# and installs (or updates) it on the local machine.
#
# Usage (GitHub):
#   curl -sSf https://raw.githubusercontent.com/chaoxu/cosheaf/main/scripts/install-workbench.sh | bash
#
# Usage (internal Gitea):
#   COSHEAF_GITEA_URL="http://gitea.lab" bash -c "$(curl -sSf http://gitea.lab/chaoxu/cosheaf/raw/branch/main/scripts/install-workbench.sh)"
#
# Custom target directory:
#   COSHEAF_WORKBENCH_DIR="~/my-workbench" bash install-workbench.sh

set -euo pipefail

# Configuration
REPO="${COSHEAF_REPO:-chaoxu/cosheaf}"
DEFAULT_DIR="$HOME/cosheaf-workbench"
TARGET_DIR="${COSHEAF_WORKBENCH_DIR:-$DEFAULT_DIR}"

# Expand ~ manually if present in TARGET_DIR
TARGET_DIR=$(eval echo "$TARGET_DIR")

echo "=== Cosheaf Workbench Installer ==="

# 1. Prerequisite checks
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is not installed."
  echo "Cosheaf Workbench requires Node.js >= 24."
  echo "Please install it (e.g. 'brew install node' or via nvm) and try again."
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "Error: 'tar' command not found. Please install tar and try again."
  exit 1
fi

NODE_VERSION=$(node -v)
echo "Found Node.js: $NODE_VERSION"

# 2. Determine host URL and headers based on environment
GITEA_URL="${COSHEAF_GITEA_URL:-}"
if [ -n "$GITEA_URL" ]; then
  API_URL="${GITEA_URL}/api/v1/repos/${REPO}/releases?limit=50"
  AUTH_HEADER_NAME="Authorization"
  AUTH_HEADER_VAL="${COSHEAF_GITEA_TOKEN:+token $COSHEAF_GITEA_TOKEN}"
  echo "Using internal Gitea instance: ${GITEA_URL}"
else
  API_URL="https://api.github.com/repos/${REPO}/releases"
  # Use GITHUB_TOKEN or COSHEAF_GITHUB_TOKEN if provided
  GITHUB_TOKEN="${GITHUB_TOKEN:-${COSHEAF_GITHUB_TOKEN:-}}"
  AUTH_HEADER_NAME="Authorization"
  AUTH_HEADER_VAL="${GITHUB_TOKEN:+Bearer $GITHUB_TOKEN}"
  echo "Using default repository: GitHub (${REPO})"
fi

# 3. Resolve the latest release using Node.js to parse the API response
echo "Resolving latest release..."

RESOLVED_RELEASE=$(node -e '
  const apiUrl = process.argv[1];
  const authHeaderName = process.argv[2];
  const authHeaderVal = process.argv[3];
  
  const headers = { "User-Agent": "cosheaf-workbench-installer" };
  if (authHeaderName && authHeaderVal) {
    headers[authHeaderName] = authHeaderVal;
  }
  
  (async () => {
    try {
      const res = await fetch(apiUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} when fetching releases`);
      const releases = await res.json();
      
      const release = releases.find(r => r.tag_name && r.tag_name.startsWith("workbench-"));
      if (!release) throw new Error("No workbench-* release found");
      const asset = (release.assets || []).find(a => a.name === "cosheaf-workbench.tar.gz");
      if (!asset) throw new Error(`Release ${release.tag_name} has no cosheaf-workbench.tar.gz asset`);
      
      console.log(JSON.stringify({
        tag: release.tag_name,
        downloadUrl: asset.browser_download_url
      }));
    } catch (err) {
      console.error("Error resolving release:", err.message);
      process.exit(1);
    }
  })();
' "$API_URL" "$AUTH_HEADER_NAME" "${AUTH_HEADER_VAL:-}")

TAG=$(echo "$RESOLVED_RELEASE" | node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  console.log(data.tag);
')

DOWNLOAD_URL=$(echo "$RESOLVED_RELEASE" | node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));
  console.log(data.downloadUrl);
')

echo "Latest release: $TAG"

# 4. Create a temporary staging directory on the same filesystem
PARENT_DIR=$(dirname "$TARGET_DIR")
mkdir -p "$PARENT_DIR"
STAGING_DIR=$(mktemp -d "$PARENT_DIR/.cosheaf-install-XXXXXX")

# Clean up staging directory on exit
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

TAR_PATH="$STAGING_DIR/bundle.tar.gz"

# 5. Download the tarball
echo "Downloading $TAG..."
node -e '
  const url = process.argv[1];
  const dest = process.argv[2];
  const authHeaderName = process.argv[3];
  const authHeaderVal = process.argv[4];
  const fs = require("fs");
  const { pipeline } = require("stream/promises");
  
  const headers = { "User-Agent": "cosheaf-workbench-installer" };
  if (authHeaderName && authHeaderVal) {
    headers[authHeaderName] = authHeaderVal;
  }
  
  (async () => {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} when downloading asset`);
      await pipeline(res.body, fs.createWriteStream(dest));
    } catch (err) {
      console.error("Download failed:", err.message);
      process.exit(1);
    }
  })();
' "$DOWNLOAD_URL" "$TAR_PATH" "$AUTH_HEADER_NAME" "${AUTH_HEADER_VAL:-}"

# 6. Extract tarball
echo "Extracting bundle..."
mkdir -p "$STAGING_DIR/extracted"
tar -xzf "$TAR_PATH" -C "$STAGING_DIR/extracted"

EXTRACTED_DIR="$STAGING_DIR/extracted/dist-workbench"
if [ ! -f "$EXTRACTED_DIR/cosheaf-workbench" ]; then
  echo "Error: Extracted bundle is missing the run shim (cosheaf-workbench)."
  exit 1
fi

# 7. Swap into place atomically
BACKUP_DIR="${TARGET_DIR}.bak"
if [ -d "$TARGET_DIR" ]; then
  echo "Updating existing installation at $TARGET_DIR..."
  if [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
  fi
  mv "$TARGET_DIR" "$BACKUP_DIR"
else
  echo "Installing to $TARGET_DIR..."
fi

mv "$EXTRACTED_DIR" "$TARGET_DIR"

# 8. Check if better-sqlite3 loads, and rebuild if needed
echo "Verifying better-sqlite3 compatibility..."
# We run a quick check import inside the target directory.
# Note: --input-type=module ensures we can use dynamic import() in ES context.
if ! (cd "$TARGET_DIR" && node --input-type=module -e "import Database from 'better-sqlite3'; new Database(':memory:')" >/dev/null 2>&1); then
  echo "Note: Node version or architecture mismatch detected for better-sqlite3."
  echo "Rebuilding better-sqlite3 native addon..."
  if command -v npm >/dev/null 2>&1; then
    (cd "$TARGET_DIR" && npm rebuild better-sqlite3)
  else
    echo "Warning: 'npm' command not found. Cannot rebuild better-sqlite3 automatically."
    echo "Please ensure npm is installed, then run: cd $TARGET_DIR && npm rebuild better-sqlite3"
  fi
else
  echo "better-sqlite3 is compatible."
fi

# 9. Bootstrap root CA certificate for internal .lab domains if in the fleet
if [[ "${GITEA_URL:-}" == *".lab"* ]] || [ -f /etc/lab-host ] || [ -d "$HOME/playground/fleet-infra" ]; then
  mkdir -p "$HOME/.cosheaf"
  if [ ! -f "$HOME/.cosheaf/caddy-lab-root.crt" ]; then
    echo "Downloading lab root CA certificate for HTTPS trust..."
    curl -sSf -o "$HOME/.cosheaf/caddy-lab-root.crt" http://100.93.22.80/caddy-lab-root.crt || true
  fi
fi

echo ""
echo "=== Installation Successful ==="
echo "Cosheaf Workbench $TAG has been installed to:"
echo "  $TARGET_DIR"
echo ""
echo "To run it, execute:"
echo "  $TARGET_DIR/cosheaf-workbench /path/to/your/markdown/folder"
echo ""
if [ -f "$HOME/.cosheaf/caddy-lab-root.crt" ]; then
  echo "Lab Environment Detected:"
  echo "  To allow Node.js to trust internal HTTPS .lab servers (e.g. gitea.lab, cosheaf.lab):"
  echo "  export NODE_EXTRA_CA_CERTS=\"\$HOME/.cosheaf/caddy-lab-root.crt\""
  echo "  (or set COSHEAF_CA_FILE=\"\$HOME/.cosheaf/caddy-lab-root.crt\" when running the bundle)"
  echo ""
fi
if [ -d "$BACKUP_DIR" ]; then
  echo "A backup of your previous installation was saved to:"
  echo "  $BACKUP_DIR"
  echo ""
fi
