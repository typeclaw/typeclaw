#!/usr/bin/env bash
# Acceptance check for the --ro-bind-data file-mask contract (appendMasks in
# src/sandbox/build.ts). Not a unit test: it needs the bubblewrap that actually
# ships in the base image, which the macOS dev host cannot provide and which
# `ubuntu-latest` does not match — so the bwrap-gated unit test silently skips
# on every CI runner we have.
#
# Why it exists: bwrap copies a --ro-bind-data operand out of its fd and then
# close()s it, so each mask needs its OWN fd. Sharing one appeared to work on
# bubblewrap <= 0.11.0 (the next mkstemp reclaimed the just-freed slot and
# copied the empty temp file onto itself) and hard-fails on 0.12.0 with
# "Can't write data to file <dest>: Bad file descriptor" — which aborts the
# WHOLE bwrap invocation, not just the mask, taking down every sandboxed bash
# call down to `echo`. That shipped in 0.48.8.
#
# `bubblewrap` is installed unpinned (BASELINE_APT_PACKAGES), so this behaviour
# can change under us on any base-image rebuild with no typeclaw commit. Wired
# into release.yml's merge-base job, which runs before the irreversible npm
# publish, so a bwrap that rejects our rendered command blocks the release.
#
# Asserts only the property we depend on — N masks over N distinct fds succeed
# and every target reads back empty. It deliberately does NOT assert that a
# SHARED fd fails: that pins upstream behaviour we neither control nor need.
#
# Usage: scripts/verify-mask-fd-sandbox.sh [image] [platform]
#   image    defaults to ghcr.io/typeclaw/typeclaw-base:<version-from-package.json>
#   platform e.g. linux/amd64; defaults to the daemon's native platform
set -euo pipefail

IMAGE="${1:-}"
PLATFORM="${2:-}"
if [ -z "$IMAGE" ]; then
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo latest)"
  IMAGE="ghcr.io/typeclaw/typeclaw-base:${version}"
fi

# Mirrors CANONICAL_AGENT_SECRET_FILES + CANONICAL_AGENT_RUNTIME_PRIVATE_FILES.
# The count is what matters here (one fd per mask); keep in sync if that grows.
runner='
set -u
d=/tmp/maskcheck
mkdir -p "$d"
for f in env secrets.json auth.json incidents.json; do printf CANARY > "$d/$f"; done

# The argv shape mirrors buildArgv()/appendMasks() in src/sandbox/build.ts:
# masks render after the broad parent bind, and the rendered commandString
# self-opens one /dev/null fd per masked file. Keep in sync if that changes.
set +e
out="$(bwrap --unshare-all \
      --new-session --die-with-parent --clearenv \
      --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C.UTF-8 \
      --ro-bind /usr /usr --ro-bind /etc /etc --dev /dev --tmpfs /tmp \
      --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
      --bind "$d" "$d" \
      --ro-bind-data 3 "$d/env" \
      --ro-bind-data 4 "$d/secrets.json" \
      --ro-bind-data 5 "$d/auth.json" \
      --ro-bind-data 6 "$d/incidents.json" \
      bash -c "cat $d/env $d/secrets.json $d/auth.json $d/incidents.json" \
      3</dev/null 4</dev/null 5</dev/null 6</dev/null 2>/tmp/maskcheck.err)"
rc=$?
set -e

echo "bwrap: $(bwrap --version)"
if [ $rc -ne 0 ]; then
  echo "MASK_BWRAP_FAILED rc=$rc"
  cat /tmp/maskcheck.err
  exit 1
fi
if [ -n "$out" ]; then
  echo "MASK_LEAKED: masked files were readable: [$out]"
  exit 1
fi
echo "MASK_CONTRACT_OK: 4 masks over 4 distinct fds, all empty"
'

echo "Image: $IMAGE${PLATFORM:+ ($PLATFORM)}"

# --pull=always plus an explicit platform, because the caller may have pulled
# several architectures under this one tag. The classic Docker image store maps
# a tag to exactly ONE image, so a preceding `docker pull --platform linux/amd64`
# followed by `--platform linux/arm64` leaves the tag on whichever came LAST.
# An unqualified `docker run` would then execute a foreign-arch image — and with
# no QEMU registered that dies on exec format, failing the release for a reason
# that has nothing to do with bwrap. Re-resolving the tag here keeps the check
# honest on both the classic and containerd image stores.
# --privileged so `bwrap --unshare-all` can actually build its namespaces here.
# The runners restrict namespace creation in layers, and each one aborts the
# invocation before a single mask is evaluated — so the step fails for reasons
# that say nothing about the contract under test: docker-default AppArmor denies
# the opening mount(NULL, "/", MS_SLAVE|MS_REC) ("Failed to make / slave"), and
# the loopback bring-up in the new netns fails RTM_NEWADDR "Operation not
# permitted" even with seccomp and AppArmor unconfined and NET_ADMIN added,
# because the restriction is on the user namespace that would confer it.
#
# This is scaffolding for a throwaway container running a known image inside the
# release pipeline, NOT a runtime capability grant — agent containers get
# seccomp=unconfined and nothing more. What the gate certifies is unchanged: the
# bwrap argv still mirrors buildArgv()/appendMasks(), and MASK_BWRAP_FAILED,
# MASK_LEAKED and MASK_CONTRACT_OK all still fail the release on a real break.
run_args=(--rm --pull=always --privileged)
if [ -n "$PLATFORM" ]; then
  run_args+=(--platform "$PLATFORM")
fi

docker run "${run_args[@]}" "$IMAGE" bash -c "$runner"
