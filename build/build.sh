#!/usr/bin/env bash
# Build ForgeOffice for delivery on Linux or macOS: build the Docker image and write the files a server
# needs to dist/.
#
#   build/build.sh                  build the image, write dist/
#   build/build.sh --same-build     don't bump the build number (the default is to bump it on every run)
#   build/build.sh --platform linux/arm64
#                                   build for another kind of server (needs Docker buildx; the
#                                   default is this machine's own)
#
# Needs: docker, zip. Output: dist/forgeoffice-<version>-build-<n>-<arch>.zip (<version> is "version"
# in package.json, <n> is build/BUILD_NUMBER, bumped by this script each run so filenames never collide).
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP=1
PLATFORM=""
while [ $# -gt 0 ]; do
    case "$1" in
        --same-build) BUMP=0 ;;
        --platform) shift; PLATFORM="${1:?--platform needs a value, e.g. linux/amd64}" ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

VERSION=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$VERSION" ] || { echo "Could not read \"version\" from package.json" >&2; exit 1; }
BUILD_NUMBER=$(cat build/BUILD_NUMBER 2>/dev/null || echo 0)
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || { echo "build/BUILD_NUMBER must hold a number" >&2; exit 1; }
if [ "$BUMP" = "1" ]; then
    BUILD_NUMBER=$((BUILD_NUMBER + 1))
    echo "$BUILD_NUMBER" > build/BUILD_NUMBER
    echo "==> Bumped the build number to ${BUILD_NUMBER} (--same-build skips this)"
fi
RELEASE="${VERSION}-build-${BUILD_NUMBER}"
IMAGE="forgeoffice/app:${RELEASE}"
echo "==> Building ForgeOffice ${RELEASE}"

if [ -n "$PLATFORM" ]; then
    docker buildx build --platform "$PLATFORM" --load -f docker/Dockerfile -t "$IMAGE" -t forgeoffice/app:latest .
else
    docker build -f docker/Dockerfile -t "$IMAGE" -t forgeoffice/app:latest .
fi
ARCH=$(docker image inspect -f '{{.Architecture}}' "$IMAGE")
NAME="forgeoffice-${RELEASE}-${ARCH}"

echo "==> Writing dist/${NAME}.zip"
STAGE="dist/${NAME}"
rm -rf "$STAGE" "dist/${NAME}.zip" && mkdir -p "$STAGE/docker/gateway" "$STAGE/docker/sites"
docker save "$IMAGE" | gzip -9 > "$STAGE/${NAME}.tar.gz"

# Everything on one server: the image comes from the file above, so the compose file doesn't build it
awk '/^  build:$/ { skip = 1; next } skip && /^    / { next } { skip = 0; print }' docker-compose.yml > "$STAGE/compose.yml"
# Parts of ForgeOffice on several servers: the gateway files sit next to it in the release
sed 's#\.\./\.\./docker/#./docker/#g' deploy/multi-host/docker-compose.yml > "$STAGE/compose.multi.yml"
cp docker/gateway/Caddyfile "$STAGE/docker/gateway/"
cp docker/Caddyfile "$STAGE/docker/"
cp docker/sites/README.md "$STAGE/docker/sites/"
{
    echo "# The release these files belong to"
    echo "FORGE_VERSION=${RELEASE}"
    echo "FORGE_IMAGE=${IMAGE}"
    echo
    cat .env.example
} > "$STAGE/env.example"
sed "s/@VERSION@/${RELEASE}/g; s/@ARCH@/${ARCH}/g" build/INSTALL.txt > "$STAGE/INSTALL.txt"
for script in install.sh uninstall.sh; do
    sed "s/@VERSION@/${RELEASE}/g" "build/$script" > "$STAGE/$script" && chmod +x "$STAGE/$script"
done
grep -q '^  build:$' "$STAGE/compose.yml" && { echo "compose.yml still builds the image" >&2; exit 1; }

( cd "$STAGE" && find . -type f ! -name SHA256SUMS | sort | xargs sha256sum > SHA256SUMS )
( cd dist && zip -rq "${NAME}.zip" "${NAME}" )
rm -rf "$STAGE"
echo
echo "Done. Copy this one file to the server (it holds the image, the compose files and install.sh):"
ls -lh "dist/${NAME}.zip"
