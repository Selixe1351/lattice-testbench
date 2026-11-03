#!/usr/bin/env python3
"""Deletes Testbench DNS records whose tunnel is gone.

The app removes its records on unpublish, delete and quit, but not when the PC loses power, crashes or
is offline at that moment. Those records then point at a relay port that nothing serves, and a later
publish can be given the same port, so the old name would reach somebody else's test server. This runs
every minute on a trusted box (not the relay, whose IP is public) and judges each testbench- name by
whether frps still has a tunnel of that name online, never by who made it.

A name is deleted when its tunnel has been missing for GRACE_SECONDS (long enough to ride out a Wi-Fi
drop, after which frpc reconnects), or at once when its SRV port is now served by a different tunnel.
If frps cannot be asked, nothing is deleted: being blind is not evidence that a tunnel is gone.

Configuration comes from the environment (see reaper-install.sh, which writes /etc/lattice-reaper.env):
  CF_TOKEN      Cloudflare API token with Zone > DNS > Edit on CF_ZONE
  CF_ZONE       the domain, e.g. example.net
  FRPS_API      e.g. http://100.64.0.1:7500
  FRPS_USER, FRPS_PASSWORD   the webServer credentials in the relay's /etc/frp/frps.toml
  GRACE_SECONDS default 600
  STATE_FILE    default /var/lib/lattice-reaper/state.json
"""
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

PREFIX = "testbench-"
SRV_PREFIX = "_minecraft._tcp."
CF_API = "https://api.cloudflare.com/client/v4"


def request(url, headers, method="GET"):
    req = urllib.request.Request(url, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)


def cloudflare(path, method="GET"):
    body = request(f"{CF_API}{path}", {"Authorization": f"Bearer {os.environ['CF_TOKEN']}"}, method)
    if not body.get("success"):
        raise RuntimeError(f"Cloudflare {method} {path}: {body.get('errors')}")
    return body["result"]


def live_tunnels():
    """Online tunnel names and the remote port each one holds."""
    auth = base64.b64encode(f"{os.environ['FRPS_USER']}:{os.environ['FRPS_PASSWORD']}".encode()).decode()
    body = request(f"{os.environ['FRPS_API'].rstrip('/')}/api/proxy/tcp", {"Authorization": f"Basic {auth}"})
    online = {}
    for proxy in body.get("proxies") or []:
        if proxy.get("status") == "online":
            online[proxy["name"]] = (proxy.get("conf") or {}).get("remotePort")
    return online


def label_of(record):
    """testbench-ab12 for both testbench-ab12.example.net and its _minecraft._tcp record."""
    name = record["name"]
    if name.startswith(SRV_PREFIX):
        name = name[len(SRV_PREFIX):]
    return name.split(".", 1)[0]


def main():
    if not os.environ.get("CF_TOKEN") or not os.environ.get("FRPS_PASSWORD"):
        print("Not configured yet: set CF_TOKEN and FRPS_PASSWORD in /etc/lattice-reaper.env", file=sys.stderr)
        return 0
    zone_name = os.environ["CF_ZONE"]
    grace = int(os.environ.get("GRACE_SECONDS", "600"))
    state_file = os.environ.get("STATE_FILE", "/var/lib/lattice-reaper/state.json")

    try:
        online = live_tunnels()
    except Exception as error:  # noqa: BLE001 - any failure here means "do not delete", which is logged
        print(f"frps did not answer, deleting nothing: {error}", file=sys.stderr)
        return 0

    zones = cloudflare(f"/zones?name={urllib.parse.quote(zone_name)}")
    if not zones:
        print(f"No Cloudflare zone named {zone_name} for this token", file=sys.stderr)
        return 1
    zone = zones[0]["id"]

    records = []
    for prefix in (PREFIX, SRV_PREFIX + PREFIX):
        query = urllib.parse.urlencode({"name.startswith": prefix, "per_page": 100})
        records += [r for r in cloudflare(f"/zones/{zone}/dns_records?{query}") if r["name"].endswith("." + zone_name)]

    by_label = {}
    for record in records:
        by_label.setdefault(label_of(record), []).append(record)

    try:
        with open(state_file) as f:
            missing_since = json.load(f)
    except FileNotFoundError:
        missing_since = {}
    except ValueError as error:
        print(f"Ignoring unreadable {state_file}: {error}", file=sys.stderr)
        missing_since = {}

    now = time.time()
    holders = {port: name for name, port in online.items() if port}
    next_state = {}
    for label, group in sorted(by_label.items()):
        if label in online:
            continue
        since = missing_since.get(label, now)
        srv_ports = [r["data"]["port"] for r in group if r["type"] == "SRV" and r.get("data")]
        taken = any(holders.get(port) not in (None, label) for port in srv_ports)
        if now - since < grace and not taken:
            next_state[label] = since
            continue
        reason = "its port now serves another tunnel" if taken else f"no tunnel for {int(now - since)}s"
        failed = False
        for record in group:
            try:
                cloudflare(f"/zones/{zone}/dns_records/{record['id']}", "DELETE")
            except Exception as error:  # noqa: BLE001 - kept in state and retried next run
                print(f"Could not delete {record['name']}: {error}", file=sys.stderr)
                failed = True
        if failed:
            next_state[label] = since
        else:
            print(f"Deleted {label} ({len(group)} records): {reason}")

    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file + ".part", "w") as f:
        json.dump(next_state, f)
    os.replace(state_file + ".part", state_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
