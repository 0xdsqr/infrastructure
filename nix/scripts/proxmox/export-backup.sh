#!/usr/bin/env bash

set -euo pipefail
umask 0077

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this exporter as root on the Proxmox node." >&2
  exit 1
fi

exec tar \
  --create \
  --gzip \
  --file=- \
  --ignore-failed-read \
  /etc/pve \
  /etc/network/interfaces \
  /etc/hosts \
  /etc/resolv.conf \
  /etc/apt \
  /etc/systemd/system
