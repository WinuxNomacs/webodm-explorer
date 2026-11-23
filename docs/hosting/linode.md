# Hosting on Linode

This guide sets up a small server on [Linode](https://www.linode.com) (Akamai Cloud) that shares Explorer links with
anyone on the internet, while WebODM itself stays private. One script does the setup.

## What you get

```
Visitors --HTTPS--> Caddy --> link pages and their files --> WebODM
                        \---> everything else: 404
You --SSH tunnel-----------------------------------------> WebODM
```

- **Public:** the pages of Explorer's share links (`https://your-domain/plugins/explorer/s/...`), the files they load,
  and SSH (with keys only).
- **Private:** all of WebODM's own pages. You reach them through an SSH tunnel from your computer. Nobody else can
  reach the sign-in page, so it can't be guessed at.
- **No processing on the server.** Tasks are processed elsewhere (your own WebODM, or a processing service) and
  imported. This keeps the server small and cheap. You can add a processing node in WebODM later.

The script also sets up a firewall, fail2ban, automatic security updates (with a reboot at 04:00 when one needs
it), swap, and HTTPS with a Let's Encrypt certificate that renews by itself.

## What you need

- A Linode account.
- A domain name you can add a DNS record to, such as `maps.example.com`. Let's Encrypt needs a name, not an IP
  address.
- An SSH key on your computer (`ssh-keygen -t ed25519` makes one).
- Explorer's zip from the [releases](https://github.com/WinuxNomacs/webodm-explorer/releases).
- Your processed tasks, exported from WebODM (a task's **Download Assets > All Assets**), to import.

**Size and cost:** a Shared CPU **Linode 4 GB** (4 GB of memory, 2 CPUs) is a good start. At the time of writing it is
listed at $24 a month in US regions, and prices differ by region: check the Linode create page. In a test on a VM of that size (2 CPUs, 4 GB), the whole
server used at most 2.6 GB of memory while a visitor viewed a task and Explorer built its 3D Tiles; the build kept
both CPUs busy for a few minutes, and link pages still loaded in well under a second. The disk holds your
imported tasks and Explorer's 3D Tiles; resize the Linode or add a Block Storage volume when it fills up.

## 1. Create the Linode

In Linode's Cloud Manager, **Create Linode**:

1. **Image:** Ubuntu 24.04 LTS.
2. **Region:** close to your visitors.
3. **Plan:** Shared CPU, Linode 4 GB.
4. **Root Password:** a long random one, kept in your password manager. SSH won't take it (the script turns root and
   password logins off), but Linode's LISH console, your way in if SSH ever fails, signs in as root with it.
5. **SSH Keys:** add your public key. The script refuses to run without one, so that it can't lock you out.
6. **Add-ons, User Data** (optional): paste the [setup script](#the-script) with your settings filled in at the
   top. The Linode then sets itself up on first boot. Otherwise, run the script over SSH in step 3.
7. **Firewall:** create a Cloud Firewall that accepts TCP 22, 80 and 443 and UDP 443, and drops all other inbound
   traffic. The server's own firewall does the same; this one stops traffic before it reaches the server.

## 2. Point your domain at it

Add an **A record** for your name (for example `maps`) pointing at the Linode's IPv4 address, at your DNS provider
(or in Linode's **Domains**). Check it from your computer:

```bash
dig +short maps.example.com
```

It should print the Linode's address. The certificate can only be issued once it does. An **AAAA record** (IPv6) is
optional; if you add one, it must be the Linode's IPv6 address: Let's Encrypt tries IPv6 first, and the script warns
when it points elsewhere (`dig +short AAAA maps.example.com`).

## 3. Run the script

Skip this if you pasted the script as User Data: wait about ten minutes, then check its log (below).

Otherwise, from your computer:

```bash
ssh root@maps.example.com
curl -fsSLO https://winuxnomacs.github.io/webodm-explorer/linode/setup.sh
less setup.sh          # read it before you run it
DOMAIN=maps.example.com EMAIL=you@example.com bash setup.sh
```

`EMAIL` is for Let's Encrypt's expiry notices. The script takes 10 to 20 minutes, most of it downloading WebODM. It
ends by printing the next steps.

From now on, log in as `odm` (the script's user; set `ADMIN_USER` to choose another name), not root. If SSH says
"Too many authentication failures", your SSH agent offered other keys first: add `-o IdentitiesOnly=yes -i
~/.ssh/<your key>` to the command (fail2ban bans an address for an hour after 5 failed attempts).

```bash
ssh odm@maps.example.com
sudo tail -n 30 /var/log/explorer-setup.log    # the script's log
```

## 4. Sign in to WebODM through the tunnel

On your computer, open the tunnel and leave it running while you use WebODM:

```bash
ssh -N -L 8000:127.0.0.1:8000 odm@maps.example.com
```

Browse to `http://localhost:8000`. WebODM asks you to create its administrator account: do it now, with a strong
password.

::: tip
WebODM's sign-in and admin pages are only reachable through the tunnel. `https://maps.example.com/` answers "Not
found": that is expected.
:::

## 5. Install Explorer and set its public address

1. In WebODM (through the tunnel), **Administration > Plugins > Load Plugin (.zip)**, with Explorer's zip.
2. WebODM asks for a restart. From your computer:

   ```bash
   ssh odm@maps.example.com sudo webodm restart
   ```

   `webodm` is the script's short command for WebODM's `webodm.sh`, with this server's settings: always use it (or
   `cd /opt/WebODM && sudo ./webodm.sh restart --detached`), so WebODM keeps listening on localhost only. WebODM is
   back after a minute or so: reload the page (the tunnel can stay open).
3. Open **Explorer**, then **Settings**, and set **Public Address** to `https://maps.example.com`.

Without the Public Address, the links you copy would start with `http://localhost:8000`, the tunnel's address, which
works only on your computer.

## 6. Import tasks and share

1. In WebODM's Dashboard, create a project, then **Import** your tasks' **All Assets** zips.
2. In **Explorer**, open the project, then **Share > Anyone with the Link**: see [Sharing](/guide/sharing).
3. Open the copied link in a private window to see what visitors see.

The first time a textured model is opened, Explorer builds its 3D Tiles on the server (a minute or two per mesh).

## Keeping it running

- **Security updates** install by themselves every day, with a reboot at 04:00 (server time) when one needs it.
  WebODM starts again by itself. Set `AUTO_REBOOT=no` to reboot yourself instead.
- **Updating WebODM:** read WebODM's release notes, then run the script again with the new version, as your user:

  ```bash
  curl -fsSLO https://winuxnomacs.github.io/webodm-explorer/linode/setup.sh
  sudo WEBODM_VERSION=4.0.2 bash setup.sh
  ```

  The script keeps the settings of its last run in `/etc/explorer-setup.env` (set one in the command to change it),
  and the lines you changed in WebODM's `/opt/WebODM/.env` carry over to the new release.

  Don't use `webodm.sh update`: it moves to WebODM's newest images, past the release you chose.
- **Updating Explorer:** see [Getting Started, Upgrading](/getting-started#install).
- **Backups:** turn on Linode's Backups for the Linode, or follow
  [WebODM's backup steps](https://docs.webodm.org/installation/) for its database and media volumes.
- **Disk space:** `df -h /`. Imported tasks and 3D Tiles are in Docker's volumes under `/var/lib/docker`.

## What stays exposed

- **SSH**, with keys only and only for your user; fail2ban bans an address for an hour after 5 failed attempts.
- **The link paths.** A link's token is its only key: anyone who has it sees what it shares, until it expires or you
  revoke it. Treat links like passwords, and give them an expiry.
- **Plugins' script and style files**, which WebODM adds to every page, links included.
- Let's Encrypt publishes every certificate it issues, so your domain name is public once the certificate is issued.

## Troubleshooting

- **The browser says the connection isn't secure, or the certificate is missing:** DNS doesn't point at the server
  yet, or port 80 is blocked. Check `dig +short maps.example.com`, the Cloud Firewall, then
  `sudo journalctl -u caddy --since "10 min ago"`.
- **The script stopped:** it names the step that failed (`sudo tail -n 30 /var/log/explorer-setup.log`). Fix the
  cause and run it again, as your user once the SSH step is done (as root before it); finished steps are skipped
  and the settings of the first run are kept. Run over SSH: `sudo bash setup.sh`. Run as User Data: cloud-init keeps
  the script, settings included, as `/var/lib/cloud/instance/user-data.txt`:

  ```bash
  sudo bash /var/lib/cloud/instance/user-data.txt
  ```

- **`ssh -L` says the address is in use:** something on your computer already uses port 8000. Use another one:
  `ssh -N -L 8001:127.0.0.1:8000 ...` and `http://localhost:8001`.
- **Locked out of SSH:** use Linode's **Launch LISH Console** in Cloud Manager, which works without SSH: sign in as
  root with the Root Password.

## The script

[Download setup.sh](/webodm-explorer/linode/setup.sh){target="_self" download}. The settings at the top:

| Setting | Default | What it is |
|---|---|---|
| `DOMAIN` | none | The server's DNS name |
| `EMAIL` | none | For Let's Encrypt's notices |
| `ADMIN_USER` | `odm` | The user you log in as (sudo; gets root's SSH keys when the script creates it) |
| `WEBODM_VERSION` | `4.0.1` | The WebODM release to run (4.0.0 or later) |
| `TLS` | `acme` | `acme` for Let's Encrypt; `internal` for a test server without public DNS |
| `SWAP_GB` | `2` | Swap the server has in all: a swap file tops up Linode's own swap disk; `0` adds none |
| `AUTO_REBOOT` | `yes` | Reboot at 04:00 when an update needs it |
