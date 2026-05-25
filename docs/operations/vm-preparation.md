# VM Preparation — DevOps Instructions

**Audience:** the engineer responsible for provisioning and preparing
the Linux VM that will host the Assessment Co-Pilot pilot deployment.

**Goal:** when you are done, the application engineer should be able
to SSH into the VM and start the application deployment without
needing any further infrastructure changes from you.

This document covers **only the host-level prep**. The application
itself (Next.js web, BullMQ worker, Postgres, Redis, MinIO, PlantUML,
Caddy) runs entirely inside Docker containers and is brought up by
the application engineer in a separate step. You do **not** install
Node, pnpm, Postgres, or any application dependencies on the host.

---

## 1. VM specification

| Item | Value |
|---|---|
| vCPU | **4** |
| RAM | **16 GB** |
| Disk | **100 GB SSD** (root volume) |
| Architecture | **x86_64** (do not use ARM — some npm dependencies fall back to slow source compiles on ARM) |
| OS | **Ubuntu 22.04 LTS** or **24.04 LTS** |
| Public IP | **Static**, IPv4 |

Any cloud provider works (AWS EC2, Hetzner, DigitalOcean, OVH, Azure,
GCP). The steps below assume Ubuntu; adjust package names if you use
a different Debian-family distro.

---

## 2. Networking

### Inbound firewall

Open only:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (Caddy uses it for Let's Encrypt HTTP-01 challenge + auto-redirect to HTTPS) |
| 443 | TCP | HTTPS (the application) |

Block everything else. Postgres, Redis, MinIO, and PlantUML run on the
internal Docker network only and **must not** be exposed to the
public internet.

### Outbound

Unrestricted is simplest. If the customer requires an egress
allow-list, open 443 to these hosts:

- `api.anthropic.com` — AI calls
- `api.openai.com` — embeddings
- `acme-v02.api.letsencrypt.org` — TLS certificate issuance
- `github.com`, `raw.githubusercontent.com`, `codeload.github.com` —
  customer repository ingest + admin guide source fetch
- `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` —
  Docker image pulls during build
- `deb.debian.org`, `security.debian.org` — `apt` during image build

### DNS

Set up an **A record** for the hostname the customer will use
(e.g. `copilot.acme-pilot.com`) pointing at the VM's public IP.

This must be **in place and propagated** before the application
engineer starts their deployment. Caddy provisions the TLS
certificate automatically on first start, but the Let's Encrypt
challenge fails if DNS isn't ready, and there are rate limits on
repeated failures. Verify with `dig +short copilot.acme-pilot.com`
from an external network before handing over.

---

## 3. OS preparation

Run all of this as root or via `sudo`.

### Patches and basics

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg ufw
```

### Timezone and clock

```bash
timedatectl set-timezone UTC
timedatectl set-ntp true
timedatectl status   # confirm "System clock synchronized: yes"
```

Clock drift breaks TLS handshakes and session tokens — this is not
optional.

### Firewall (UFW)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

---

## 4. Docker installation

Use Docker's official apt repository — **not** the `docker.io` package
that ships with Ubuntu (it lags behind and lacks the Compose v2
plugin).

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

apt update
apt install -y docker-ce docker-ce-cli containerd.io \
                docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
docker --version
docker compose version
```

Both commands must succeed. Docker Engine should be **24.0 or newer**
and Compose plugin **2.20 or newer**.

### Log rotation for container logs

Container logs go through Docker's default `json-file` driver, which
does not rotate by default and will fill the disk over weeks. Add:

```bash
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
EOF
systemctl restart docker
```

This caps each container at 5 × 50 MB = 250 MB of log history.

---

## 5. Deploy user

Create a non-root user for the application engineer to use. Do **not**
let the deployment run as root.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
usermod -aG docker deploy

# SSH key access
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
# Paste the engineer's public key into the next file:
nano /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

### Lock down SSH

Edit `/etc/ssh/sshd_config` and ensure:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Then:

```bash
systemctl restart ssh
```

Verify from a separate terminal **before closing your current root
session** that you can SSH in as `deploy` and run `sudo -i`.

---

## 6. Filesystem layout

Create the working directories the application engineer will use:

```bash
mkdir -p /opt/copilot /opt/copilot/backups
chown -R deploy:deploy /opt/copilot
```

Layout the engineer will create:

```
/opt/copilot/
├── app/              ← extracted application tarball
└── backups/          ← nightly Postgres + MinIO dumps
```

---

## 7. Verification — what to confirm before hand-off

Run each of these and confirm the result. All must pass.

| # | Command | Expected |
|---|---|---|
| 1 | `ssh deploy@<host>` from the engineer's laptop | Logs in without password |
| 2 | `docker ps` as the `deploy` user (no sudo) | Empty list, no permission error |
| 3 | `docker compose version` as the `deploy` user | Reports v2.20+ |
| 4 | `id deploy` | Shows membership in `docker` and `sudo` groups |
| 5 | `ufw status` as root | Shows allow rules for 22, 80, 443 only |
| 6 | `dig +short copilot.<customer-domain>` from an external host | Returns the VM's public IP |
| 7 | `curl -I http://<vm-ip>` from an external host | TCP connects (response may be empty until the app starts) |
| 8 | `curl -I https://<vm-ip>` from an external host | TCP connects on 443 |
| 9 | `timedatectl` | `System clock synchronized: yes`, `NTP service: active` |
| 10 | `ls -ld /opt/copilot /opt/copilot/backups` | Both owned by `deploy:deploy` |
| 11 | `df -h /` | Shows ~100 GB available |
| 12 | `free -h` | Shows ~16 GB total RAM |

---

## 8. Hand-off package

Send the application engineer:

1. **VM hostname and public IP.**
2. **SSH command they can run from their laptop** — verified by you.
3. **The customer-facing hostname** (e.g. `copilot.acme-pilot.com`)
   and confirmation that its A record points at the VM.
4. **Confirmation that all 12 verification checks above pass.**
5. **Any egress-filtering rules you applied**, so the engineer knows
   what to debug if outbound calls fail unexpectedly.

The engineer will take it from there — no further infrastructure work
from you is required for the initial deployment.

---

## 9. What you are explicitly **not** doing

These are common reflexes that do **not** apply to this stack — skip
them:

- Do **not** install Node.js, pnpm, Yarn, or npm on the host.
- Do **not** install or run Postgres, Redis, or MinIO on the host
  directly. They run inside containers.
- Do **not** install Nginx or Apache. Caddy (in a container) is the
  reverse proxy and terminates TLS.
- Do **not** pre-create databases or database users. The application's
  migrator job initialises everything on first start.
- Do **not** request or install a TLS certificate manually. Caddy
  provisions it from Let's Encrypt on first start.
- Do **not** mount the application code or any volume from the host —
  the engineer will configure Docker named volumes via Compose.

---

## 10. Ongoing responsibilities (after deployment is live)

These are operational items the customer or the DevOps team should own
on a continuing basis. None blocks the initial deployment.

- **OS patching** — schedule `apt upgrade` monthly. The application is
  rebooted with `docker compose restart` after kernel-level patches
  that require a host reboot.
- **Disk monitoring** — alert if `df -h /` shows >80 % used. Postgres
  vector indexes and MinIO uploads are the growth drivers.
- **Off-box backup copy** — the application engineer will set up
  nightly dumps to `/opt/copilot/backups/`. Schedule a separate sync
  (rsync / S3 / Backblaze) to copy those dumps off the VM at least
  weekly. A backup on the same disk that fails is not a backup.
- **Uptime monitoring** — point an external probe (UptimeRobot,
  StatusCake, BetterStack) at `https://<hostname>/api/health` (the
  engineer will confirm the health endpoint path during deployment).
- **TLS renewal** — handled automatically by Caddy. No action needed
  unless the renewal logs show errors.
