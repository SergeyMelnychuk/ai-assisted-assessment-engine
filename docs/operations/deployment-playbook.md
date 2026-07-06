# Deployment Playbook — Single VM, VPN-only, End to End

This is the **complete, repeatable, hand-holding guide** to deploying
Assessment Co-Pilot to one Linux VM, exactly the way it was deployed
for the `copilot.planatechnologies.io` pilot. It is written so that
someone who is **not** a developer can follow it start to finish.

If a step ever fails, jump to **Part 13 — Troubleshooting**. Every
problem we actually hit during the first deployment is listed there
with the fix.

---

## How to read this guide

Every command has a **tag** telling you *where* to run it:

| Tag | Where you run it |
|---|---|
| 📍 **LAPTOP** | A terminal on your own Mac/PC |
| 📍 **VM** | Inside the server, after you connect to it with SSH |

After most commands you'll see a **"✅ What success looks like"** box.
If your screen matches it, continue. If it doesn't, don't push
forward — check Part 13.

**How to tell which machine you're on:** look at the start of the
line where you type (the "prompt").

| Prompt looks like… | You are on… |
|---|---|
| your name, `~ %`, or `$` — **no** `@server` part | **LAPTOP** |
| something like `deploy@<server-name>:~$` — has `@` and a name | **VM** |

The name after `@` on the VM will be whatever your server was named,
so it won't match any example here exactly — the real signal is that
a VM prompt has `deploy@` plus a name, while your laptop prompt has no
`@server` part. Before you type any command, glance at the prompt.
Running a VM command on your laptop (or vice-versa) is the single most
common mistake — usually harmless, always confusing.

> **On Windows:** this guide assumes a Unix-style shell (paths like
> `~/.ssh`, aliases in `~/.zshrc`). Run every 📍 LAPTOP command from
> **WSL (Ubuntu)** or **Git Bash**, where `ssh`, `scp`, `curl`, and
> `tar` work. Plain PowerShell/CMD will not work with these commands
> as written.

---

## Part 0 — The big picture (read this once)

### What the application is made of

The app is not one program — it's **seven small programs** ("containers")
that run side by side on the one server. You don't install them one
by one; a tool called **Docker** runs them all from a single recipe
file. The seven:

| Container | Plain-English job |
|---|---|
| **web** | The website itself — what users see in the browser |
| **worker** | The "back office" — does slow jobs (reading documents, running AI analysis, building reports) |
| **postgres** | The database — stores all the real data |
| **redis** | A to-do list the worker pulls jobs from |
| **minio** | File storage — uploaded documents, generated reports |
| **plantuml** | Draws diagrams |
| **caddy** | The front door — handles the web address and the padlock (HTTPS/TLS) |

You will start and stop these as a group with **Docker Compose**
commands. You don't need to understand Docker deeply — just copy the
commands exactly.

### Two AI providers (important)

The app uses **two different AI companies for two different jobs**:

- **Anthropic (Claude)** — does the *thinking*: findings, risks,
  recommendations, scoring, report writing.
- **OpenAI** — does the *search indexing* ("embeddings"): turning
  documents into numbers so the app can find relevant text.

Anthropic does not offer the search-indexing service, so OpenAI is
used for that one job. **You need funded accounts at BOTH**, or parts
of the app fail. (This surprised us during the pilot — see Part 13.)

### Why this deployment is "VPN-only"

Pilot customers reach the app **through a company VPN**, not the open
internet. The server's firewall only allows VPN traffic. This is more
secure, but it changes one thing: the normal way of getting the HTTPS
padlock (Let's Encrypt reaching the server on port 80) doesn't work,
because the server isn't reachable from the public internet. We solve
this with a method called **DNS-01** (Part 4). Don't worry about the
details yet — just know *why* there's an extra AWS step later.

### The three "places" involved

1. **The VM** — a Linux server in Microsoft Azure. This is where the
   app runs.
2. **Your laptop** — where the source code lives and where you build
   the deployment package.
3. **DNS (Amazon Route 53)** — the internet's address book. It maps
   the web address (`copilot.planatechnologies.io`) to the server, and
   it's also used to prove ownership for the HTTPS padlock.

### Who does what (roles)

| Role | Responsibility |
|---|---|
| **DevOps person** | Creates the VM, opens the right firewall ports, runs the one-time server setup script, creates an AWS key for the padlock. |
| **You (the deployer)** | Everything else: prepare the code on your laptop, package it, send it to the server, run the deployment commands. |

You can be both people. The guide separates them so you know which
parts to hand off if someone else manages infrastructure.

### How long it takes

- First-ever deployment: **1.5–3 hours** (mostly waiting for builds
  and DNS).
- A later update (re-deploy): **15–20 minutes**.

---

## Part 1 — Before you start: gather these

Tick every box before you begin. Missing one mid-way is the main
cause of getting stuck.

### Accounts and keys

- [ ] **Anthropic API key** — from <https://console.anthropic.com/settings/keys>.
      Starts with `sk-ant-`. The account must have **billing/credit**.
- [ ] **OpenAI API key** — from <https://platform.openai.com/api-keys>.
      Starts with `sk-`. The account must have **billing/credit**
      (even a small $5–10 balance is plenty).
- [ ] **AWS access key + secret** for Route 53 (the DevOps/DNS owner
      creates this — see Part 5). You need three values:
      `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and the region
      (e.g. `us-east-1`).

### Access

- [ ] The VM's **public IP address** (e.g. `20.29.60.163`).
- [ ] The **web address (hostname)** you'll use
      (e.g. `copilot.planatechnologies.io`).
- [ ] The initial SSH key file the DevOps person used to create the
      VM (a `.pem` file), **or** confirmation your own SSH key is
      already installed on the server.
- [ ] **VPN access** — see the note below.

> **Connecting to the VPN.** This deployment is reachable only over a
> company VPN — the server's firewall (Part 2.2) blocks everything
> else. Your DevOps/IT contact (the person who created the VM)
> provides a VPN client plus a profile or login. Install it and
> connect per their instructions. **If you don't know which VPN or
> have no client, stop and ask them before continuing** — nothing past
> Part 8.2 will work off the VPN.
>
> **How to confirm you're actually on it** (once you have the VM IP):
> from 📍 LAPTOP, run — replacing the IP with yours —
> ```bash
> nc -vz -w 5 20.29.60.163 22
> ```
> `succeeded`/`Connected` means the VPN path to the VM is open;
> `Connection refused`/`timed out` means you are **not** on the VPN —
> reconnect and retry. **Do not** use `dig copilot.planatechnologies.io`
> for this — that name is public DNS and resolves whether or not you're
> on the VPN, so it can't prove the VPN is up. Don't rely on `ping`
> either; the firewall only opens ports 22/80/443, not ping.

### On your laptop

- [ ] The **source code** (this git repository) cloned locally.
- [ ] **git** — `git --version` prints a version.
- [ ] A terminal you're comfortable copy-pasting into.
- [ ] `ssh` (`ssh -V`) and `scp` (comes with `ssh`) — should print a
      version. Ship with macOS and Linux.
- [ ] `curl` — `curl --version` prints a version. Ships with macOS and
      Linux.
- [ ] `tar` — `tar --version` prints a version. Used to package the
      code. Ships with macOS and Linux.
- [ ] `dig` — `dig -v` prints a version. Used once, to check DNS in
      Part 3. **If `dig` says "command not found", use
      `nslookup copilot.planatechnologies.io` instead** everywhere this
      guide uses `dig` (nslookup ships on macOS, Linux, and Windows).

> You do **not** need Docker or openssl on your laptop — those run only
> on the VM.

> ⚠️ **Security note:** API keys and SSH private keys are like
> passwords. Never paste them into chat, email, screenshots, or
> commit them to git. Keep them in a password manager.

---

## Part 2 — DevOps: prepare the server (VM)

*(If someone else does infrastructure, hand them this Part. When they
report back that all checks pass, you start at Part 3.)*

### 2.1 VM specification

| Item | Value |
|---|---|
| CPU | **4 vCPU** |
| RAM | **16 GB** |
| Disk | **100 GB SSD** |
| CPU architecture | **x86_64** (not ARM) |
| OS | **Ubuntu 22.04 or 24.04 LTS** |
| Public IP | **Static** |

### 2.2 Firewall — two layers

Azure has a firewall (called an **NSG — Network Security Group**) that
sits *in front of* the server, plus the server's own firewall (UFW)
*inside*. **Both must allow the same ports.**

For a VPN-only deployment, the NSG inbound rules should allow:

| Port | From | Purpose |
|---|---|---|
| 22 (SSH) | VPN range (or your admin IP) | Remote administration |
| 80 (HTTP) | VPN range | Web (redirects to HTTPS) |
| 443 (HTTPS) | VPN range | The application |

> With DNS-01 for TLS (Part 4), ports 80/443 do **not** need to be
> open to the public internet — VPN-only is fine. This is the whole
> reason we use DNS-01.

### 2.3 Run the one-time setup script

The repository ships a script, **`setup.sh`** (in the repo root), that
prepares the server: updates the OS, installs Docker, configures the
internal firewall (UFW), creates a `deploy` user with your SSH key,
and hardens SSH.

1. **Edit line 10 of `setup.sh`.** It contains a placeholder:
   `DEPLOY_SSH_KEY="PASTE_YOUR_SSH_PUBLIC_KEY_HERE"`. Replace the whole
   quoted value with the deployer's SSH **public** key (the deployer
   generates this in Part 6 — get it from them first). It should end
   up like `DEPLOY_SSH_KEY="ssh-ed25519 AAAA... deploy@..."`.
2. Copy the script to the server and run it as root:

   ```bash
   scp -i <initial-key>.pem setup.sh azureuser@<VM-IP>:/tmp/
   ssh -i <initial-key>.pem azureuser@<VM-IP>
   sudo bash /tmp/setup.sh
   ```

The script prints each stage as `==== ... ====`, runs seven self-checks
at the end, and prints a summary.

**✅ What success looks like:** the last line reads
`Host preparation completed successfully.`, and just above it the
summary shows `Passed: 7, errors: 0`.

> **If a check fails:** the script stops and prints
> `ERROR: Not all on-VM checks passed`, and each check shows `[PASS]`
> or `[FAIL]` so you can see which one. Fix that item (see
> `docs/operations/vm-preparation.md`) and re-run. You can always
> double-check the two most common items by hand:
> ```bash
> sudo docker compose version    # should print v2.20 or newer
> sudo ufw status                # should list 22, 80, 443
> ```

### 2.4 Give the `deploy` user passwordless sudo

The script creates `deploy` but leaves it without a usable password
for `sudo`. Fix it once (as `azureuser`):

```bash
sudo passwd deploy          # set a temporary password
```

Then, logged in **as deploy**:

```bash
sudo -i                     # enter the temporary password
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
exit
sudo passwd -d deploy       # remove the temporary password; key-only from now on
```

**✅ What success looks like:** `sudo whoami` prints `root` with **no**
password prompt.

### 2.5 Hand-off checklist (DevOps → deployer)

DevOps confirms all of these before the deployer starts:

- [ ] Deployer can `ssh deploy@<VM-IP>` with their own key.
- [ ] `docker ps` works for `deploy` with no `sudo` and no error.
- [ ] `sudo whoami` returns `root` without a password.
- [ ] NSG allows 22/80/443 from the VPN.
- [ ] `/opt/copilot` and `/opt/copilot/backups` exist and are owned by
      `deploy`.

---

## Part 3 — DNS: point the address at the server

*(Whoever manages DNS does this — could be you.)*

In **Amazon Route 53**, create an **A record**:

- **Name:** `copilot.planatechnologies.io` (your chosen hostname)
- **Type:** `A`
- **Value:** the VM's public IP (e.g. `20.29.60.163`)
- **TTL:** `300`

**✅ What success looks like** — from 📍 **LAPTOP**:

```bash
dig +short copilot.planatechnologies.io
```

prints the VM's IP. If empty, wait 5 minutes and retry (DNS takes a
little time to spread). *(No `dig`? Use
`nslookup copilot.planatechnologies.io`.)*

> Note the **Hosted Zone ID** of the `planatechnologies.io` zone
> (looks like `Z02379281TIUI3MPJWMWH`). Part 5 needs it. Also see the
> **pre-flight note in Part 8.9** before you first start Caddy — a
> failed first TLS attempt has a lasting cost.

---

## Part 4 — TLS strategy: why there's an AWS step

Skip this understanding at your peril — it's the part that confused us
most during the pilot.

**The padlock (HTTPS) needs a certificate.** Certificates are issued
free by "Let's Encrypt", but Let's Encrypt has to *verify you own the
domain* first. There are two ways:

1. **The normal way (HTTP-01 / TLS-ALPN):** Let's Encrypt connects to
   your server on port 80/443. **This fails for us** because the
   server is VPN-only — Let's Encrypt (on the public internet) can't
   reach it. You'd see `Timeout during connect (likely firewall
   problem)` over and over.
2. **DNS-01 (what we use):** instead of connecting to the server,
   Let's Encrypt asks you to place a special TXT record in DNS. Our
   web server (Caddy) writes that record automatically into Route 53,
   Let's Encrypt reads it from public DNS, and issues the
   certificate. **The server is never contacted** — so VPN-only is
   fine.

For Caddy to write into Route 53, it needs an **AWS key with
permission to edit that one DNS zone**. That's the next part.

---

## Part 5 — AWS key for the padlock (Route 53 DNS-01)

*(The AWS account owner does this.)*

Create an **IAM user** (call it `caddy-dns-validator`) and attach this
**inline policy**. Replace `<ZONE_ID>` with the Route 53 Hosted Zone
ID from Part 3.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "route53:ListHostedZonesByName", "Resource": "*" },
    { "Effect": "Allow", "Action": "route53:GetChange", "Resource": "arn:aws:route53:::change/*" },
    {
      "Effect": "Allow",
      "Action": [
        "route53:ListResourceRecordSets",
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": "arn:aws:route53:::hostedzone/<ZONE_ID>"
    }
  ]
}
```

> **All four actions are required.** During the pilot we discovered
> them one failure at a time — first `ListHostedZonesByName`, then
> `ListResourceRecordSets`. Include all four up front and you won't
> hit that.

Then create an **access key** for this user. You'll get three values
to hand to the deployer (securely — not in chat):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- region (usually `us-east-1`)

The permissions are deliberately tiny: this key can only list zones
and edit records in that **one** DNS zone. It can touch nothing else
in AWS.

---

## Part 6 — Your laptop: one-time setup

### 6.1 Make a notes file for secrets

📍 **LAPTOP**:

```bash
mkdir -p ~/copilot-pilot
```

Create `~/copilot-pilot/secrets.txt` and fill it in as you go (move it
to a password manager when done). Suggested contents:

```
VM IP:            20.29.60.163
Hostname:         copilot.planatechnologies.io
Deploy SSH key:   ~/.ssh/copilot_deploy
ANTHROPIC_API_KEY: sk-ant-...
OPENAI_API_KEY:    sk-...
AWS_ACCESS_KEY_ID:     ...
AWS_SECRET_ACCESS_KEY: ...
AWS_REGION:            us-east-1
Route53 Zone ID:  Z02379281TIUI3MPJWMWH
# Filled in during deployment:
Postgres password:      ...
MinIO password:         ...
NEXTAUTH_SECRET:        ...
REPO_CREDENTIAL_KEY:    ...
Admin login:            admin@copilot.dev / admin123  (CHANGE after first login)
```

### 6.2 Create your SSH key pair

📍 **LAPTOP**:

```bash
ssh-keygen -t ed25519 -C "deploy@copilot-pilot" -f ~/.ssh/copilot_deploy
```

Press Enter twice (empty passphrase is fine to start).

This makes two files:
- `~/.ssh/copilot_deploy` — **private** (never share).
- `~/.ssh/copilot_deploy.pub` — **public** (this is what the DevOps
  person pastes into `setup.sh` line 10 in Part 2.3).

Show the public key to copy it:

```bash
cat ~/.ssh/copilot_deploy.pub
```

### 6.3 Add a shortcut (optional but recommended)

📍 **LAPTOP** — save typing forever:

```bash
echo "alias copilot-ssh='ssh -i ~/.ssh/copilot_deploy deploy@20.29.60.163'" >> ~/.zshrc
source ~/.zshrc
```

Now `copilot-ssh` connects you to the VM (when on the VPN).

> **Which file?** The line above writes to `~/.zshrc`, correct for a
> Mac (zsh is the macOS default since 2019). If your laptop is Linux
> or Windows-WSL — or an older Mac — check your shell with
> `echo $SHELL`: if it ends in `bash`, run the same line but with
> `~/.bashrc` instead of `~/.zshrc`, then `source ~/.bashrc`. Confirm
> it worked: open a new terminal and run `copilot-ssh` (press Ctrl-C
> to cancel the connection). "command not found" means you edited the
> file your shell doesn't read. This step is optional — if you skip
> it, just use the full `ssh -i ~/.ssh/copilot_deploy deploy@20.29.60.163`
> shown later.

---

## Part 7 — Prepare the code (already done, but verify)

The repository already contains the files that make production
deployment work. **They are committed** — you don't need to create
them. But it's worth knowing what they are, because if any go missing
the deployment breaks (we learned this the hard way — see Part 13).

| File | What it does |
|---|---|
| `setup.sh` | One-time VM host-prep script (Part 2.3). |
| `apps/web/Dockerfile` | Recipe to build the web/worker/migrator images. Includes **Chromium** (needed for PDF/diagram export). |
| `caddy.Dockerfile` | Recipe to build Caddy **with the Route 53 plugin** (for DNS-01 TLS). |
| `Caddyfile` | Caddy's config: the hostname, HTTPS via DNS-01, and a favicon rule. |
| `docker-compose.prod.yml` | The master recipe that runs all seven containers together. |
| `apps/web/next.config.ts` | Contains `output: "standalone"` (makes the web image small). |

Also, `apps/web/prisma/schema.prisma` contains
`binaryTargets = ["native", "debian-openssl-3.0.x"]` — without this
the web/worker containers crash on startup. It's committed.

### 7.1 The safety gate — run this before EVERY deployment

📍 **LAPTOP**, from the repo folder:

```bash
cd ~/Repos/ai-assisted-assessment-engine
grep -q "binaryTargets" apps/web/prisma/schema.prisma && echo "binaryTargets OK" || echo "MISSING"
grep -q "chromium" apps/web/Dockerfile && echo "chromium OK" || echo "MISSING"
grep -q "standalone" apps/web/next.config.ts && echo "standalone OK" || echo "MISSING"
ls Caddyfile caddy.Dockerfile docker-compose.prod.yml setup.sh >/dev/null 2>&1 && echo "deploy files OK" || echo "MISSING"
pnpm --filter @copilot/web type-check && echo "✅ TYPE-CHECK PASSED — safe to deploy"
```

**✅ What success looks like:** four `OK` lines and
`✅ TYPE-CHECK PASSED`.

> **Why this matters:** the Docker build runs a strict "type-check"
> (an automatic check that the code has no obvious mistakes). If the
> code has a type error, the build **fails halfway** — wasting ~5
> minutes and leaving you confused. Running `type-check` on your
> laptop first catches it in 30 seconds. During the pilot a committed
> type error broke a deployment; this gate would have caught it.
>
> A "type error" just means the code has a mistake the build would
> reject. You don't need to understand it — the gate catches it early
> so you don't waste a build. **If it fails, note the file name it
> prints and fix it (or pass it to a developer) before packaging.**

---

## Part 8 — First deployment (zero to live)

Do these in order. Each block says where to run it.

### 8.1 Package the code

📍 **LAPTOP**:

```bash
cd ~/Repos/ai-assisted-assessment-engine
mkdir -p ~/copilot-pilot
TARBALL=~/copilot-pilot/copilot-$(date +%Y%m%d-%H%M).tar.gz
git archive --format=tar.gz --prefix=app/ -o "$TARBALL" HEAD
echo "Built: $TARBALL"
# Safety: prove no secrets are inside
tar -tzf "$TARBALL" | grep -iE "\.env|secret|\.pem|key\.json" || echo "✅ no secrets in package"
```

**✅ What success looks like:** a file path is printed, and the last
line is `✅ no secrets in package` (or only `app/.env.example`, which
is a harmless template).

> `git archive` only packages files that are **committed** to git.
> Uncommitted changes won't ship. Commit first
> (`git add ... && git commit`).

### 8.2 Send it to the server

📍 **LAPTOP** (must be on the VPN):

```bash
scp -i ~/.ssh/copilot_deploy "$TARBALL" deploy@20.29.60.163:/opt/copilot/
```

### 8.3 Connect to the server

📍 **LAPTOP**:

```bash
ssh -i ~/.ssh/copilot_deploy deploy@20.29.60.163
```

> Everything from here until **Part 8.9 (inclusive)** is 📍 **VM**.
> **Part 8.10 switches back to your LAPTOP** — watch for the tag. Part
> 8.11 is done in your browser.

### 8.4 Unpack the code

📍 **VM**:

```bash
cd /opt/copilot
TARBALL=$(ls -t copilot-*.tar.gz | head -1)
tar xzf "$TARBALL"
rm "$TARBALL"
cd app
ls
```

**✅ What success looks like:** you see folders like `apps`, `packages`,
`docs` and files `Caddyfile`, `caddy.Dockerfile`,
`docker-compose.prod.yml`.

### 8.5 Create the secret settings files

The app reads secrets from two files that **stay on the server only**
and are never in git: `.env.production` (most secrets) and
`.env.caddy` (only the AWS key for the padlock).

> ⚠️ **Run this section ONCE, on a first-time install only.** The
> `cat > .env.production` and `cat > .env.caddy` commands **overwrite**
> those files with brand-new random passwords. If the app is already
> running with real data, re-running this **breaks the database** (the
> existing Postgres/MinIO storage still expects the OLD passwords) and
> **rotates `REPO_CREDENTIAL_KEY`, which makes all saved customer
> credentials PERMANENTLY unreadable** (no recovery — the tokens must
> be deleted and re-entered). To carry secrets forward on a redeploy,
> do **not** recreate them here — copy them from the previous version
> (Part 11.3). **If `.env.production` already exists, STOP** before
> running these commands.

> ⚠️ **Deploying under a DIFFERENT hostname than
> `copilot.planatechnologies.io`?** The pilot hostname is hardcoded in
> **two** files and they **must match**, or login breaks and the TLS
> cert won't match the address:
> 1. `Caddyfile` — line 1 (`copilot.planatechnologies.io {`) — the
>    name the certificate is issued for.
> 2. `.env.production` — the `NEXTAUTH_URL=https://…` line below —
>    where the app expects sign-in to return to.
>
> (You also set this same hostname in the Route 53 A record, Part 3.)

📍 **VM** — generate strong passwords and write `.env.production`:

```bash
cd /opt/copilot/app
PG_PW=$(openssl rand -base64 24)
MINIO_PW=$(openssl rand -base64 24)
NEXTAUTH=$(openssl rand -base64 32)
REPO_KEY=$(openssl rand -base64 32)

[ -f .env.production ] && echo "REFUSING: .env.production already exists — do not overwrite (see Part 11.3 to reuse secrets)" || cat > .env.production <<EOF
POSTGRES_PASSWORD=$PG_PW
DATABASE_URL=postgresql://copilot:$PG_PW@postgres:5432/assessment_copilot
REDIS_URL=redis://redis:6379
MINIO_ROOT_USER=copilot-admin
MINIO_ROOT_PASSWORD=$MINIO_PW
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=copilot-admin
S3_SECRET_KEY=$MINIO_PW
S3_BUCKET=assessment-documents
S3_REGION=us-east-1
NEXTAUTH_SECRET=$NEXTAUTH
NEXTAUTH_URL=https://copilot.planatechnologies.io
ANTHROPIC_API_KEY=PASTE_ANTHROPIC_KEY
ANTHROPIC_MODEL=claude-sonnet-4-5
OPENAI_API_KEY=PASTE_OPENAI_KEY
EMBEDDING_MODEL=text-embedding-3-small
REPO_CREDENTIAL_KEY=$REPO_KEY
PLANTUML_SERVER_URL=http://plantuml:8080
NODE_ENV=production
EOF
chmod 600 .env.production
```

Now put the two real AI keys in:

```bash
nano .env.production
```

> **Using `nano` (a simple in-terminal text editor):** move the cursor
> with the **arrow keys** — the mouse won't work. Find the placeholder
> words, delete them, and type your real key. When done: **Ctrl-O**
> then **Enter** to save, then **Ctrl-X** to exit. **Do not** put
> quotes around the key.

Replace `PASTE_ANTHROPIC_KEY` and `PASTE_OPENAI_KEY` with your real
keys.

> **Important — leave `OPENAI_API_KEY` filled with a real key.** If it
> is left empty (or the line deleted), the app does **not** error — it
> silently switches to FAKE embeddings, and document search / AI
> analysis return nonsense with no visible failure. (Leaving the literal
> `PASTE_OPENAI_KEY` placeholder instead fails loudly with a 401, which
> is easy to spot — it's specifically an *empty* key that's dangerous.)
> Do not add an `EMBEDDING_MODE` line; leave it unset.

📍 **VM** — write the AWS-only file for Caddy:

```bash
[ -f .env.caddy ] && echo "REFUSING: .env.caddy already exists — do not overwrite" || cat > .env.caddy <<EOF
AWS_ACCESS_KEY_ID=PASTE_AWS_KEY_ID
AWS_SECRET_ACCESS_KEY=PASTE_AWS_SECRET
AWS_REGION=us-east-1
EOF
chmod 600 .env.caddy
nano .env.caddy
```

In nano, replace `PASTE_AWS_KEY_ID` and `PASTE_AWS_SECRET` with the two
real AWS values. Save the same way: **Ctrl-O, Enter, Ctrl-X**.

**✅ What success looks like — no leftover placeholders:**

```bash
grep -c PASTE .env.production .env.caddy
```

Both files should report `0` (you'll see `.env.production:0` and
`.env.caddy:0`). If either shows a number above 0, a placeholder is
still there — re-open with nano and fix it.

> **Why AWS keys live in a SEPARATE file:** if AWS keys are in
> `.env.production`, the app thinks "AWS Bedrock is configured" and can
> misroute AI calls. Keeping them in `.env.caddy` means **only Caddy**
> sees them. (We hit this during the pilot — see Part 13.)

**Write all four generated passwords into your laptop `secrets.txt`
now** — especially `REPO_CREDENTIAL_KEY`. If you lose it, every stored
customer credential becomes unreadable.

### 8.6 The golden rule for every Docker command

**Always include `--env-file .env.production`.** If you forget it,
Docker can't read the passwords and Postgres/MinIO start blank and
break. Make a shortcut so you can't forget:

📍 **VM**:

```bash
echo "alias dcp='docker compose --env-file .env.production -f docker-compose.prod.yml'" >> ~/.bashrc
source ~/.bashrc
```

From now on this guide writes `dcp` — it means exactly that long
command. (The VM runs Ubuntu, whose default shell is bash, so
`~/.bashrc` is correct here. If you skip the alias, type the full
`docker compose --env-file .env.production -f docker-compose.prod.yml`
every time.)

### 8.7 Build the images

📍 **VM**:

```bash
cd /opt/copilot/app
dcp build
```

**This takes 5–10 minutes the first time** (it downloads and compiles
a lot, including Caddy's Route 53 plugin and Chromium). Lots of
scrolling text is normal.

**✅ What success looks like:** it ends with lines like
`Image app-web Built`, `Image app-worker Built`, `Image app-caddy Built`.

### 8.8 Start the background services and set up the database

📍 **VM** — start the four infrastructure containers:

```bash
dcp up -d postgres redis minio plantuml
```

**✅ What success looks like:** `dcp ps` shows all four `Up`, with
`postgres` eventually `Up (healthy)` (give it ~15 seconds).

Run the database setup (creates all the tables):

```bash
dcp up migrator
```

**✅ What success looks like:** it prints migration names (or
"No pending migrations to apply") and ends with
`migrator-1 exited with code 0`.

Now load the starter content and admin user.

> **What this next command does:** it's a one-time command that loads
> the starter content (frameworks, question packs, etc.) and creates
> the admin account. It runs inside the **worker** container — the
> only one that carries the loading tools (`pnpm`/`tsx`); the `web`
> image is stripped down and can't run it. Copy it exactly: the flags
> are intentional (`--rm` cleans up the throwaway container,
> `-w /app/apps/web` sets the working directory, `--entrypoint`
> overrides the worker's normal job). It prints a series of
> `... seeded` lines and finishes with `Seeding complete.` — that
> scrolling output is normal. If it errors with
> `pnpm: executable file not found`, you ran it against `web` by
> mistake (see Part 13).

```bash
dcp run --rm -w /app/apps/web --entrypoint "pnpm exec tsx prisma/seed.ts" worker
```

**✅ What success looks like:** many `... seeded` lines and
`Seeding complete.` **Look for the line
`Admin user seeded: admin@copilot.dev (password: admin123)`** and save
those credentials — you'll change the password after first login.

> To seed a non-default admin password instead of `admin123`, add the
> env var to the command:
> `dcp run --rm -w /app/apps/web -e ADMIN_SEED_PASSWORD='your-strong-password' --entrypoint "pnpm exec tsx prisma/seed.ts" worker`.
> You still must change it in **Admin → Users** after first login
> either way.

Create the file-storage bucket:

```bash
dcp exec minio sh -c 'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p local/assessment-documents'
```

**✅ What success looks like:** "Bucket created successfully" (or
"already exists" — also fine).

### 8.9 Start the app and get the padlock

> ⚠️ **Before you start Caddy for the FIRST time, confirm the padlock
> can succeed — a broken first attempt has a lasting cost.** Check:
> 1. `dig +short copilot.planatechnologies.io` returns the VM IP
>    (proves you edited the right Route 53 zone). *(No `dig`? Use
>    `nslookup`.)*
> 2. The AWS key in `.env.caddy` can actually edit that zone (all four
>    IAM actions from Part 5 present, correct Hosted Zone ID).
>
> **How TLS validates here:** with DNS-01, Let's Encrypt does **not**
> connect to your server — Caddy writes a temporary
> `_acme-challenge.<host>` TXT record into Route 53 and Let's Encrypt
> reads it from public DNS. So the failure modes to rule out are bad
> AWS creds, wrong zone ID, or DNS propagation delay — **not** the A
> record.
>
> **Do NOT keep restarting/`--force-recreate`-ing Caddy while TLS is
> failing.** Caddy already retries on its own. Let's Encrypt caps
> **failed** validations at ~5 per hostname per hour; a manual restart
> loop on a misconfigured Caddy can exhaust that and lock out even a
> correctly-fixed Caddy **for hours**. Fix the root cause **once**,
> then recreate Caddy a single time.

📍 **VM**:

```bash
dcp up -d web worker caddy
dcp logs -f caddy
```

Watch the Caddy logs. Because we use DNS-01, you'll see:

```
"challenge_type":"dns-01"
"msg":"successfully obtained certificate"
```

That second line means the HTTPS padlock is ready. Press **Ctrl-C** to
stop watching (this doesn't stop Caddy).

> If instead you see `Timeout during connect` or `AccessDenied`,
> jump to Part 13 (TLS problems).

### 8.10 Confirm the site is live

📍 **LAPTOP** (on the VPN):

```bash
curl -sS -I -o /dev/null -w "status: %{http_code}\ncert: %{ssl_verify_result} (0=ok)\n" https://copilot.planatechnologies.io
```

**✅ What success looks like:** `status: 200` and `cert: 0 (0=ok)`.

Then open **https://copilot.planatechnologies.io** in a browser
(on the VPN). You should see the login page with a valid padlock.

### 8.11 First login — change the password immediately

1. Sign in with `admin@copilot.dev` / `admin123`.
2. Go to **Admin → Users** and change the admin password to something
   strong. Save it in your password manager.

---

## Part 9 — Verify everything works (smoke test)

> These are the app's own terms — an *engagement* is a client project,
> an *assessment* is one evaluation inside it, and a *deliverable* is a
> generated report. You are just clicking through the normal UI to
> prove each moving part works. (More detail:
> `docs/guides/engagements.md`.)

📍 **BROWSER** — do one full pass:

1. Create an **engagement** (any client + name).
2. Upload a small **PDF or Markdown** file. Wait until it shows
   **READY** (a minute or two). *This proves the worker + OpenAI
   embeddings work.*
3. Create an **assessment**, answer a question or two.
4. Click **Run analysis**. Within a minute, the **Findings** tab
   should show results. *This proves Anthropic works.*
5. Generate a **deliverable** and download it. *This proves file
   storage + report building work (including Chromium for PDFs).*

If any step hangs or errors, check the worker logs on the VM:

```bash
dcp logs -f worker
```

…and see Part 13.

---

## Part 10 — Post-deployment configuration

### 10.1 Turn on the features you use

Feature toggles reset to defaults on a fresh deployment. In the app:
**Admin → Settings → AI Router**, turn on whatever you rely on
(e.g. agent features, hybrid retrieval). They're off by default.

### 10.2 Confirm both AI providers are funded

The #1 real-world failure is a valid API key with **no credit**. From
📍 **VM**, test both against the live keys:

```bash
# OpenAI (embeddings — used during document upload AND analysis)
dcp exec worker node -e 'fetch("https://api.openai.com/v1/embeddings",{method:"POST",headers:{Authorization:"Bearer "+process.env.OPENAI_API_KEY,"content-type":"application/json"},body:JSON.stringify({model:process.env.EMBEDDING_MODEL||"text-embedding-3-small",input:"test"})}).then(async r=>{console.log("OpenAI ->",r.status);console.log((await r.text()).slice(0,200));}).catch(e=>console.error(e.message));'

# Anthropic (the reasoning)
dcp exec worker node -e 'fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||"claude-sonnet-4-5",max_tokens:1,messages:[{role:"user",content:"hi"}]})}).then(async r=>{console.log("Anthropic ->",r.status);console.log((await r.text()).slice(0,200));}).catch(e=>console.error(e.message));'
```

> **Paste each command as one unbroken line — don't let it wrap.** A
> good run prints `OpenAI -> 200` and `Anthropic -> 200`. If instead
> you see a JavaScript `SyntaxError` or `Unexpected token` /
> `Unexpected end of input`, the paste got split — re-copy the whole
> line and try again (a paste problem, not a key problem). A `-> 401`
> means the key is wrong or missing; a `-> 429` (with
> `insufficient_quota` / `exceeded your current quota`) means that
> account needs billing/credit. Neither `401` nor `429` is a paste
> problem.

---

## Part 11 — Deploying an update (the routine)

Once the app is live, this is how you ship a new version. ~15 minutes.

### 11.1 Run the safety gate (Part 7.1) — do not skip

📍 **LAPTOP**:

```bash
cd ~/Repos/ai-assisted-assessment-engine
git status                    # commit anything you want to ship
pnpm --filter @copilot/web type-check && echo "✅ safe"
```

If type-check fails, fix it before packaging. (This exact gate would
have prevented two failed deployments during the pilot.)

### 11.2 Package + secret check + upload

📍 **LAPTOP**:

```bash
TARBALL=~/copilot-pilot/copilot-$(date +%Y%m%d-%H%M).tar.gz
git archive --format=tar.gz --prefix=app/ -o "$TARBALL" HEAD
tar -tzf "$TARBALL" | grep -iE "\.env|secret|\.pem|key\.json" || echo "✅ no secrets"
scp -i ~/.ssh/copilot_deploy "$TARBALL" deploy@20.29.60.163:/opt/copilot/
```

### 11.3 Swap in the new code, keeping your secrets

📍 **VM**:

```bash
cd /opt/copilot
TARBALL=$(ls -t copilot-*.tar.gz | head -1)
mv app "app-prev-$(date +%s)"           # keep the old version for rollback
tar xzf "$TARBALL"
rm "$TARBALL"
cp app-prev-*/.env.production app/       # carry secrets forward
cp app-prev-*/.env.caddy app/
cd app
ls -la .env.production .env.caddy        # BOTH must be present
```

**✅ What success looks like:** both `.env` files listed, non-empty.
**If either is missing, STOP** — restore from the `app-prev-*` folder
before continuing.

### 11.4 Build, migrate, restart — in this order

📍 **VM**:

```bash
dcp build web worker migrator            # rebuild images with the new code; add "caddy" only if you changed Caddy files
dcp up migrator                          # now runs the NEW migrator -> applies any new DB changes
dcp up -d --force-recreate web worker    # start new code against the migrated schema; add "caddy" only if you rebuilt it
```

> **Order matters.** `docker compose up` reuses an existing image
> rather than rebuilding it. If you ran `dcp up migrator` *before*
> `dcp build`, it would run the OLD migrator image and silently skip
> the new database changes — then the new code crashes with
> "column … does not exist." Always **build first** (including
> `migrator`), then migrate, then recreate.

**✅ What success looks like:** build ends with `Built`; recreate shows
`Started` for web and worker. ~30–60 seconds of downtime is normal.

### 11.5 If the update includes new starter content

If you changed anything under `packages/knowledge-seed/` (question
packs, frameworks, etc.), re-run the seed (runs against `worker` — see
Part 8.8):

```bash
dcp run --rm -w /app/apps/web --entrypoint "pnpm exec tsx prisma/seed.ts" worker
```

### 11.6 Verify

📍 **VM**:

```bash
dcp ps
dcp logs --tail 30 web
```

**✅ What success looks like:** all containers `Up`; web log ends with
`✓ Ready in …ms`; **no** `PrismaClientInitializationError` or
`unhandledRejection`.

📍 **LAPTOP**: open the site, click around the part you changed.

### 11.7 Rolling back a bad update

> ⚠️ **`rm -rf app` deletes your live secrets too.** `.env.production`
> and `.env.caddy` (including `REPO_CREDENTIAL_KEY` — lose it and all
> stored customer credentials become unreadable) live **only** inside
> `app/`. Before deleting, confirm the rollback target exists and has
> both secret files. **Do NOT run `rm -rf app` until the checks below
> pass.**

📍 **VM**:

```bash
cd /opt/copilot
ROLLBACK=$(ls -1td app-prev-* | head -1)   # newest previous version
echo "Rolling back to: $ROLLBACK"
ls -la "$ROLLBACK/.env.production" "$ROLLBACK/.env.caddy"   # BOTH must exist and be non-empty
# Only if the two files above are present, continue:
cp "$ROLLBACK/.env.production" "$ROLLBACK/.env.caddy" /opt/copilot/   # extra safety copy
rm -rf app
mv "$ROLLBACK" app
cd app
dcp build && dcp up -d --force-recreate web worker
```

**If the `ls -la` line shows either file missing, STOP** — do not
delete `app`; ask a developer, because that rollback folder cannot
restore your secrets.

> Safe for normal updates (new columns/tables). If the update ran a
> **destructive** database change (dropped/renamed columns), you'd
> need a database restore from Part 12 instead.

---

## Part 12 — Backups

📍 **VM** — install a nightly backup job. First find the exact volume
name:

```bash
docker volume ls | grep minio        # e.g. app_minio_data
```

The script below assumes your MinIO volume is named **`app_minio_data`**
— the name you should have just seen. **If that command printed a
DIFFERENT name, replace `app_minio_data` on the `docker run` line
below with the exact name it showed, before pasting.**

```bash
sudo tee /etc/cron.daily/copilot-backup > /dev/null <<'EOF'
#!/usr/bin/env bash
set -e
TS=$(date +%Y%m%d-%H%M)
DEST=/opt/copilot/backups
mkdir -p "$DEST"
cd /opt/copilot/app
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U copilot assessment_copilot | gzip > "$DEST/pg-$TS.sql.gz"
docker run --rm -v app_minio_data:/data -v "$DEST":/backup alpine \
  tar czf "/backup/minio-$TS.tar.gz" -C /data .
find "$DEST" -type f -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/copilot-backup
sudo /etc/cron.daily/copilot-backup     # test it once
ls -lh /opt/copilot/backups/
```

**✅ What success looks like:** two files appear, and **both are well
over 0 bytes.** A MinIO tarball of only a few hundred bytes means the
volume name was wrong (Docker silently made an empty volume instead of
erroring) — re-check the name from `docker volume ls | grep minio` and
fix the `docker run` line.

> A backup on the same server that dies is not a backup. Copy
> `/opt/copilot/backups/` off the machine weekly (to S3, another
> server, etc.).

---

## Part 13 — Troubleshooting (every problem we actually hit)

### `WARN: The "POSTGRES_PASSWORD" variable is not set`
**Cause:** you ran a `docker compose` command without
`--env-file .env.production`. Always use the `dcp` shortcut (Part 8.6).

If Postgres started blank and is **restart-looping**:

> 🛑 **STOP — the `docker volume rm` line below PERMANENTLY DELETES the
> entire database and every uploaded file. There is no undo.**
>
> **First, try the non-destructive fix.** On a system that already
> holds real data, do **not** delete volumes — just bring the stack
> back up *with* the env file so the password is read again:
> ```bash
> source ~/.bashrc                      # reload the dcp alias (or type the full command)
> dcp up -d --force-recreate postgres   # restarts Postgres WITH the password, no data loss
> ```
> If unsure whether there's real data, STOP and ask a developer.
>
> **Only delete the volumes if BOTH are true:** (1) this is a
> brand-new, first-time setup and the database is still empty (no
> engagement created, no document uploaded, no real data), AND (2)
> Postgres first started blank and is stuck restart-looping. If the app
> has EVER held real data, do not run this; if you must recreate
> volumes anyway, take a Part 12 backup FIRST and confirm it exists.

```bash
# FIRST-TIME SETUP ONLY — destroys all data; never run once you have real data:
dcp down
docker volume rm app_postgres_data app_minio_data
dcp up -d postgres redis minio plantuml    # with the alias, so env is read
```
Then re-do migrate + seed + bucket (Part 8.8).

### `PrismaClientInitializationError … debian-openssl-3.0.x`
The web/worker container crash-loops on startup.
**Cause:** `schema.prisma` is missing
`binaryTargets = ["native", "debian-openssl-3.0.x"]`.
**Fix:** ensure that line is in `apps/web/prisma/schema.prisma`
(it's committed; a redeploy from an old copy can lose it), commit,
redeploy.

### `pnpm: executable file not found` when seeding
**Cause:** you ran the seed against the `web` container, which is a
stripped-down image.
**Fix:** run it against `worker` (Part 8.8) — that image has the tools.

### PDF export fails: `Could not find Chrome`
**Cause:** the images were built without Chromium.
**Fix:** confirm `apps/web/Dockerfile` contains `chromium` in the
`web` and `worker` stages (it's committed), rebuild
(`dcp build web worker`) and recreate.

### TLS: `Timeout during connect (likely firewall problem)`
Caddy can't get a certificate.
**Cause:** ports 80/443 aren't reachable for the challenge.
**Fix (our setup):** we use **DNS-01**, so confirm the `Caddyfile` has
the `tls { dns route53 }` block and Caddy was rebuilt from
`caddy.Dockerfile` (which includes the Route 53 plugin). If you see
`http-01`/`tls-alpn-01` in the logs, the Caddyfile change didn't take
— fix it and `dcp up -d --force-recreate caddy` **once** (don't loop —
see the rate-limit warning in Part 8.9).

### TLS: `AccessDenied … route53:...`
Caddy reached AWS but lacks permission.
**Fix:** add the missing action to the IAM policy (Part 5 — all four
actions), then `dcp up -d --force-recreate caddy`.

### AWS Bedrock shows "CONFIGURED" in Admin → Settings → AI Router
**Cause:** the status check marks Bedrock CONFIGURED if **any** of
these is present in the web/worker environment: `AWS_REGION`,
`AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`,
`AWS_ROLE_ARN` — not just the access key. So removing only the access
key/secret but leaving a bare `AWS_REGION=us-east-1` line in
`.env.production` still flips Bedrock on. (Easy to do by accident —
`S3_REGION=us-east-1` sits right next to it and looks interchangeable.
It isn't, and `S3_REGION` is required, so keep it.)
**Why it matters:** while Bedrock shows CONFIGURED, an admin can pin an
AI task to Bedrock, which isn't wired on this deployment, so those
calls fail.
**Fix:** `.env.production` must contain **none** of `AWS_REGION`,
`AWS_DEFAULT_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`,
`AWS_ROLE_ARN`. Keep `S3_REGION`. All `AWS_*` values belong only in
`.env.caddy`. Then `dcp up -d --force-recreate web worker`.

### Document upload fails: `EMBEDDING_REQUEST_FAILED … Bedrock … not installed`
**Cause:** this is **not** an AWS problem. OpenAI returned `429` (out
of quota); the app then tried a Bedrock fallback that isn't installed.
It's really an **OpenAI billing problem**.
**Fix:** add credit to the OpenAI account (Part 10.2 to confirm),
then retry the upload.

### Analysis stuck "in progress / Cancelling…" and won't stop
**Cause:** the worker is wedged (often out of AI credit) and can't
reach a cancel checkpoint.
**Fix — step 1 (safe for you to run):** hard-stop the queue and worker.

> ⚠️ **`redis-cli FLUSHALL` clears the ENTIRE job queue for the whole
> server**, not just the stuck item. Any analysis, document ingest, or
> report generation running for **other** engagements is discarded and
> must be started again. Durable data in the database and file storage
> is **not** affected. Only do this when the queue is genuinely wedged.

```bash
dcp exec redis redis-cli FLUSHALL   # wipes ALL queued/in-flight jobs (durable data in Postgres is safe)
dcp restart worker                  # restart re-registers the housekeeping schedule automatically
```

**Fix — step 2 (only if the banner is STILL stuck afterward):** this
is the one step in this guide that needs a developer — **do not attempt
it yourself.** The banner is derived from an audit-log table and stays
"in progress" until a terminal row exists for that assessment. Send a
developer this note:

> The analysis banner is stuck because no terminal lifecycle row was
> written. Please add a `RUN_ANALYSIS_CANCELLED` audit-log row for this
> assessment so `runStatus` flips `inFlight` back to false. On the VM:
> ```bash
> dcp exec -T postgres psql -U copilot -d assessment_copilot -c \
>   "INSERT INTO audit_logs (id, action, entity_type, entity_id, created_at) \
>    VALUES (gen_random_uuid()::text, 'RUN_ANALYSIS_CANCELLED', 'Assessment', '<ASSESSMENT_ID>', now());"
> ```
> `id` has no DB default (normally app-generated), so supply one;
> `created_at` defaults to now(). Get `<ASSESSMENT_ID>` from the
> assessment's URL. Refresh the page and the banner clears.

### Favicon (browser tab icon) won't disappear
The server is fine; browsers cache favicons for up to a year.
**Confirm server-side:** `curl -I https://<host>/icon.png` returns
`204` or `404`. If so, it's browser cache. **Fix:** test in a **brand
new browser profile** (guaranteed clean), or clear the browser's
favicon cache.

### Locally: `column … does not exist in the current database`
**Cause:** your **local** dev database is missing a migration.
**Fix:** 📍 LAPTOP `pnpm db:migrate`, then restart `pnpm dev`. (Habit:
after any `git pull` that touches `prisma/migrations/`, run
`pnpm db:migrate`.)

### Build fails on a type error (`… is not assignable to …`)
**Cause:** committed code has a type error; the Docker build's
type-check rejects it.
**Fix:** this is exactly what the **safety gate** (Part 7.1) catches.
Run `pnpm --filter @copilot/web type-check` on your laptop, fix the
reported file, commit, repackage.

### Can't SSH into the VM
- `Operation timed out` → you're not on the VPN. Connect and retry.
- `Permission denied (publickey)` → wrong key path or username.
- `Bad permissions` on the key → `chmod 600 ~/.ssh/copilot_deploy`.

---

## Part 14 — Quick reference

### Everyday commands (📍 VM, in `/opt/copilot/app`)

| Task | Command |
|---|---|
| Status of all containers | `dcp ps` |
| Watch web logs | `dcp logs -f web` |
| Watch worker logs | `dcp logs -f worker` |
| Restart web only | `dcp restart web` |
| Stop everything | `dcp down` |
| Start everything | `dcp up -d` |
| Free disk (⚠️ see note) | `docker image prune -f` (safe: dangling only) |

*(`dcp` = `docker compose --env-file .env.production -f docker-compose.prod.yml`)*

> ⚠️ **Avoid `docker system prune -a` unless you know what it does.**
> With the stack running it's usually fine, but if any container is
> stopped (e.g. right after `dcp down`) it will **delete this app's
> built images** (`app-web`, `app-worker`, `app-caddy`, `migrator`)
> and force a full 5–10 min rebuild — and it removes unrelated Docker
> images too. Prefer `docker image prune -f` (removes only leftover
> dangling layers). Only run `docker system prune -a` when `dcp ps`
> shows every container `Up` and you specifically want to reclaim all
> unused images.

### Connect from your laptop

```bash
ssh -i ~/.ssh/copilot_deploy deploy@20.29.60.163      # or: copilot-ssh
```

### Where things live on the server

```
/opt/copilot/
├── app/                     ← the live version
│   ├── .env.production       (secrets — never leaves the server)
│   ├── .env.caddy            (AWS key for the padlock)
│   ├── Caddyfile
│   ├── caddy.Dockerfile
│   └── docker-compose.prod.yml
├── app-prev-<timestamp>/    ← previous versions (for rollback)
└── backups/                 ← nightly database + file backups
```

### Glossary (plain English)

| Term | Meaning |
|---|---|
| **VM** | The rented Linux server the app runs on. |
| **SSH** | The secure way to log into the server from your laptop. |
| **VPN** | A secure network tunnel; you must be "on the VPN" to reach the server. |
| **Container** | One of the seven small programs the app is made of. |
| **Docker / Compose** | The tool that runs all the containers together. |
| **Image** | A built, ready-to-run copy of a container. |
| **Tarball** | The `.tar.gz` package of the code you send to the server. |
| **Migration** | A change to the database's structure. |
| **Seed** | Loading the starter content (frameworks, admin user, etc.). |
| **Engagement / Assessment / Deliverable** | App terms: a client project / one evaluation inside it / a generated report. |
| **TLS / HTTPS / "the padlock"** | The encryption that makes the address show a padlock. |
| **DNS-01** | The padlock method that works without opening the server to the public internet. |
| **NSG** | Azure's firewall in front of the server. |
| **`.env` file** | A file of secret settings the app reads at startup. |
| **NEXTAUTH_SECRET / REPO_CREDENTIAL_KEY** | Internal keys the app generates once; don't lose them. |

---

## Appendix — the deployment files (for reference)

These are already in the repository. Shown so you can recognize a
correct copy.

**`apps/web/next.config.ts`** must contain `output: "standalone"`.

**`apps/web/prisma/schema.prisma`** generator block:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}
```

**`caddy.Dockerfile`:**

```dockerfile
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/route53

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

**`Caddyfile`** (replace the hostname):

```
copilot.planatechnologies.io {
    encode gzip
    @icons path /favicon.ico /icon /icon.png /apple-icon /apple-icon.png /apple-touch-icon.png
    respond @icons 204
    reverse_proxy web:3000
    tls {
        dns route53
    }
}
```

The `apps/web/Dockerfile`, `docker-compose.prod.yml`, and `setup.sh`
are longer; view them directly in the repository (`apps/web/` and the
repo root).

---

*This playbook documents the deployment as performed for the
`copilot.planatechnologies.io` pilot: a single Azure VM, VPN-only
access, and Let's Encrypt TLS via Route 53 DNS-01. Two companion docs
exist — [`deployment.md`](./deployment.md) and
[`vm-preparation.md`](./vm-preparation.md) — but note: **both describe
the standard public-internet TLS setup (Let's Encrypt HTTP-01, ports
80/443 open to the internet).** For this VPN-only pilot, the firewall
and TLS steps in Parts 2 and 4–5 of THIS playbook (VPN-range-only
ports + DNS-01) take precedence over the HTTP-01 guidance in those two
docs.*
