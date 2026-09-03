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
# seccomp=unconfined matches what agent containers get (`runArgs` in
# src/container/start.ts). apparmor=unconfined is a KNOWN, DELIBERATE DIVERGENCE
# from production, and it is load-bearing: measured on an ubuntu-24.04 runner
# against the 0.48.10 base image, `bwrap --unshare-all` cannot complete its
# opening mount(NULL, "/", MS_SLAVE|MS_REC) under Docker's docker-default
# AppArmor profile, and no runner-side sysctl changes that. Adding it is the
# only way this check runs at all on an AppArmor-enabled host.
#
# The divergence is not free: production does NOT pass apparmor=unconfined, so
# on an AppArmor-enabled Docker host the per-tool sandbox plausibly hits the
# same wall — which this gate would no longer catch. That is a product question
# about src/container/start.ts, not something to settle by picking flags here.
# Do NOT widen this further to make a runner go green; anything beyond these two
# (NET_ADMIN, --privileged) was measured to be unnecessary.
run_args=(--rm --pull=always --security-opt seccomp=unconfined --security-opt apparmor=unconfined)
if [ -n "$PLATFORM" ]; then
  run_args+=(--platform "$PLATFORM")
fi

docker run "${run_args[@]}" "$IMAGE" bash -c "$runner"
