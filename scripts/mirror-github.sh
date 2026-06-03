#!/usr/bin/env bash
# Publish a clean Cosheaf tree snapshot to GitHub.
#
# This intentionally publishes a single clean tree commit instead of mirroring
# the active development history.
#
# Usage:
#   GITHUB_REPO=owner/name ./scripts/mirror-github.sh [--dry-run] [--yes]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GITHUB_REMOTE_NAME="${GITHUB_REMOTE_NAME:-github}"
GITHUB_REPO="${GITHUB_REPO:-}"
SOURCE_REF="${SOURCE_REF:-HEAD}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
DRY_RUN_FLAG=""
PUSH_ARGS=(--force --no-verify)
CONFIRM_NONINTERACTIVE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|-n)
      DRY_RUN_FLAG="--dry-run"
      PUSH_ARGS=(--dry-run --force --no-verify)
      ;;
    --yes)
      CONFIRM_NONINTERACTIVE=1
      ;;
    *)
      echo "Usage: $0 [--dry-run] [--yes]" >&2
      exit 1
      ;;
  esac
  shift
done

# GitHub is a clean public snapshot target, not the active development remote.
# Refuse unattended execution unless the caller explicitly confirms it.
if [ "$CONFIRM_NONINTERACTIVE" -ne 1 ] && [ ! -t 1 ]; then
  echo "Skipping non-interactive invocation without --yes."
  exit 0
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then
  if [ -z "$GITHUB_REPO" ]; then
    echo "Error: set GITHUB_REPO=owner/name when using GITHUB_TOKEN." >&2
    exit 1
  fi
  GITHUB_PUSH_TARGET="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
elif [ -n "$GITHUB_REPO" ]; then
  GITHUB_PUSH_TARGET="git@github.com:${GITHUB_REPO}.git"
elif git -C "$REPO_DIR" remote get-url "$GITHUB_REMOTE_NAME" >/dev/null 2>&1; then
  GITHUB_PUSH_TARGET="$(git -C "$REPO_DIR" remote get-url "$GITHUB_REMOTE_NAME")"
else
  echo "Error: set GITHUB_REPO=owner/name, GITHUB_TOKEN, or configure ${GITHUB_REMOTE_NAME}." >&2
  exit 1
fi

SOURCE_SHA="$(git -C "$REPO_DIR" rev-parse "$SOURCE_REF")"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cosheaf-github-snapshot.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

git -C "$REPO_DIR" archive "$SOURCE_SHA" | tar -x -C "$TMP_DIR"
git -C "$TMP_DIR" init -b "$TARGET_BRANCH" >/dev/null
git -C "$TMP_DIR" config user.name "${GIT_AUTHOR_NAME:-Cosheaf Snapshot Publisher}"
git -C "$TMP_DIR" config user.email "${GIT_AUTHOR_EMAIL:-actions@users.noreply.github.com}"
git -C "$TMP_DIR" add -A
git -C "$TMP_DIR" commit -m "Publish Cosheaf snapshot ${SOURCE_SHA:0:12}" >/dev/null

echo "Publishing clean snapshot ${SOURCE_SHA} to GitHub ${TARGET_BRANCH}"
git -C "$TMP_DIR" push "${PUSH_ARGS[@]}" "$GITHUB_PUSH_TARGET" "HEAD:refs/heads/${TARGET_BRANCH}"

if [ -n "$DRY_RUN_FLAG" ]; then
  echo "Dry run complete."
else
  echo "Published clean snapshot to GitHub."
fi
