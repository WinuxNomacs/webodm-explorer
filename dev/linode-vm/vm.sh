#!/usr/bin/env bash
# Tests docs/public/linode/setup.sh in a local Multipass VM (Ubuntu 24.04, 2 CPUs, 4 GB like a Linode 4 GB), run
# as cloud-init user data as on a Linode, with TLS=internal and the name explorer.test (no public DNS).
#   dev/linode-vm/vm.sh up       launch the VM with the script as user data, wait for it, print its log's end
#   dev/linode-vm/vm.sh e2e      the end to end check through the tunnel and the public name (e2e.js)
#   dev/linode-vm/vm.sh check    the network and SSH checks from this machine, after e2e (see check.sh)
#   dev/linode-vm/vm.sh rerun    run the script again over SSH: it must succeed and change nothing
#   dev/linode-vm/vm.sh ssh      a shell as the script's user, with the test key
#   dev/linode-vm/vm.sh down     delete the VM and its state
# State (a throwaway SSH key, the test admin's password, a task zip) is in ignored/linode-vm/, which git ignores.
# SSH commands share one connection (ControlPath /tmp/exvm-*: a socket path must be short), closed after 60 s idle.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
name="${EX_VM_NAME:-explorer-linode-test}"
state="$repo/ignored/linode-vm"
domain=explorer.test
user=odm
key="$state/id_ed25519"

# Saved at launch: once the script allows only its user over SSH, Multipass (which logs in as ubuntu) can't read the
# address after a reboot
vm_ip() {
    if [[ -s "$state/ip" ]]; then cat "$state/ip"; return; fi
    multipass info "$name" --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["'"$name"'"]["ipv4"][0])'
}
ssh_vm() { ssh -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o ControlMaster=auto -o ControlPath=/tmp/exvm-%C -o ControlPersist=60 "$user@$(vm_ip)" "$@"; }

case "${1:-}" in
up)
    command -v multipass >/dev/null || { echo "Multipass is needed: brew install --cask multipass"; exit 1; }
    mkdir -p "$state"
    [[ -f "$key" ]] || ssh-keygen -q -t ed25519 -N "" -C "explorer-linode-test" -f "$key"
    # The key goes to root, as Linode's SSH Keys field does; the script hands it on to its user
    python3 - "$repo/docs/public/linode/setup.sh" "$key.pub" "$state/cloud-init.yaml" "$domain" "$user" <<'PY'
import base64, sys
script, pub, out, domain, user = sys.argv[1:]
body = base64.b64encode(open(script, "rb").read()).decode()
open(out, "w").write(f"""#cloud-config
disable_root: false
users:
  - default
  - name: root
    ssh_authorized_keys:
      - {open(pub).read().strip()}
write_files:
  # Test only: Multipass keeps logging in as ubuntu (refused once the script allows only its user) and check.sh tries
  # root and passwords on purpose, so fail2ban would ban this machine; a Linode has neither
  - path: /etc/fail2ban/jail.d/zz-test-vm.local
    content: |
      [DEFAULT]
      ignoreip = 127.0.0.1/8 ::1 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12
  - path: /root/setup.sh
    permissions: "0700"
    encoding: b64
    content: {body}
runcmd:
  - [env, "TLS=internal", "DOMAIN={domain}", "ADMIN_USER={user}", "AUTO_REBOOT=no", bash, /root/setup.sh]
""")
PY
    multipass launch 24.04 --name "$name" --cpus 2 --memory 4G --disk 40G --cloud-init "$state/cloud-init.yaml" --timeout 2400
    vm_ip > "$state/ip"
    # The script's log, over SSH with the test key as its user (Multipass's own exec logs in as ubuntu, which the
    # script no longer allows)
    ssh_vm "cloud-init status --wait --long; sudo tail -n 25 /var/log/explorer-setup.log" || true
    echo "VM $name at $(vm_ip)"
    ;;
check) bash "$repo/dev/linode-vm/check.sh" "$(vm_ip)" "$key" "$domain" "$user" ;;
rerun)
    # The script as it is now in the repo, not the copy the VM booted with
    ssh_vm "sudo tee /root/setup.sh >/dev/null" < "$repo/docs/public/linode/setup.sh"
    # A line of WebODM's .env the server's owner changed: a run again keeps it
    ssh_vm "sudo sed -i '/^WO_TEST_KEEP=/d' /opt/WebODM/.env && echo WO_TEST_KEEP=yes | sudo tee -a /opt/WebODM/.env >/dev/null"
    # No settings given: the first run's stored ones apply
    ssh_vm "sudo bash /root/setup.sh" > "$state/rerun.log" 2>&1 \
        || { tail -n 20 "$state/rerun.log"; echo "FAIL: the second run failed"; exit 1; }
    if grep -E "Created $user|Gave $user|SSH reloaded|Added [0-9]+ MB of swap" "$state/rerun.log"; then echo "FAIL: the second run changed something"; exit 1; fi
    grep -q "Domain $domain, user $user, .*certificates: internal" "$state/rerun.log" || { echo "FAIL: the stored settings were not used"; exit 1; }
    ssh_vm "grep -qx WO_TEST_KEEP=yes /opt/WebODM/.env && grep -qx WO_PORT=127.0.0.1:8000 /opt/WebODM/.env" \
        || { echo "FAIL: WebODM's .env lost a line"; exit 1; }
    ssh_vm "sudo sed -i '/^WO_TEST_KEEP=/d' /opt/WebODM/.env"
    tail -n 3 "$state/rerun.log"; echo "OK: the second run used the stored settings, kept .env and changed nothing it shouldn't"
    ;;
e2e) node "$repo/dev/linode-vm/e2e.js" "$repo" "$(vm_ip)" "$key" "$domain" "$user" "$state" ;;
ssh) shift; ssh_vm "$@" ;;
down)
    multipass delete --purge "$name" 2>/dev/null || true
    rm -rf "${state:?}"
    echo "Deleted $name and $state"
    ;;
*) sed -n 2,11p "$0"; exit 1 ;;
esac
