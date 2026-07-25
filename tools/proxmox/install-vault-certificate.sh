#!/usr/bin/env bash

set -euo pipefail
umask 0077

readonly common_name="proxmox.dell-r730xd.home.arpa"
readonly ca_file="/etc/ssl/certs/ca-certificates.crt"
readonly state_directory="/var/lib/vault-agent-proxmox"
readonly backup_directory="${state_directory}/bootstrap-backup"
readonly installed_fingerprint_file="${state_directory}/installed.sha256"
readonly certificate_file="/etc/pve/local/pveproxy-ssl.pem"
readonly key_file="/etc/pve/local/pveproxy-ssl.key"

if [[ "$#" -ne 1 || ! -s "$1" ]]; then
  echo "Usage: $0 <Vault-rendered-certificate-bundle>" >&2
  exit 1
fi

readonly bundle_file="$1"

for command in curl cut flock openssl pvenode sha256sum systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

exec 9>"/run/lock/proxmox-vault-certificate-install.lock"
flock 9

work_directory="$(mktemp -d "$state_directory/.install.XXXXXX")"
# shellcheck disable=SC2329  # Invoked by the EXIT trap below.
cleanup() {
  rm -rf "$work_directory"
}
trap cleanup EXIT

awk '
  /-----BEGIN CERTIFICATE-----/ { certificates += 1; printing = 1 }
  printing { print }
  /-----END CERTIFICATE-----/ { printing = 0 }
' "$bundle_file" >"$work_directory/fullchain.pem"

awk '
  /-----BEGIN CERTIFICATE-----/ { certificates += 1; printing = certificates == 1 }
  printing { print }
  /-----END CERTIFICATE-----/ { if (printing) exit }
' "$bundle_file" >"$work_directory/leaf.pem"

awk '
  /-----BEGIN CERTIFICATE-----/ { certificates += 1; printing = certificates > 1 }
  printing { print }
  /-----END CERTIFICATE-----/ { printing = 0 }
' "$bundle_file" >"$work_directory/chain.pem"

awk '
  /-----BEGIN .*PRIVATE KEY-----/ { printing = 1 }
  printing { print }
  /-----END .*PRIVATE KEY-----/ { printing = 0 }
' "$bundle_file" >"$work_directory/key.pem"

chmod 0600 "$work_directory/key.pem"
chmod 0644 "$work_directory/leaf.pem" "$work_directory/chain.pem" "$work_directory/fullchain.pem"

openssl x509 -in "$work_directory/leaf.pem" -noout >/dev/null
openssl pkey -in "$work_directory/key.pem" -noout >/dev/null
openssl verify \
  -CAfile "$ca_file" \
  -untrusted "$work_directory/chain.pem" \
  -verify_hostname "$common_name" \
  "$work_directory/leaf.pem"

certificate_public_key="$(
  openssl x509 -in "$work_directory/leaf.pem" -pubkey -noout | openssl sha256
)"
private_public_key="$(
  openssl pkey -in "$work_directory/key.pem" -pubout | openssl sha256
)"

if [[ "$certificate_public_key" != "$private_public_key" ]]; then
  echo "Issued Proxmox certificate does not match its private key." >&2
  exit 1
fi

mark_installed() {
  sha256sum "$bundle_file" | cut -d ' ' -f 1 >"$work_directory/installed.sha256"
  install -o root -g root -m 0600 \
    "$work_directory/installed.sha256" \
    "$installed_fingerprint_file"
}

if [[ -s "$certificate_file" ]] \
  && [[ "$(
    openssl x509 -in "$certificate_file" -noout -fingerprint -sha256
  )" == "$(
    openssl x509 -in "$work_directory/leaf.pem" -noout -fingerprint -sha256
  )" ]]; then
  mark_installed
  exit 0
fi

if [[ ! -e "$backup_directory/completed" ]]; then
  install -d -o root -g root -m 0700 "$backup_directory"
  if [[ -s "$certificate_file" ]] && [[ -s "$key_file" ]]; then
    install -o root -g root -m 0644 \
      "$certificate_file" \
      "$backup_directory/pveproxy-ssl.pem"
    install -o root -g root -m 0600 \
      "$key_file" \
      "$backup_directory/pveproxy-ssl.key"
  fi
  printf 'Created before the first Vault Agent-managed certificate installation.\n' \
    >"$backup_directory/completed"
  chmod 0600 "$backup_directory/completed"
fi

pvenode cert set \
  "$work_directory/fullchain.pem" \
  "$work_directory/key.pem" \
  --force 1 \
  --restart 1

for _ in {1..30}; do
  if systemctl is-active --quiet pveproxy.service \
    && curl \
      --fail \
      --silent \
      --show-error \
      --cacert "$ca_file" \
      --connect-timeout 5 \
      --max-time 15 \
      --resolve "$common_name:8006:127.0.0.1" \
      --output /dev/null \
      "https://$common_name:8006/"; then
    mark_installed
    exit 0
  fi
  sleep 2
done

echo "Proxmox listener did not become healthy after certificate installation." >&2
exit 1
