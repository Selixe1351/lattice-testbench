#!/usr/bin/env bash
# Installs reaper.py as a systemd timer that runs every minute. Run on a trusted box that can reach the
# relay's frps API over the tailnet - not on the relay itself, whose IP is public, because the reaper holds
# a Cloudflare token that can edit the whole zone.
#
#   scp reaper.py reaper-install.sh root@box:/root/ && ssh root@box bash /root/reaper-install.sh
#
# The first run writes /etc/lattice-reaper.env with empty values; fill it in and the next minute picks
# it up. Running again upgrades the script and keeps the env file.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this as root (sudo)." >&2
    exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"

install -d /usr/local/lib/lattice-reaper /var/lib/lattice-reaper
install -m 0755 "$here/reaper.py" /usr/local/lib/lattice-reaper/reaper.py

ENV=/etc/lattice-reaper.env
if [ ! -f "$ENV" ]; then
    umask 077
    cat > "$ENV" <<'EOF'
CF_TOKEN=
CF_ZONE=example.net
FRPS_API=http://100.64.0.1:7500
FRPS_USER=reaper
FRPS_PASSWORD=
GRACE_SECONDS=600
EOF
    echo "Wrote $ENV: fill in CF_TOKEN and FRPS_PASSWORD."
fi

cat > /etc/systemd/system/lattice-reaper.service <<'EOF'
[Unit]
Description=Delete Lattice Testbench DNS records whose tunnel is gone
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/lattice-reaper.env
ExecStart=/usr/bin/python3 /usr/local/lib/lattice-reaper/reaper.py
NoNewPrivileges=true
EOF

cat > /etc/systemd/system/lattice-reaper.timer <<'EOF'
[Unit]
Description=Run the Lattice Testbench DNS reaper every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now lattice-reaper.timer
echo "Installed. Logs: journalctl -u lattice-reaper"
