# Relay

The Publishing extension gives a test server a public name. Players connect to a **tunnel server**; your PC only ever
dials out to it, so your home address is in no DNS record and nothing is port-forwarded on your router.

The tunnel server runs [frps](https://github.com/fatedier/frp). It can be any machine that players can reach on a
public IP address. It does not have to be a VPS:

| Where | Notes |
|---|---|
| A cloud VM (any provider, including free tiers) | Easiest. Run `setup.sh` |
| A container host | Use `docker-compose.yml` here |
| A Raspberry Pi or home server | Forward the control port and your tunnel port range on the router to it. Your home IP is then the public address |
| A machine on a Tailscale network | Use its Tailscale address as the **Tunnel server address** and its public address as **Public address** |

## What you need on it

- frps listening on a control port (default 7000) with a shared token.
- A range of ports (default 25700-25799) open to players. One port is used per published server.

## Option 1: `setup.sh` (Debian or Ubuntu)

```
sudo bash setup.sh
```

It installs frps as a service, restricted to the port range, with a random token, and prints what to paste into
**Extensions > Publishing**. Run it again to upgrade or change the range; the token is kept. See the header of the
script for binding the control port to a private address.

## Option 2: Docker

Not tested on every setup yet. If it does not work for you, `setup.sh` or running frps by hand does.

```
FRPS_TOKEN=$(openssl rand -hex 24) docker compose up -d
echo "token: $FRPS_TOKEN"
```

## Cleaning up stale names (optional)

If the app crashes, DNS records it made can be left behind. `reaper.py` (installed by `reaper-install.sh`) deletes
records whose tunnel is gone. Run it on a machine you trust: it holds a Cloudflare token that can edit the zone.
The app also removes its own leftovers the next time it starts.

## Settings in the app

| Setting | Value |
|---|---|
| Tunnel server address | How your PC reaches the control port |
| Public address | Where players reach it, if different (DNS points here) |
| frps control port | 7000 unless you changed it |
| Tunnel token | The token from setup |
| First and last tunnel port | The range you opened |
