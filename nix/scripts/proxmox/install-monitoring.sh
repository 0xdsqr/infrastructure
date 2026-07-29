#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root on the Proxmox node." >&2
  exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
readonly exporter_environment="/etc/default/prometheus-node-exporter"
readonly textfile_directory="/var/lib/prometheus/node-exporter"
readonly textfile_argument="--collector.textfile.directory=${textfile_directory}"
readonly loki_syslog_configuration="/etc/rsyslog.d/60-grafana-loki.conf"

for command in apt-get curl grep install lvs sed systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

for file in \
  "$script_directory/prometheus-lvm-thin-collector.sh" \
  "$script_directory/prometheus-lvm-thin-collector.service" \
  "$script_directory/prometheus-lvm-thin-collector.timer" \
  "$script_directory/rsyslog-loki.conf"; do
  if [[ ! -f "$file" ]]; then
    echo "Required file is missing: $file" >&2
    exit 1
  fi
done

if [[ ! -f "$exporter_environment" ]]; then
  echo "The prometheus-node-exporter environment file is missing." >&2
  exit 1
fi

if ! command -v rsyslogd >/dev/null 2>&1; then
  apt-get update
  apt-get install --yes --no-install-recommends rsyslog
fi

install -d -o root -g root -m 0755 /usr/local/libexec "$textfile_directory"
install -o root -g root -m 0755 \
  "$script_directory/prometheus-lvm-thin-collector.sh" \
  /usr/local/libexec/prometheus-lvm-thin-collector
install -o root -g root -m 0644 \
  "$script_directory/prometheus-lvm-thin-collector.service" \
  /etc/systemd/system/prometheus-lvm-thin-collector.service
install -o root -g root -m 0644 \
  "$script_directory/prometheus-lvm-thin-collector.timer" \
  /etc/systemd/system/prometheus-lvm-thin-collector.timer
install -o root -g root -m 0644 \
  "$script_directory/rsyslog-loki.conf" \
  "$loki_syslog_configuration"

if ! grep --quiet --fixed-strings -- "$textfile_argument" "$exporter_environment"; then
  sed -i \
    -E \
    "s|^ARGS=\"(.*)\"$|ARGS=\"\\1 ${textfile_argument}\"|" \
    "$exporter_environment"
fi

systemctl daemon-reload
systemctl restart prometheus-node-exporter.service
systemctl enable --now rsyslog.service
systemctl restart rsyslog.service
systemctl enable --now prometheus-lvm-thin-collector.timer
systemctl start prometheus-lvm-thin-collector.service

metrics_response="$(mktemp)"
readonly metrics_response
trap 'rm -f "$metrics_response"' EXIT

curl \
  --fail \
  --output "$metrics_response" \
  --silent \
  --show-error \
  http://127.0.0.1:9100/metrics
grep --quiet '^pve_lvmthin_metadata_percent{' "$metrics_response"

echo "Proxmox LVM-thin metrics are available through the existing node exporter."
echo "Proxmox system logs are queued locally and forwarded to Beacon over Tailscale."
