# Networking

Three things may need to be reachable, and they have genuinely different
requirements. Deciding which of them you actually need is most of the work.

| Thing | Who reaches it | Needs HTTPS? | Needs to be public? |
| --- | --- | --- | --- |
| The **bot** | Nothing inbound — it long-polls Telegram | no | **no** |
| The **dashboard** | You | only if not on loopback | no |
| The **Mini App** | Telegram, on a phone | **yes, always** | yes |
| **Jellyfin** | Your users' players | no on a LAN | only if they are away |

The bot needs no inbound connectivity at all. That is deliberate: long polling
means a home server behind NAT works with no port forwarding, no dynamic DNS and
no certificate.

## The dashboard

Binds `127.0.0.1:8300` by default (`ADMIN_BIND_HOST`, `ADMIN_PORT`).

Reaching it from another machine, in rising order of exposure:

**An SSH tunnel** — nothing to configure, nothing exposed:

```bash
ssh -N -L 8300:127.0.0.1:8300 you@server
# then http://127.0.0.1:8300 on your laptop
```

**A private network** (Tailscale, WireGuard, ZeroTier). Bind to the overlay
interface, or to `0.0.0.0` if the machine's other interfaces are firewalled.

**A reverse proxy with TLS.** See [deploy/README.md](../deploy/README.md) for a
worked nginx example. Then, *after* confirming HTTPS works:

```env
ADMIN_COOKIE_SECURE=true
TRUST_PROXY=true
```

Both, together. `TRUST_PROXY` matters as much as the cookie: without it every
request appears to arrive from `127.0.0.1`, so the login rate limiter counts the
whole internet as one client and the audit log records the proxy instead of the
caller.

**Order matters.** A Secure cookie is never sent back over plain HTTP, so
setting `ADMIN_COOKIE_SECURE=true` before TLS actually works looks exactly like
a wrong password. Verify the HTTPS path first, then flip the flag, and revert it
if sign-in breaks.

`ADMIN_COOKIE_SECURE` also controls whether the CSP emits
`upgrade-insecure-requests`. Sending that on a plain-HTTP port makes the browser
rewrite every asset URL to `https://`, and the page renders blank with
`ERR_SSL_PROTOCOL_ERROR` in the console. `npm run test:http` covers it.

## The Mini App

Telegram will only open an **https** URL with a certificate it trusts. It will
not open plain HTTP, a bare IP address, or a self-signed certificate. There is
no way around this, which is why `MINIAPP_URL` is empty by default and no menu
button is registered until you set it.

Three ways to get one:

### A domain and a reverse proxy

The conventional answer. A domain you own, a certificate from Let's Encrypt, and
nginx or Caddy in front of `127.0.0.1:8300`.

Exposes: whatever you proxy, to the whole internet. The dashboard is behind a
password and rate-limited login, but it is reachable. Proxy only `/app` and
`/api/miniapp` if you want the Mini App public and the dashboard not.

### An outbound tunnel

Cloudflare Tunnel, ngrok, or similar. No inbound ports, no port forwarding, a
certificate handled for you.

Exposes: the same surface, plus a dependency on a third party who can see the
traffic.

### Tailscale Funnel

If you already run Tailscale:

```bash
# Tailnet only — your devices, nothing public.
tailscale serve  --bg --https=8443 http://127.0.0.1:8300

# Public — required for the Mini App, since Telegram is not on your tailnet.
tailscale funnel --bg --https=8443 http://127.0.0.1:8300
tailscale funnel status
```

```env
MINIAPP_URL=https://<host>.<tailnet>.ts.net:8443/app
```

Restart the bot afterwards so it registers the button.

Note the distinction: `serve` is tailnet-only and is enough for the dashboard on
your own devices; the Mini App needs `funnel`, because the phone loads it
through Telegram's own webview from outside your tailnet.

Exposes: that port, publicly, on a `ts.net` hostname.

## Jellyfin from a phone or a TV

Jellyfin is a separate service with its own network configuration; this
application only needs to *know* the addresses, not provide them.

Set as many of the three as apply:

```env
JELLYFIN_PUBLIC_URL=http://192.0.2.10:8096          # the LAN
JELLYFIN_TAILSCALE_URL=https://jellyfin.tailnet.ts.net:8443
JELLYFIN_INTERNET_URL=https://jellyfin.example.com
```

The Mini App's "Open Jellyfin" button **measures** rather than assumes. It probes
in the order **tailscale → lan → internet** and opens the first that answers, so
a phone at home takes the fast local route and the same phone elsewhere still
works — without the user choosing, and without this application knowing where
the phone is.

Only set the ones that are real. An address that never answers costs a probe
timeout on every open.

If your LAN address comes from DHCP, reserve it on your router or set it
statically. Otherwise every saved server entry in every Jellyfin client breaks
when the lease changes.

## Exposing Jellyfin to the internet

A real decision, not a configuration step. Jellyfin's own documentation covers
it; the relevant points here:

- Put TLS in front of it. Jellyfin speaks plain HTTP by default.
- Every account is only as strong as its password, and this application does not
  set Jellyfin passwords.
- The per-library isolation this application enforces still holds. Exposure
  changes *who can attempt to log in*, not what a logged-in account can see.

`deploy/jellyfin-geofence.mjs` narrows the attack surface by filling Jellyfin's
`RemoteIPFilter` with the address blocks a regional registry has assigned to one
country, plus your own private ranges:

```bash
node deploy/jellyfin-geofence.mjs --country DE                 # report only
node deploy/jellyfin-geofence.mjs --country DE --apply \
     --must-include 203.0.113.9
```

It is **noise reduction, not a security boundary**: addresses are spoofable and
your own users travel. `--must-include` should be an address you have actually
connected from — the script refuses to write a list that would not contain it,
because the failure mode of a country fence is locking out its owner.

## Firewall

A reasonable baseline, assuming the dashboard is on loopback or a private
network:

```bash
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow 8096/tcp        # Jellyfin, only if you serve the LAN
sudo ufw enable
```

Nothing needs to be opened for the bot. If you use Tailscale, `tailscale0`
traffic bypasses these rules by design — allow it explicitly or not, depending
on how much you trust every device on your tailnet.

Jellyfin's client auto-discovery uses UDP 7359. Leaving it closed simply means
clients need the URL typed in rather than finding the server in a list.

## Ports in use

| Port | What | Default binding |
| --- | --- | --- |
| 8300 | This application's API, dashboard, Mini App and ingest | `ADMIN_BIND_HOST` |
| 8096 | Jellyfin | Jellyfin's own configuration |
| 8081 | Local Bot API server | loopback only — every request carries the bot token in its path |
| 55432 | The bundled PostgreSQL container | loopback only |

The local Bot API server must **never** be reachable from the network: its URLs
contain the bot token. The shipped compose file binds it to `127.0.0.1`
explicitly for that reason.
