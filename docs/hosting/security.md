# Security

Explorer's links are made to be opened by people outside your organisation, which means WebODM answers requests from
the internet. Use Explorer only where one of these holds:

- **WebODM is on a trusted network**: your office network or a VPN, where everyone who can reach it is someone you
  would let in anyway; or
- **WebODM sits behind a properly secured front end** you control: a reverse proxy with HTTPS and security headers,
  a web application firewall (WAF), and rules that let the public reach only what links need, in front of WebODM's
  own web server (Gunicorn running WebODM's WSGI application, behind its nginx).

Don't rely on WebODM's security alone. This page explains why, and what to put in place. It is general guidance, not
an audit of your installation: check your setup against the standards under [References](#references).

## Why WebODM alone isn't enough

WebODM is a capable processing platform, but its web settings favour easy setup over defence on the open internet.
In WebODM 4.0.1 (read from its source, `webodm/settings.py` and `nginx/`):

- **It accepts requests from any website, with the user's session.** WebODM allows cross-origin requests from every
  origin with credentials (`CORS_ALLOW_ALL_ORIGINS`, `CORS_ALLOW_CREDENTIALS`) and sends its session cookie with
  `SameSite=None`. A page on another site that a signed-in user visits can call WebODM's API as that user. Changes
  still need WebODM's CSRF token; reading is not protected the same way. (Explorer's own APIs refuse requests that
  browsers mark as cross-site.)
- **It answers for any host name** (`ALLOWED_HOSTS = ['*']`), so Django's protection against forged `Host` headers
  is off.
- **We found no limit on failed sign-in attempts** in its settings: nothing slows down someone guessing passwords
  at `/login/` or the API.
- **Its pages can be framed by any site.** WebODM doesn't send `X-Frame-Options` or a frame-ancestors policy, which
  leaves its own pages open to clickjacking. (Explorer's signed-in pages send their own.)
- **HTTPS is off by default** (`WO_SSL=NO`). Only with `WO_SSL=YES` are its cookies marked `Secure`; it sends no
  Strict-Transport-Security or Content-Security-Policy header.
- **Uploads have no size limit** at its nginx (`client_max_body_size 0`).

None of this is unusual for software meant to run on a local network, and WebODM may change it in later releases.
It does mean the protection a public site needs has to come from in front of WebODM.

## What Explorer does

- A link's token is 256 random bits; a link serves only its project's views (and, with **Allow Downloads**, the
  output files), never WebODM's own pages or other projects.
- Links can expire, can be revoked at once, and can **Require Sign-In**; an admin can limit links of private
  projects with **Links to Private Projects** ([Administration](/guide/administration)).
- Link pages ask search engines not to index them, don't pass the token on in `Referer` headers, and are never kept
  by shared caches.
- Explorer's APIs refuse cross-site requests and need WebODM's CSRF token for changes; its signed-in pages can't be
  framed by other sites.

These protect the links. They don't protect the rest of WebODM, which is why the front end below matters.

## What to put in place

1. **Keep WebODM itself private.** Let the public reach only Explorer's link paths (`/plugins/explorer/s/...`) and
   the files they load, and reach WebODM's own pages through a VPN or an SSH tunnel.
   [Hosting on Linode](/hosting/linode) sets this up with Caddy. Links with **Require Sign-In** need WebODM's
   sign-in page (`/login/`) public as well, behind the protections below; where it stays private, use links without
   it.
2. **Put a reverse proxy in front** that terminates HTTPS with a current configuration (Mozilla's TLS guidelines),
   redirects HTTP to HTTPS, and adds security headers: Strict-Transport-Security, `X-Frame-Options` or a
   `frame-ancestors` policy for WebODM's pages (not for link pages, if you embed them), `X-Content-Type-Options`, and
   a Content-Security-Policy where you can test it. Refuse unknown host names at the proxy, since WebODM accepts any.
3. **Add a web application firewall.** The OWASP Core Rule Set (with ModSecurity or Coraza), or your cloud
   provider's managed WAF, blocks common attack patterns before they reach WebODM. Start in detection mode, check
   that link pages, 3D Tiles and point cloud streaming aren't blocked, then enforce.
4. **Limit request rates**, above all on `/login/` and `/api/`, and set an upload size limit that fits your largest
   image sets.
5. **Protect accounts.** Strong, unique passwords; few superusers; and, where you can, sign-in through an identity
   provider with multi-factor authentication (WebODM supports OpenID Connect). Remember that **Require Sign-In**
   links admit any account on your WebODM.
6. **Keep everything current**: WebODM, Explorer, Docker and the host system, with automatic security updates where
   possible. Keep backups, and watch the proxy's and WebODM's logs for unusual traffic.
7. **Use links carefully.** Give them an expiry, use **Require Sign-In** for anything sensitive, revoke links you no
   longer need, and treat a link like a password to the project's results.

## References

Web application security:

- [OWASP Top 10:2025](https://owasp.org/www-project-top-ten/): the most critical web application security risks.
- [OWASP Application Security Verification Standard (ASVS) 5.0](https://owasp.org/www-project-application-security-verification-standard/):
  requirements to test a web application's security controls against.
- [OWASP API Security Project](https://owasp.org/www-project-api-security/): the risks specific to APIs such as
  WebODM's.
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/), in particular
  [Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
  [HTTP Strict Transport Security](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html),
  [Content Security Policy](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
  and [Clickjacking Defense](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html).
- [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/): which response headers to set, and
  how.
- [OWASP Core Rule Set](https://coreruleset.org/): open WAF rules for ModSecurity, Coraza and compatible firewalls.

Servers, TLS and identity:

- [Mozilla Server Side TLS guidelines](https://wiki.mozilla.org/Security/Server_Side_TLS) and
  [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/): current TLS settings for nginx, Caddy,
  Apache, HAProxy and others.
- [MDN HTTP Observatory](https://observatory.mozilla.org/): checks a public site's HTTPS and security headers.
- [NIST SP 800-63B-4, Digital Identity Guidelines: Authentication](https://csrc.nist.gov/pubs/sp/800/63/b/4/final)
  (2025): passwords, multi-factor authentication and sessions.
- [NIST SP 800-44 Version 2, Guidelines on Securing Public Web Servers](https://csrc.nist.gov/pubs/sp/800/44/ver2/final)
  (2007; older, but its planning and hardening steps still apply).
- [CIS Critical Security Controls v8.1](https://www.cisecurity.org/controls) and
  [CIS Benchmarks](https://www.cisecurity.org/cis-benchmarks): prioritised safeguards, and hardening guides for
  Ubuntu, Docker, nginx and more.

Django and WebODM:

- [Django deployment checklist](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/) and
  [Security in Django](https://docs.djangoproject.com/en/5.2/topics/security/): what WebODM's framework expects
  of a production deployment.
- [WebODM installation](https://docs.webodm.org/installation/): its options for HTTPS, ports and backups.
