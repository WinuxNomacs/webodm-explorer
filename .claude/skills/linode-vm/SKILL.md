---
name: linode-vm
description: Test the Linode setup script (docs/public/linode/setup.sh) in a local Multipass VM run as cloud-init user data - launch, end to end through the SSH tunnel and the public name, outside checks, a second run, a reboot - then delete the VM. Use after changing the script or the hosting guide.
---

# Linode script in a VM

Needs Multipass (`brew install --cask multipass`, installed by the user), Docker (ShellCheck), the dev stack running
(the end to end test imports task 819e6ca7 of its project 2, read-only), and `dist/explorer-*.zip`
(`dev/package.sh`). The VM: Ubuntu 24.04, 2 CPUs, 4 GB (a Linode 4 GB), name `explorer.test`, `TLS=internal`.

1. Lint: `docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:v0.11.0 /mnt/docs/public/linode/setup.sh /mnt/dev/linode-vm/vm.sh /mnt/dev/linode-vm/check.sh`
2. `dev/linode-vm/vm.sh up` (10-20 minutes; run in the background): the script as user data, as on a Linode. It
   ends with the script's log: every step, then "Done".
3. `WO_USER=... WO_PASS=... dev/linode-vm/vm.sh e2e` (the dev login from memory): creates WebODM's admin through
   the tunnel, installs the zip through Administration > Plugins, `sudo webodm restart`, Public Address, imports the
   task, creates a link, opens it as a visitor on the public name (page, map, each 3D view, mesh tiles), lists what
   the proxy refused, measures memory.
4. `dev/linode-vm/vm.sh check` (after e2e): what the internet reaches (only the link paths; sign-in, admin, API and
   traversal attempts 404), port 8000 closed, SSH (root and passwords refused), ufw, fail2ban, unattended upgrades.
5. `dev/linode-vm/vm.sh rerun`: the current script again over SSH; it must change nothing.
6. Reboot (`vm.sh ssh 'sudo systemctl reboot'`), then `explorer.css` answers through the proxy again and `check`
   passes.
7. `dev/linode-vm/vm.sh down` deletes the VM and `ignored/linode-vm/` (key, test admin password, task zip).

Known in this environment, not on a Linode:

- Multipass logs in as `ubuntu`, which the script refuses: `multipass exec`/`shell` and `multipass info`'s address
  stop working. The harness uses its own key as the script's user and the address saved at launch.
- fail2ban would ban this machine (Multipass's attempts, and check.sh's root and password tries): the harness's
  cloud-init adds a test-only `ignoreip` for private networks.
- macOS can briefly answer "No route to host" for the VM after refused connections; retry after a minute.
