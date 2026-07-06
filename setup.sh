#!/usr/bin/env bash
# setup.sh — Ubuntu VM host preparation (Assessment Co-Pilot pilot)
# Run via Azure: az vm run-command invoke ... --scripts @setup.sh

set -euo pipefail

# Make sure sbin tools (ufw, etc.) are found in every sub-shell.
export PATH="/usr/sbin:/sbin:${PATH}"

# ===========================================================================
# EDIT BEFORE RUN: paste the engineer's full single-line SSH public key here
# ===========================================================================
DEPLOY_SSH_KEY="PASTE_YOUR_SSH_PUBLIC_KEY_HERE"
# ---------------------------------------------------------------------------

readonly DEPLOY_USER="deploy"
readonly SSHD_CONFIG="/etc/ssh/sshd_config"
readonly DOCKER_DAEMON_JSON="/etc/docker/daemon.json"
readonly COPILOT_ROOT="/opt/copilot"
readonly COPILOT_BACKUPS="${COPILOT_ROOT}/backups"
readonly MIN_DOCKER_VERSION="24.0"
readonly MIN_COMPOSE_VERSION="2.20"

export DEBIAN_FRONTEND=noninteractive

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo ""; echo "==== $* ===="; }
version_ge() { local a="$1" b="$2"; [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n1)" == "$a" ]]; }

sshd_set_option() {
    local key="$1" value="$2"
    local escaped_key
    escaped_key="$(printf '%s' "$key" | sed 's/[][\.^$*]/\\&/g')"
    if grep -qE "^[[:space:]]*#?[[:space:]]*${escaped_key}([[:space:]]|$)" "$SSHD_CONFIG"; then
        sed -i -E "s/^[[:space:]]*#?[[:space:]]*${escaped_key}([[:space:]].*|$)/${key} ${value}/" "$SSHD_CONFIG"
    else
        printf '\n%s %s\n' "$key" "$value" >>"$SSHD_CONFIG"
    fi
}

# ---------------------------------------------------------------------------
step "Checking DEPLOY_SSH_KEY"
if [[ -z "${DEPLOY_SSH_KEY//[[:space:]]/}" ]] || [[ "${DEPLOY_SSH_KEY}" == "PASTE_YOUR_SSH_PUBLIC_KEY_HERE" ]]; then
    die "Set a real SSH key in the DEPLOY_SSH_KEY variable at the top of setup.sh."
fi
if [[ ${#DEPLOY_SSH_KEY} -lt 50 ]]; then
    die "DEPLOY_SSH_KEY is too short — paste the full public key line."
fi
if ! [[ "${DEPLOY_SSH_KEY}" =~ ^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp256)[[:space:]] ]]; then
    die "DEPLOY_SSH_KEY does not look like a public SSH key."
fi

if [[ ! -f /etc/os-release ]]; then die "/etc/os-release not found; this script targets Ubuntu."; fi

source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then die "Expected Ubuntu 22.04/24.04 LTS, found: ID=${ID:-unknown}."; fi
if [[ -z "${VERSION_CODENAME:-}" ]]; then die "VERSION_CODENAME is empty — cannot configure the Docker repository."; fi

step "Starting host preparation (Ubuntu ${VERSION_ID:-unknown}, ${VERSION_CODENAME})"

# ---------------------------------------------------------------------------
# 3. OS preparation
# ---------------------------------------------------------------------------
step "Updating packages and installing base utilities"
apt-get update -qq
apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" -qq
apt-get install -y -qq ca-certificates curl gnupg ufw

step "UTC timezone and NTP sync"
timedatectl set-timezone UTC
timedatectl set-ntp true
timedatectl status

step "Configuring UFW (only 22, 80, 443)"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
echo "y" | ufw enable
ufw status verbose

# ---------------------------------------------------------------------------
# 4. Docker (official repository, not docker.io)
# ---------------------------------------------------------------------------
step "Docker: adding the official apt repository"
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
fi

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF

step "Docker: installing Engine and Compose plugin"
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
COMPOSE_VER="$(docker compose version --short 2>/dev/null || true)"
echo "Docker Engine: ${DOCKER_VER:-unknown}"
echo "Docker Compose: ${COMPOSE_VER:-unknown}"

[[ -n "${DOCKER_VER}" ]] || die "Docker Engine did not start."
version_ge "$DOCKER_VER" "$MIN_DOCKER_VERSION" || die "Need Docker Engine >= ${MIN_DOCKER_VERSION}, installed: ${DOCKER_VER}."
[[ -n "${COMPOSE_VER}" ]] || die "Docker Compose plugin not found."
version_ge "$COMPOSE_VER" "$MIN_COMPOSE_VERSION" || die "Need Compose >= ${MIN_COMPOSE_VERSION}, installed: ${COMPOSE_VER}."

step "Docker: container log rotation (daemon.json)"
install -m 0755 -d /etc/docker
cat >"$DOCKER_DAEMON_JSON" <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
EOF
systemctl restart docker
sleep 2
systemctl is-active --quiet docker || die "Docker did not start after applying daemon.json."

# ---------------------------------------------------------------------------
# 5. Deploy user + SSH hardening
# ---------------------------------------------------------------------------
step "deploy user: create and add to sudo, docker groups"
if ! id "$DEPLOY_USER" &>/dev/null; then
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG sudo "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"

step "deploy user: installing SSH key"
DEPLOY_SSH_DIR="/home/${DEPLOY_USER}/.ssh"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_SSH_DIR"
printf '%s\n' "$DEPLOY_SSH_KEY" >"${DEPLOY_SSH_DIR}/authorized_keys"
chmod 600 "${DEPLOY_SSH_DIR}/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "${DEPLOY_SSH_DIR}/authorized_keys"

step "SSH: hardening sshd_config (sed, with backup)"
SSHD_BACKUP="${SSHD_CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
cp -a "$SSHD_CONFIG" "$SSHD_BACKUP"
echo "Backup: ${SSHD_BACKUP}"

sshd_set_option "PermitRootLogin" "no"
sshd_set_option "PasswordAuthentication" "no"
sshd_set_option "PubkeyAuthentication" "yes"

sshd -t 2>/dev/null || die "sshd -t failed; restore the config from ${SSHD_BACKUP}."
systemctl restart ssh

# ---------------------------------------------------------------------------
# 6. Filesystem layout
# ---------------------------------------------------------------------------
step "Filesystem: /opt/copilot and /opt/copilot/backups"
mkdir -p "$COPILOT_ROOT" "$COPILOT_BACKUPS"
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "$COPILOT_ROOT"

# ---------------------------------------------------------------------------
# 7. On-VM verification
# ---------------------------------------------------------------------------
step "On-VM verification (items 2-5, 9-12 from vm-preparation.md)"
PASS=0
FAIL=0

check() {
    local name="$1"
    shift
    if bash -c "$*"; then
        echo "[PASS] ${name}"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] ${name}"
        FAIL=$((FAIL + 1))
    fi
}

check "deploy in docker and sudo groups" "id ${DEPLOY_USER} | grep -q docker && id ${DEPLOY_USER} | grep -q sudo"
check "deploy: docker ps without sudo" "runuser -u ${DEPLOY_USER} -- docker ps >/dev/null 2>&1"
check "deploy: docker compose >= ${MIN_COMPOSE_VERSION}" "v=\$(runuser -u ${DEPLOY_USER} -- docker compose version --short 2>/dev/null) && [[ -n \"\$v\" ]] && printf '%s\n%s\n' \"${MIN_COMPOSE_VERSION}\" \"\$v\" | sort -C -V"
check "UFW: rules for 22, 80, 443" "u=\$(/usr/sbin/ufw status 2>/dev/null); grep -q '22' <<<\"\$u\" && grep -q '80' <<<\"\$u\" && grep -q '443' <<<\"\$u\""
check "timedatectl: sync and NTP" "timedatectl | grep -q 'System clock synchronized: yes' && timedatectl | grep -q 'NTP service: active'"
check "/opt/copilot owned by deploy" "[[ \$(stat -c '%U:%G' ${COPILOT_ROOT}) == '${DEPLOY_USER}:${DEPLOY_USER}' ]]"
check "/opt/copilot/backups owned by deploy" "[[ \$(stat -c '%U:%G' ${COPILOT_BACKUPS}) == '${DEPLOY_USER}:${DEPLOY_USER}' ]]"

echo ""
df -h /
echo ""
free -h

step "Summary"
echo "Passed: ${PASS}, errors: ${FAIL}"
echo "Manual steps before hand-off: SSH as deploy from your laptop, DNS A record, curl :80/:443 from outside."
[[ "$FAIL" -eq 0 ]] || die "Not all on-VM checks passed (${FAIL})."

echo "Host preparation completed successfully."
exit 0
