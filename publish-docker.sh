#!/usr/bin/env bash
#
# publish-docker.sh — build & push the aws-s3 plugin image to Docker Hub.
#
# Usage:
#   ./publish-docker.sh                    # build + push :<version> and :latest, multi-arch
#   IMAGE=foo/bar ./publish-docker.sh      # override image name
#   PLATFORMS=linux/amd64 ./publish-docker.sh   # single-arch
#   PUSH=0 ./publish-docker.sh             # build only, don't push
#   NO_LATEST=1 ./publish-docker.sh        # skip the :latest tag
#
# Prereqs on your machine:
#   - Docker Desktop (or dockerd) running
#   - docker buildx available  (comes with Docker Desktop)
#   - You're logged in:  docker login -u <dockerhub-user>
#
set -euo pipefail

IMAGE="${IMAGE:-vivek13186/daisy-plugin-aws-s3}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"
NO_LATEST="${NO_LATEST:-0}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to read version from package.json" >&2
  exit 1
fi
VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$VERSION" || "$VERSION" == "undefined" ]]; then
  echo "ERROR: could not read version from package.json" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI not found in PATH" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "ERROR: docker buildx is required (install Docker Desktop or the buildx plugin)" >&2
  exit 1
fi

BUILDER="daisy-plugin-builder"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo ">> creating buildx builder: $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use >/dev/null
else
  docker buildx use "$BUILDER" >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

TAG_LIST=("${IMAGE}:${VERSION}")
if [[ "$NO_LATEST" != "1" ]]; then
  TAG_LIST+=("${IMAGE}:latest")
fi
TAG_FLAGS=()
for t in "${TAG_LIST[@]}"; do
  TAG_FLAGS+=(--tag "$t")
done

PUSH_FLAG="--push"
if [[ "$PUSH" == "0" ]]; then
  PUSH_FLAG="--load"
  if [[ "$PLATFORMS" == *","* ]]; then
    echo ">> PUSH=0 requested; forcing single platform linux/amd64 (--load can't load multi-arch)"
    PLATFORMS="linux/amd64"
  fi
fi

echo ">> image:      $IMAGE"
echo ">> version:    $VERSION"
echo ">> platforms:  $PLATFORMS"
echo ">> tags:       ${TAG_LIST[*]}"
echo ">> action:     $([[ "$PUSH" == "1" ]] && echo push || echo build-only)"

if [[ "$PUSH" == "1" ]]; then
  if ! docker info 2>/dev/null | grep -q "Username:"; then
    echo ">> not logged in to Docker Hub — running: docker login"
    docker login
  fi
fi

docker buildx build \
  --platform "$PLATFORMS" \
  "${TAG_FLAGS[@]}" \
  --file Dockerfile \
  $PUSH_FLAG \
  .

echo ">> done."
if [[ "$PUSH" == "1" ]]; then
  echo ">> pulled with:  docker pull ${IMAGE}:${VERSION}"
  echo ">> hub page:     https://hub.docker.com/r/${IMAGE}"
fi
