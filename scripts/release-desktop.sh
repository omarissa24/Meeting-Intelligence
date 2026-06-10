#!/usr/bin/env bash
# Cut a desktop release: write the version into the committed config,
# commit, and tag. CI (desktop-release.yml) builds + drafts the GitHub
# release when the tag is pushed; publishing the draft is the go-live
# gate for downloads and auto-update.
#
# Usage: scripts/release-desktop.sh 1.2.0
#
# The committed tauri.conf.json `version` is the single source of truth;
# the CI guard refuses tags that don't match it. Plain MAJOR.MINOR.PATCH
# only — the backend's /updates semver comparison is deliberately strict.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 MAJOR.MINOR.PATCH (got: '${VERSION}')" >&2
  exit 1
fi

TAG="v${VERSION}"
CONF="apps/desktop/src-tauri/tauri.conf.json"
PKG="apps/desktop/package.json"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree not clean — commit or stash first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} already exists" >&2
  exit 1
fi

jq --arg v "$VERSION" '.version = $v' "$CONF" >"${CONF}.tmp" && mv "${CONF}.tmp" "$CONF"
jq --arg v "$VERSION" '.version = $v' "$PKG" >"${PKG}.tmp" && mv "${PKG}.tmp" "$PKG"
pnpm format >/dev/null 2>&1 || true

git add "$CONF" "$PKG"
git commit -m "release: desktop v${VERSION}"
git tag "$TAG"

echo
echo "Tagged ${TAG}. Next:"
echo "  git push origin main ${TAG}     # triggers desktop-release.yml"
echo "  …then publish the draft GitHub release to go live."
