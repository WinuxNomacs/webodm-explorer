#!/usr/bin/env bash
# The checks of a server set up by docs/public/linode/setup.sh, from outside it: what the internet can and can't
# reach, and SSH. Arguments: the server's IP, the SSH key, its name, its user. Used by dev/linode-vm/vm.sh check,
# after vm.sh e2e (Explorer installed: its files and its page for an unknown link are checked).
# shellcheck disable=SC2015  # ok and bad always succeed, so A && ok || bad is an if-else here
set -uo pipefail
ip="$1" key="$2" domain="$3" user="$4"
failures=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1"; failures=$((failures + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -k --max-time 10 --resolve "$domain:443:$ip" --resolve "$domain:80:$ip" "$@"; }
expect() { local want="$1"; shift; local got; got="$(code "$@")"; [[ "$got" == "$want" ]] && ok "$want ${*: -1}" || bad "${*: -1}: $got, expected $want"; }
# One SSH connection reused for every command (ControlMaster), as a person's single session would be
ssh_as() { ssh -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes \
    -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=/tmp/exvm-%C -o ControlPersist=60 "$@"; }

echo "Public over HTTPS: only the link paths"
expect 404 "https://$domain/"
for p in /login/ /welcome/ /admin/ /dashboard/ /api/ /api/projects/ /api/token-auth/ /api/plugins/explorer/settings/ \
         /plugins/explorer/ /plugins/explorer/project/1/ /plugins/explorer/project/1/preview/ /media/project/ \
         /api/projects/1/tasks/import/external/init /public/project/x/map/; do
    expect 404 "https://$domain$p"
done
expect 404 --path-as-is "https://$domain/plugins/explorer/s/../../../admin/"
expect 404 --path-as-is "https://$domain/static/../admin/"
expect 404 "https://$domain/plugins/explorer/s/%2e%2e/%2e%2e/%2e%2e/admin/"
expect 404 "https://$domain/api/plugins/explorer/s/..%2f..%2f..%2fprojects/"
expect 404 -X POST "https://$domain/plugins/explorer/s/x/"
expect 404 -X DELETE "https://$domain/api/plugins/explorer/s/x/tasks/"
expect 200 "https://$domain/static/app/css/bootstrap.min.css"
expect 200 "https://$domain/plugins/explorer/explorer.css"
expect 200 "https://$domain/jsi18n/"
expect 200 "https://$domain/robots.txt"
# An unknown token: Explorer's own "link not valid" page, through the proxy
expect 404 "https://$domain/plugins/explorer/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/"
curl -sk --resolve "$domain:443:$ip" "https://$domain/plugins/explorer/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/" | grep -q "<title>Link Not Valid" \
    && ok "an unknown token gets Explorer's page" || bad "an unknown token didn't get Explorer's page"
curl -sk --resolve "$domain:443:$ip" -D - -o /dev/null "https://$domain/static/app/css/bootstrap.min.css" | grep -qi '^strict-transport-security' \
    && ok "HSTS header" || bad "no HSTS header"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' --resolve "$domain:80:$ip" "http://$domain/plugins/explorer/s/x/")"
[[ "$loc" == https://* ]] && ok "HTTP redirects to HTTPS" || bad "HTTP redirect: '$loc'"

echo "Not reachable from outside"
curl -s -o /dev/null --max-time 5 "http://$ip:8000/" && bad "port 8000 answers from outside" || ok "port 8000 closed from outside"

echo "SSH"
ssh_as "$user@$ip" true && ok "$user logs in with the key" || bad "$user can't log in with the key"
ssh_as "root@$ip" true 2>/dev/null && bad "root logs in" || ok "root refused"
out="$(ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password,keyboard-interactive \
       -o PubkeyAuthentication=no -o BatchMode=yes -o ConnectTimeout=10 "$user@$ip" true 2>&1)"
[[ "$out" == *"Permission denied (publickey)"* ]] && ok "passwords refused (publickey only)" || bad "password logins: $out"
ssh_as "$user@$ip" sudo -n true && ok "$user has sudo without a password" || bad "$user has no sudo"

echo "On the server"
ssh_as "$user@$ip" 'sudo ss -Hltn' | awk '{ print $4 }' | grep -E ':8000$' | grep -vqE '^127\.0\.0\.1:8000$' \
    && bad "something listens on 8000 beyond 127.0.0.1" || ok "WebODM listens on 127.0.0.1:8000 only"
ssh_as "$user@$ip" 'sudo ufw status' | grep -q 'Status: active' && ok "ufw active" || bad "ufw inactive"
ssh_as "$user@$ip" 'sudo fail2ban-client status sshd' >/dev/null 2>&1 && ok "fail2ban sshd jail" || bad "no fail2ban sshd jail"
ssh_as "$user@$ip" 'apt-config dump | grep -q "cloudsmith/caddy/stable"' && ok "unattended upgrades include Caddy" || bad "unattended upgrades miss Caddy"
ssh_as "$user@$ip" 'swapon --show --noheadings | grep -q .' && ok "swap on" || bad "no swap"
tag="$(ssh_as "$user@$ip" 'sudo git -C /opt/WebODM describe --tags')"
[[ "$tag" == v* ]] && ok "WebODM at $tag" || bad "WebODM's checkout: '$tag'"

echo
[[ $failures == 0 ]] && echo "All checks passed" || { echo "$failures check(s) failed"; exit 1; }
