#!/usr/bin/env bash
# Stage build context, build the image, push to ECR.
#
# Usage: build.sh <ecr_repository_url> <image_tag> <region>
#
# Assembles a minimal context (toda-clj/, toda-bb/, rigging-workshop/{deps.edn,clj/},
# plus the Dockerfile) under a temp dir so the build doesn't ship the
# entire ~/src/work tree to the docker daemon.

set -euo pipefail

ECR_URL="${1:?ecr repository url required}"
TAG="${2:?image tag required}"
REGION="${3:?region required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSHOP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PARENT_DIR="$(cd "$WORKSHOP_DIR/.." && pwd)"

for dep in "$PARENT_DIR/toda-clj" "$PARENT_DIR/toda-bb"; do
  [ -d "$dep" ] || { echo "missing sibling repo: $dep" >&2; exit 1; }
done

# Prep local-root deps that need Java compilation (toda-core has
# :deps/prep-lib). Runs on the host because b/git-count-revs needs .git
# and the host already has the clojure CLI configured.
#
# The container ships JDK 21 (clojure:temurin-21-* base image), so prep
# must use JDK 21 too — otherwise newer-JDK class files load with
# UnsupportedClassVersionError inside the container.
if command -v brew >/dev/null 2>&1 && brew --prefix openjdk@21 >/dev/null 2>&1; then
  export JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
  echo "using JAVA_HOME=$JAVA_HOME for prep" >&2
elif [ -z "${JAVA_HOME:-}" ]; then
  echo "warning: no openjdk@21 found via brew and JAVA_HOME unset; prep may emit class files the container can't load" >&2
fi

echo "running clojure -X:deps prep on $WORKSHOP_DIR" >&2
# Wipe stale prep output so leftover class files from a different JDK
# don't sneak into the image.
rm -rf "$PARENT_DIR/toda-clj/toda-core/target"
# prep needs the alias scope explicitly — local-root deps live under
# :server / :server-bb, not the base :deps map, so a bare `prep` is a no-op.
(cd "$WORKSHOP_DIR" && clojure -X:deps prep :aliases '[:server :server-bb]')

STAGE="$(mktemp -d -t rigworkshop-build-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

echo "staging build context in $STAGE" >&2

# Vendor sibling repos. rsync trims caches/git noise. target/classes is
# intentionally kept (prep output lives there); other target/ trees are
# JAR build artifacts we don't need but cost little to ship.
RSYNC_EXCLUDES=(
  --exclude=.git
  --exclude=.cpcache
  --exclude=.clj-kondo
  --exclude=.lsp
  --exclude=.idea
  --exclude=.DS_Store
)

rsync -a "${RSYNC_EXCLUDES[@]}" "$PARENT_DIR/toda-clj/" "$STAGE/toda-clj/"
rsync -a "${RSYNC_EXCLUDES[@]}" "$PARENT_DIR/toda-bb/"  "$STAGE/toda-bb/"

mkdir -p "$STAGE/rigging-workshop"
cp "$WORKSHOP_DIR/deps.edn" "$STAGE/rigging-workshop/deps.edn"
rsync -a "${RSYNC_EXCLUDES[@]}" "$WORKSHOP_DIR/clj/" "$STAGE/rigging-workshop/clj/"
cp "$WORKSHOP_DIR/Dockerfile" "$STAGE/Dockerfile"

REGISTRY="${ECR_URL%/*}"
echo "logging into $REGISTRY" >&2
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "building $ECR_URL:$TAG (linux/arm64)" >&2
docker build --platform=linux/arm64 -t "$ECR_URL:$TAG" "$STAGE"

echo "pushing $ECR_URL:$TAG" >&2
docker push "$ECR_URL:$TAG"

echo "done." >&2
