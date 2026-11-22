#!/usr/bin/env bash
# Sets up a WebODM server on Ubuntu 24.04 LTS (made for a Linode) where only Explorer's share links are public.
#
# What it does: a sudo user with your SSH key (root and password logins off), a firewall, fail2ban, automatic security
# updates, swap, Docker, WebODM listening on localhost only (no processing node), and Caddy in front of it: HTTPS with
# a Let's Encrypt certificate, serving only the paths Explorer's links need. WebODM's own pages (sign-in, admin,
# processing) are reached through an SSH tunnel. Guide: https://winuxnomacs.github.io/webodm-explorer/hosting/linode
#
# Run it as root, once, either:
#   - pasted as "User Data" when creating the Linode (edit the settings below first), or
#   - over SSH: DOMAIN=maps.example.com EMAIL=you@example.com bash setup.sh
# Running it again is safe: each step checks before it changes anything. To update WebODM, run it again with a newer
# WEBODM_VERSION. Its output is kept in /var/log/explorer-setup.log.
#
# Licence: AGPL-3.0 (https://github.com/WinuxNomacs/webodm-explorer). No warranty: read it before you run it.

# ---- Settings: edit these, or set them in the environment ------------------------------------------------------
DOMAIN="${DOMAIN:-}"                    # the DNS name pointing at this server, e.g. maps.example.com
EMAIL="${EMAIL:-}"                      # for Let's Encrypt's expiry notices (not needed with TLS=internal)
ADMIN_USER="${ADMIN_USER:-odm}"         # the Linux user you log in as (gets root's SSH keys, sudo)
WEBODM_VERSION="${WEBODM_VERSION:-4.0.1}"
TLS="${TLS:-acme}"                      # acme: Let's Encrypt; internal: Caddy's own CA (tests, no public DNS)
SWAP_GB="${SWAP_GB:-2}"                 # swap file size when the server has none; 0 for none
AUTO_REBOOT="${AUTO_REBOOT:-yes}"       # reboot at 04:00 when an update needs it (WebODM starts again by itself)
# -----------------------------------------------------------------------------------------------------------------

set -Eeuo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
LOG=/var/log/explorer-setup.log
WEBODM_DIR=/opt/WebODM
# The repositories' signing keys, checked before they are trusted
DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
CADDY_KEY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34

STEP="start"
step() { STEP="$1"; echo; echo "==> $1"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
trap 'echo "FAILED during: $STEP (line $LINENO). Nothing after it ran; fix the cause and run the script again." >&2' ERR

# Writes stdin to a file when its content differs; returns 0 when the file changed, 1 when it was already so
write_file() {
    local path="$1" mode="${2:-0644}" tmp
    tmp="$(mktemp)"
    cat > "$tmp"
    if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then rm -f "$tmp"; return 1; fi
    install -D -m "$mode" "$tmp" "$path"
    rm -f "$tmp"
    return 0
}

# Runs a command until it succeeds, 5 tries with a growing pause (downloads, apt mirrors)
retry() {
    local n=1
    until "$@"; do
        (( n >= 5 )) && return 1
        echo "  (failed, try $((n + 1)) of 5 in $((n * 10))s)"
        sleep $((n * 10)); n=$((n + 1))
    done
}

apt_get() { retry apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold "$@"; }

# Fetches a repository key and checks its fingerprint before saving it
fetch_key() {
    local url="$1" fpr="$2" dest="$3" tmp got
    tmp="$(mktemp)"
    retry curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$tmp"
    got="$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
    [[ "$got" == "$fpr" ]] || { rm -f "$tmp"; fail "the key at $url has fingerprint '$got', expected $fpr"; }
    install -D -m 0644 "$tmp" "$dest"
    rm -f "$tmp"
}

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "Explorer server setup, $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------------------------------------------------
step "Checking the settings and the system"
[[ "$(id -u)" == 0 ]] || fail "run this as root (sudo bash setup.sh)"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail "this script is for Ubuntu 24.04 LTS (found ${PRETTY_NAME:-unknown})"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "set DOMAIN to this server's DNS name, in lower case (e.g. maps.example.com)"
[[ "$TLS" == acme || "$TLS" == internal ]] || fail "TLS is acme or internal"
if [[ "$TLS" == acme ]]; then
    [[ "$DOMAIN" != *example.com ]] || fail "DOMAIN is still the example; set your own"
    [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "set EMAIL for Let's Encrypt"
fi
[[ "$ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$ADMIN_USER" != root ]] || fail "ADMIN_USER must be a plain user name, not root"
[[ "$WEBODM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "WEBODM_VERSION is a release number such as 4.0.1"
[[ "$WEBODM_VERSION" =~ ^([4-9]|[1-9][0-9])\. ]] || fail "Explorer needs WebODM 4.0.0 or later"
[[ "$SWAP_GB" =~ ^[0-9]+$ ]] || fail "SWAP_GB is a number"
[[ "$AUTO_REBOOT" == yes || "$AUTO_REBOOT" == no ]] || fail "AUTO_REBOOT is yes or no"
# SSH logins are turned to keys only below: refuse now rather than lock you out
keys_found=""
for f in /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"; do
    [[ -s "$f" ]] && grep -qE '^(ssh-|ecdsa-|sk-)' "$f" && keys_found=yes
done
[[ -n "$keys_found" ]] || fail "no SSH public key found for root or $ADMIN_USER: add one (Linode: SSH Keys when creating it) and run again"
echo "Domain $DOMAIN, user $ADMIN_USER, WebODM $WEBODM_VERSION, certificates: $TLS"

# ---------------------------------------------------------------------------------------------------------------------
step "Updating the system and installing the base packages"
apt_get update
apt_get upgrade
apt_get install ca-certificates curl gnupg git ufw fail2ban unattended-upgrades

# ---------------------------------------------------------------------------------------------------------------------
step "Creating the user $ADMIN_USER"
if ! id -u "$ADMIN_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash --groups sudo "$ADMIN_USER"
    passwd --lock "$ADMIN_USER" >/dev/null   # no password: SSH keys only
    echo "Created $ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"
# sudo without a password, as on Ubuntu's cloud images (the account has none; logins need the SSH key)
write_file "/etc/sudoers.d/90-explorer-$ADMIN_USER" 0440 <<EOF || true
$ADMIN_USER ALL=(ALL) NOPASSWD:ALL
EOF
visudo -cqf "/etc/sudoers.d/90-explorer-$ADMIN_USER" || fail "the sudoers file did not check"
home="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
install -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$home/.ssh"
touch "$home/.ssh/authorized_keys"
if [[ -s /root/.ssh/authorized_keys ]]; then
    sort -u "$home/.ssh/authorized_keys" /root/.ssh/authorized_keys | grep -E '^(ssh-|ecdsa-|sk-)' > "$home/.ssh/authorized_keys.new" || true
    mv "$home/.ssh/authorized_keys.new" "$home/.ssh/authorized_keys"
fi
chown "$ADMIN_USER:$ADMIN_USER" "$home/.ssh/authorized_keys"
chmod 0600 "$home/.ssh/authorized_keys"
grep -qE '^(ssh-|ecdsa-|sk-)' "$home/.ssh/authorized_keys" || fail "$ADMIN_USER has no SSH key"

# ---------------------------------------------------------------------------------------------------------------------
step "SSH: keys only, no root login, only $ADMIN_USER"
# 10- sorts before cloud-init's 50- file, and sshd keeps the first value it reads
if write_file /etc/ssh/sshd_config.d/10-explorer.conf <<EOF
# Written by Explorer's setup script
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
AllowUsers $ADMIN_USER
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
EOF
then
    sshd -t || { rm -f /etc/ssh/sshd_config.d/10-explorer.conf; fail "the SSH settings did not check; left SSH as it was"; }
    systemctl try-reload-or-restart ssh.service
    echo "SSH reloaded: log in as $ADMIN_USER from now on"
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Firewall: SSH, HTTP and HTTPS only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# SSH allowed plainly: ufw's limit (6 connections in 30 s) refuses a tunnel, a session and a copy opened together;
# fail2ban bans addresses that fail to log in, and logins need a key
ufw status | grep -qE '^22/tcp +LIMIT' && ufw --force delete limit 22/tcp >/dev/null
ufw allow 22/tcp comment "SSH" >/dev/null
ufw allow 80/tcp comment "HTTP, for certificates and the redirect" >/dev/null
ufw allow 443/tcp comment "HTTPS" >/dev/null
ufw allow 443/udp comment "HTTP/3" >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/  /'

step "fail2ban for SSH"
if write_file /etc/fail2ban/jail.d/explorer.local <<'EOF'
# Written by Explorer's setup script
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
then systemctl restart fail2ban; fi
systemctl enable --now fail2ban >/dev/null 2>&1

step "Automatic security updates"
write_file /etc/apt/apt.conf.d/20auto-upgrades <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
write_file /etc/apt/apt.conf.d/52explorer-unattended-upgrades <<EOF || true
// Written by Explorer's setup script: Docker's and Caddy's repositories are updated too
Unattended-Upgrade::Origins-Pattern {
    "origin=Docker,archive=\${distro_codename}";
    "origin=cloudsmith/caddy/stable";
};
Unattended-Upgrade::Automatic-Reboot "$([[ "$AUTO_REBOOT" == yes ]] && echo true || echo false)";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1

step "Swap"
if [[ "$SWAP_GB" -gt 0 ]] && ! swapon --show --noheadings | grep -q .; then
    fallocate -l "${SWAP_GB}G" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "Added ${SWAP_GB} GB of swap"
else
    echo "Swap: $(swapon --show --noheadings | wc -l) area(s) already, or none asked for"
fi
write_file /etc/sysctl.d/90-explorer.conf <<'EOF' && sysctl -q --system || true
vm.swappiness = 10
EOF

# ---------------------------------------------------------------------------------------------------------------------
step "Docker, from Docker's repository"
arch="$(dpkg --print-architecture)"
fetch_key https://download.docker.com/linux/ubuntu/gpg "$DOCKER_KEY_FPR" /etc/apt/keyrings/docker.asc
write_file /etc/apt/sources.list.d/docker.sources <<EOF || true
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt_get update
apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# Container logs rotated, so they can't fill the disk
if write_file /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
then systemctl restart docker; fi
systemctl enable --now docker >/dev/null 2>&1

# ---------------------------------------------------------------------------------------------------------------------
step "WebODM $WEBODM_VERSION, listening on localhost only"
if [[ ! -d "$WEBODM_DIR/.git" ]]; then
    retry git clone --quiet --depth 1 --branch "v$WEBODM_VERSION" https://github.com/WebODM/WebODM "$WEBODM_DIR"
else
    git -C "$WEBODM_DIR" checkout --quiet -- .env   # this script's own changes, made again below
    retry git -C "$WEBODM_DIR" fetch --quiet --depth 1 origin tag "v$WEBODM_VERSION"
    git -C "$WEBODM_DIR" -c advice.detachedHead=false checkout --quiet "v$WEBODM_VERSION"
fi
# WebODM's defaults, so that even a plain ./webodm.sh restart keeps them: 127.0.0.1 because ports Docker publishes
# skip ufw (WebODM listens only where Caddy and the SSH tunnel reach it); no processing node (tasks are processed
# elsewhere and imported, or a node is added later in WebODM)
sed -i -e 's/^WO_PORT=.*/WO_PORT=127.0.0.1:8000/' -e "s/^WO_HOST=.*/WO_HOST=$DOMAIN/" -e 's/^WO_DEFAULT_NODES=.*/WO_DEFAULT_NODES=0/' "$WEBODM_DIR/.env"
if ! { grep -qx 'WO_PORT=127.0.0.1:8000' "$WEBODM_DIR/.env" && grep -qx 'WO_DEFAULT_NODES=0' "$WEBODM_DIR/.env"; }; then
    fail "could not set WebODM's defaults in $WEBODM_DIR/.env"
fi
# sudo webodm restart (after installing a plugin), stop, start: with this server's settings, in the background
write_file /usr/local/sbin/webodm 0755 <<EOF || true
#!/bin/sh
# Written by Explorer's setup script: runs WebODM's webodm.sh with this server's settings.
# sudo webodm restart | start | stop | down
set -e
cd "$WEBODM_DIR"
case "\$1" in
    start|restart) exec ./webodm.sh "\$1" --detached --port 127.0.0.1:8000 --hostname "$DOMAIN" --default-nodes 0 ;;
    *) exec ./webodm.sh "\$@" ;;
esac
EOF
# WebODM's compose file names its app image without a tag (latest, which moves after a release): this release's image
# is pulled and tagged latest, so the code and the image match
retry docker pull --quiet "webodm/webodm_webapp:$WEBODM_VERSION" >/dev/null
docker tag "webodm/webodm_webapp:$WEBODM_VERSION" webodm/webodm_webapp:latest
/usr/local/sbin/webodm start
echo "Waiting for WebODM to answer (its first start sets up the database: a few minutes)"
deadline=$((SECONDS + 1200))
until curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:8000/; do
    (( SECONDS < deadline )) || fail "WebODM did not answer on 127.0.0.1:8000 within 20 minutes: see 'cd $WEBODM_DIR && docker compose logs webapp'"
    sleep 10
done
if ss -Hltn | awk '{ print $4 }' | grep -qE '^(0\.0\.0\.0|\*|\[::\]):8000$'; then
    fail "WebODM is listening on every address, not only 127.0.0.1:8000"
fi
echo "WebODM answers on 127.0.0.1:8000 only"

# ---------------------------------------------------------------------------------------------------------------------
step "Caddy: HTTPS for $DOMAIN, the links' paths only"
fetch_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_KEY_FPR" /etc/apt/keyrings/caddy.asc
write_file /etc/apt/sources.list.d/caddy.sources <<'EOF' || true
Types: deb
URIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian
Suites: any-version
Components: main
Signed-By: /etc/apt/keyrings/caddy.asc
EOF
apt_get update
apt_get install caddy
if [[ "$TLS" == acme ]]; then global="email $EMAIL"; site_tls=""; else global="local_certs"; site_tls="tls internal"; fi
if write_file /etc/caddy/Caddyfile <<EOF
# Written by Explorer's setup script. Only what Explorer's share links load is passed to WebODM; everything else,
# WebODM's sign-in, admin, API and processing included, answers 404. WebODM itself: through the SSH tunnel.
{
	$global
}

$DOMAIN {
	$site_tls
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	# A link's pages and its API (tiles, point cloud nodes, splats, downloads it allows), WebODM's static files,
	# translations and logo
	@links {
		method GET HEAD
		path /plugins/explorer/s/* /api/plugins/explorer/s/* /static/* /jsi18n/ /media/CACHE/images/settings/*
	}
	# Plugins' script, style, image and font files (WebODM adds every plugin's scripts to every page)
	@plugin_files {
		method GET HEAD
		path_regexp ^/plugins/[A-Za-z0-9_-]+/[A-Za-z0-9_./-]+\.(js|mjs|css|wasm|png|jpe?g|gif|svg|webp|woff2?|ttf)$
	}

	handle /robots.txt {
		respond "User-agent: *
Disallow: /
" 200
	}
	handle @links {
		reverse_proxy 127.0.0.1:8000
	}
	handle @plugin_files {
		reverse_proxy 127.0.0.1:8000
	}
	handle {
		respond "Not found" 404
	}
}
EOF
then
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || fail "the Caddyfile did not validate: caddy validate --config /etc/caddy/Caddyfile"
    systemctl reload-or-restart caddy
fi
systemctl enable --now caddy >/dev/null 2>&1

# ---------------------------------------------------------------------------------------------------------------------
step "Checking DNS"
mine="$(ip -o -4 addr show scope global | awk '{ split($4, a, "/"); print a[1] }' | sort -u)"
theirs="$(getent ahostsv4 "$DOMAIN" | awk '{ print $1 }' | sort -u || true)"
if [[ "$TLS" == internal ]]; then
    echo "TLS=internal: no public certificate asked for"
elif [[ -n "$theirs" ]] && grep -qxFf <(echo "$theirs") <(echo "$mine"); then
    echo "$DOMAIN points at this server: Caddy gets its certificate within a minute or two"
else
    echo "WARNING: $DOMAIN does not point at this server yet (it resolves to: ${theirs:-nothing}; this server: $(echo "$mine" | tr '\n' ' '))."
    echo "         Add an A record for it; Caddy keeps trying and gets the certificate once DNS is right."
fi

# ---------------------------------------------------------------------------------------------------------------------
step "Done"
cat <<EOF

The server is ready. From your own computer:

  1. Open WebODM through an SSH tunnel (keep this running while you use WebODM):

       ssh -N -L 8000:127.0.0.1:8000 $ADMIN_USER@$DOMAIN

     then browse to http://localhost:8000 and create WebODM's administrator account. Do it now: until then, the
     first visitor through the tunnel creates it (no one else can reach that page).

  2. In WebODM: Administration > Plugins > Load Plugin (.zip), with Explorer's zip. Then restart WebODM
     (it asks to): ssh $ADMIN_USER@$DOMAIN sudo webodm restart
  3. Explorer > Settings: Public Address https://$DOMAIN
  4. Import your processed tasks, then share links: they open at https://$DOMAIN/...

Root and password logins are off: log in as $ADMIN_USER with your SSH key. This log: $LOG
EOF
