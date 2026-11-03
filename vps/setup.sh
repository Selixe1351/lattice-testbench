#!/usr/bin/env bash
# Sets up frps on a fresh Debian or Ubuntu VPS so the Lattice Testbench can publish servers through it.
#
#   curl -fsSL <this file> | sudo bash        or        sudo bash setup.sh
#
# Optional: CONTROL_PORT=7000 FIRST_PORT=25700 LAST_PORT=25799 sudo -E bash setup.sh
#
# To keep the control port off the internet, bind it to a tailnet address and the player ports to the
# public one, then give Lattice Testbench the tailnet address as "VPS address" and the public one as
# "Public VPS address":
#
#   BIND_ADDR=100.64.0.1 PROXY_BIND_ADDR=203.0.113.7 sudo -E bash setup.sh
#
# frps also serves its status API on BIND_ADDR (127.0.0.1 when that is 0.0.0.0), port API_PORT, with a
# generated password kept in the config. vps/reaper.py reads it to tell which published names still have
# a live tunnel.
#
# It installs frps as a service, restricted to the port range, with a random token. The token is printed
# at the end: paste it into Lattice Testbench under Extensions > Publishing. Run it again to upgrade or to
# change the range; the existing token is kept.
set -euo pipefail

FRP_VERSION="0.71.1"
FRP_SHA256="1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803"
CONTROL_PORT="${CONTROL_PORT:-7000}"
FIRST_PORT="${FIRST_PORT:-25700}"
LAST_PORT="${LAST_PORT:-25799}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
PROXY_BIND_ADDR="${PROXY_BIND_ADDR:-0.0.0.0}"
API_PORT="${API_PORT:-7500}"
if [ "$BIND_ADDR" = "0.0.0.0" ]; then API_ADDR="127.0.0.1"; else API_ADDR="$BIND_ADDR"; fi
CONFIG_DIR="/etc/frp"
CONFIG="$CONFIG_DIR/frps.toml"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this as root (sudo)." >&2
    exit 1
fi
if [ "$(uname -m)" != "x86_64" ]; then
    echo "This script installs the x86_64 build of frp; this machine is $(uname -m)." >&2
    exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading frp $FRP_VERSION..."
curl -fsSL -o "$work/frp.tar.gz" "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz"
echo "$FRP_SHA256  $work/frp.tar.gz" | sha256sum -c -
tar -xzf "$work/frp.tar.gz" -C "$work"
install -m 0755 "$work/frp_${FRP_VERSION}_linux_amd64/frps" /usr/local/bin/frps

mkdir -p "$CONFIG_DIR"
if [ -f "$CONFIG" ] && grep -q '^auth.token' "$CONFIG"; then
    TOKEN="$(sed -n 's/^auth.token = "\(.*\)"/\1/p' "$CONFIG")"
else
    TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if [ -f "$CONFIG" ] && grep -q '^webServer.password' "$CONFIG"; then
    API_PASSWORD="$(sed -n 's/^webServer.password = "\(.*\)"/\1/p' "$CONFIG")"
else
    API_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

umask 077
cat > "$CONFIG" <<EOF
bindAddr = "${BIND_ADDR}"
bindPort = ${CONTROL_PORT}
proxyBindAddr = "${PROXY_BIND_ADDR}"
auth.method = "token"
auth.token = "${TOKEN}"

# Status API for the DNS reaper. Never on a public address.
webServer.addr = "${API_ADDR}"
webServer.port = ${API_PORT}
webServer.user = "reaper"
webServer.password = "${API_PASSWORD}"

# Only these ports can be opened, whatever a client asks for.
allowPorts = [
  { start = ${FIRST_PORT}, end = ${LAST_PORT} }
]
EOF

cat > /etc/systemd/system/frps.service <<EOF
[Unit]
Description=frp server for Lattice Testbench
# tailscaled too, for when frps binds a tailnet address; harmless where there is none.
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/frps -c ${CONFIG}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now frps
systemctl restart frps

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    if [ "$BIND_ADDR" = "0.0.0.0" ]; then
        ufw allow "${CONTROL_PORT}/tcp" >/dev/null
        echo "ufw: opened ${CONTROL_PORT}."
    else
        # Only on the interface that holds the address, so the rule cannot open it anywhere else.
        iface="$(ip -o -4 addr show | awk -v a="$BIND_ADDR" '$4 ~ "^"a"/" {print $2; exit}')"
        if [ -z "$iface" ]; then
            echo "No interface has the address $BIND_ADDR." >&2
            exit 1
        fi
        ufw allow in on "$iface" to any port "${CONTROL_PORT}" proto tcp >/dev/null
        ufw allow in on "$iface" to any port "${API_PORT}" proto tcp >/dev/null
        echo "ufw: opened ${CONTROL_PORT} and ${API_PORT} on ${iface} only."
    fi
    ufw allow "${FIRST_PORT}:${LAST_PORT}/tcp" >/dev/null
    echo "ufw: opened ${FIRST_PORT}-${LAST_PORT}."
else
    if [ "$BIND_ADDR" = "0.0.0.0" ]; then
        echo "Open ${CONTROL_PORT}/tcp and ${FIRST_PORT}-${LAST_PORT}/tcp in your VPS provider's firewall if it has one."
    else
        echo "Open ${FIRST_PORT}-${LAST_PORT}/tcp in your VPS provider's firewall if it has one. ${CONTROL_PORT} stays closed: it is on ${BIND_ADDR} only."
    fi
fi

echo
echo "frps is running."
if [ "$BIND_ADDR" = "0.0.0.0" ]; then
    echo "  VPS address : $(curl -fsS https://api.ipify.org 2>/dev/null || echo '<this server address>')"
else
    echo "  VPS address : ${BIND_ADDR}"
    echo "  Public VPS address : $([ "$PROXY_BIND_ADDR" = "0.0.0.0" ] && curl -fsS https://api.ipify.org 2>/dev/null || echo "$PROXY_BIND_ADDR")"
fi
echo "  frps port   : ${CONTROL_PORT}"
echo "  Port range  : ${FIRST_PORT}-${LAST_PORT}"
echo "  Token       : ${TOKEN}"
