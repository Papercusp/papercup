# syntax=docker/dockerfile:1
# P-058: extend the maintained, verified WSL/Server rootfs for a native build.
# Dockerfile.operator builds the legacy Node 20 web app and hardcodes x64 pty;
# the bootc image provisions a whole host. Neither is the sidecar build closure.
# Context: the directory containing verified papercup-runtime.tar.gz.
# Verify its receipt before building, then pin this builder's image ID before
# running the existing build-desktop-sidecar.sh producer on frozen source.
FROM scratch
ADD papercup-runtime.tar.gz /
ARG TARGETARCH
ARG BUILD_NODE_VERSION=25.9.0
ARG RUST_VERSION=1.97.1
ARG RUSTUP_VERSION=1.28.2
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN <<'NATIVE_BUILD'
# NATIVE_PREFLIGHT_BEGIN
case "$TARGETARCH" in
  amd64) node_arch=x64; rust_host=x86_64-unknown-linux-gnu ;;
  arm64) node_arch=arm64; rust_host=aarch64-unknown-linux-gnu ;;
  *) echo "ERROR: native builder requires amd64 or arm64" >&2; exit 2 ;;
esac
for version in "$BUILD_NODE_VERSION" "$RUST_VERSION" "$RUSTUP_VERSION"; do
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "ERROR: native builder toolchains require exact versions" >&2; exit 2;
  }
done
[[ "$(dpkg --print-architecture)" == "$TARGETARCH" \
   && "$(/usr/local/bin/node -p process.arch)" == "$node_arch" ]] || {
  echo "ERROR: native builder rootfs/process architecture differs from target" >&2; exit 2;
}
# NATIVE_PREFLIGHT_END
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends pkg-config libasound2-dev libssl-dev file rsync gh
rm -rf /var/lib/apt/lists/*
mkdir -p /opt/build-node /opt/cargo /opt/rustup /tmp/native-toolchains
cd /tmp/native-toolchains
archive="node-v${BUILD_NODE_VERSION}-linux-${node_arch}.tar.xz"
curl -fSsL "https://nodejs.org/dist/v${BUILD_NODE_VERSION}/${archive}" -o "$archive"
curl -fSsL "https://nodejs.org/dist/v${BUILD_NODE_VERSION}/SHASUMS256.txt" -o node-checksums
awk -v name="$archive" '$2 == name { print }' node-checksums > node-checksum
test "$(wc -l < node-checksum)" -eq 1
sha256sum -c node-checksum
tar -xJf "$archive" --strip-components=1 -C /opt/build-node
url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_host}/rustup-init"
curl -fSsL "$url" -o rustup-init
curl -fSsL "$url.sha256" -o rustup-checksum
sha256sum -c rustup-checksum
chmod +x rustup-init
CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup ./rustup-init -y --no-modify-path \
  --profile minimal --default-host "$rust_host" --default-toolchain "$RUST_VERSION"
CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup /opt/cargo/bin/rustup target add wasm32-wasip1
test "$(/opt/build-node/bin/node -p process.arch)" = "$node_arch"
test "$(/opt/build-node/bin/node --version)" = "v$BUILD_NODE_VERSION"
RUSTUP_HOME=/opt/rustup /opt/cargo/bin/rustc --version
cd /
rm -rf /tmp/native-toolchains
NATIVE_BUILD
# This builds audited Server releases from independent /product inputs. The
# audited pinned dogfood route supports both native architectures and already
# skips the unused development dependency generation after install. vm-release
# has a separate Linux-x64-only trust toolchain; do not select it for ARM64.
ENV PAPERCUSP_DISTRIBUTION_PROFILE=dogfood \
    PAPERCUSP_RELEASE_AUDIT=1 \
    PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT=/product \
    PATH=/opt/build-node/bin:/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RUSTUP_HOME=/opt/rustup
# Run as the source/output owner's UID with a separate writable HOME/CARGO_HOME.
# Do not mount host toolchains, dependencies, credentials or Docker's socket.
CMD ["bash"]
