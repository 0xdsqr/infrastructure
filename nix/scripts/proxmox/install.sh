#!/usr/bin/env bash

set -euo pipefail
umask 0077

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root on the Proxmox node." >&2
  exit 1
fi

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <dsqr-home-root-ca.pem> <proxmox-vault-pki.env>" >&2
  exit 1
fi

readonly vault_version="2.0.3"
readonly vault_archive="vault_${vault_version}_linux_amd64.zip"
readonly vault_archive_sha256="1e0ffb7a82491219c7242da6e05e2d756b05d1097c29799a42228661f229bc2a"
readonly vault_download_url="https://releases.hashicorp.com/vault/${vault_version}/${vault_archive}"

readonly root_ca_source="$1"
readonly environment_source="$2"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory
readonly configuration_directory="/etc/vault-agent-proxmox"
readonly state_directory="/var/lib/vault-agent-proxmox"
readonly request_fingerprint_file="${state_directory}/request.sha256"
readonly certificate_bundle="${state_directory}/certificate-bundle.pem"
readonly installed_fingerprint_file="${state_directory}/installed.sha256"
request_fingerprint="$({
  printf '%s\0' "$vault_version"
  sha256sum "$script_directory/vault-agent.hcl"
} | sha256sum | cut -d ' ' -f 1)"
readonly request_fingerprint

for command in cmp curl openssl python3 sha256sum systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done

for file in \
  "$root_ca_source" \
  "$script_directory/install-vault-certificate.sh" \
  "$script_directory/proxmox-vault-agent.service" \
  "$script_directory/vault-agent.hcl"; do
  if [[ ! -f "$file" ]]; then
    echo "Required file is missing: $file" >&2
    exit 1
  fi
done

openssl x509 -in "$root_ca_source" -noout >/dev/null

role_id=""
secret_id=""
if [[ -f "$environment_source" ]]; then
  role_id="$(sed -n 's/^VAULT_ROLE_ID=//p' "$environment_source")"
  secret_id="$(sed -n 's/^VAULT_SECRET_ID=//p' "$environment_source")"
elif [[ -s "$configuration_directory/role-id" ]] \
  && [[ -s "$configuration_directory/secret-id" ]]; then
  role_id="$(<"$configuration_directory/role-id")"
  secret_id="$(<"$configuration_directory/secret-id")"
else
  echo "Missing AppRole environment file and installed Vault Agent credentials." >&2
  exit 1
fi
readonly role_id secret_id

if [[ -z "$role_id" || -z "$secret_id" ]]; then
  echo "The AppRole environment file must define VAULT_ROLE_ID and VAULT_SECRET_ID." >&2
  exit 1
fi

if ! /usr/local/bin/vault version 2>/dev/null | grep -F "Vault v${vault_version}" >/dev/null; then
  work_directory="$(mktemp -d)"
  cleanup() {
    rm -rf "$work_directory"
  }
  trap cleanup EXIT

  curl \
    --fail-with-body \
    --location \
    --proto '=https' \
    --silent \
    --show-error \
    --tlsv1.2 \
    --output "$work_directory/$vault_archive" \
    "$vault_download_url"

  printf '%s  %s\n' "$vault_archive_sha256" "$work_directory/$vault_archive" \
    | sha256sum --check --status

  python3 - "$work_directory/$vault_archive" "$work_directory" <<'PY'
from pathlib import Path
from zipfile import ZipFile
import sys

archive = Path(sys.argv[1])
destination = Path(sys.argv[2])

with ZipFile(archive) as bundle:
    member = bundle.getinfo("vault")
    if member.is_dir():
        raise SystemExit("Vault archive does not contain a binary.")
    bundle.extract(member, destination)
PY

  install -o root -g root -m 0755 "$work_directory/vault" /usr/local/bin/vault
fi

/usr/local/bin/vault version | grep -F "Vault v${vault_version}" >/dev/null

if ! cmp --silent \
  "$root_ca_source" \
  /usr/local/share/ca-certificates/dsqr-home-root-ca.crt; then
  install -o root -g root -m 0644 \
    "$root_ca_source" \
    /usr/local/share/ca-certificates/dsqr-home-root-ca.crt
fi
update-ca-certificates

install -d -o root -g root -m 0755 /usr/local/libexec
install -d -o root -g root -m 0700 "$configuration_directory" "$state_directory"
printf '%s\n' "$role_id" >"$configuration_directory/role-id"
printf '%s\n' "$secret_id" >"$configuration_directory/secret-id"
chmod 0600 "$configuration_directory/role-id" "$configuration_directory/secret-id"

install -o root -g root -m 0600 \
  "$script_directory/vault-agent.hcl" \
  "$configuration_directory/vault-agent.hcl"
install -o root -g root -m 0755 \
  "$script_directory/install-vault-certificate.sh" \
  /usr/local/libexec/install-proxmox-vault-certificate
install -o root -g root -m 0644 \
  "$script_directory/proxmox-vault-agent.service" \
  /etc/systemd/system/proxmox-vault-agent.service

if [[ ! -s "$request_fingerprint_file" ]] \
  || [[ "$(<"$request_fingerprint_file")" != "$request_fingerprint" ]]; then
  rm -f "$certificate_bundle" "$installed_fingerprint_file"
fi

printf '%s\n' "$request_fingerprint" >"$request_fingerprint_file"
chmod 0600 "$request_fingerprint_file"

if [[ -s "$certificate_bundle" ]] \
  && {
    [[ ! -s "$installed_fingerprint_file" ]] \
      || [[ "$(<"$installed_fingerprint_file")" != "$(sha256sum "$certificate_bundle" | cut -d ' ' -f 1)" ]]
  }; then
  rm -f "$certificate_bundle" "$installed_fingerprint_file"
fi

systemctl daemon-reload
systemctl enable proxmox-vault-agent.service
systemctl restart proxmox-vault-agent.service

for _ in {1..30}; do
  if systemctl is-active --quiet proxmox-vault-agent.service \
    && [[ -s "$certificate_bundle" ]] \
    && [[ -s "$installed_fingerprint_file" ]] \
    && [[ "$(<"$installed_fingerprint_file")" == "$(sha256sum "$certificate_bundle" | cut -d ' ' -f 1)" ]] \
    && systemctl is-active --quiet pveproxy.service; then
    break
  fi
  sleep 2
done

systemctl is-active --quiet proxmox-vault-agent.service
systemctl is-active --quiet pveproxy.service
[[ -s "$installed_fingerprint_file" ]]
[[ "$(<"$installed_fingerprint_file")" == "$(sha256sum "$certificate_bundle" | cut -d ' ' -f 1)" ]]
curl \
  --fail \
  --silent \
  --show-error \
  --cacert /etc/ssl/certs/ca-certificates.crt \
  --connect-timeout 5 \
  --max-time 15 \
  --resolve proxmox.dell-r730xd.home.arpa:8006:127.0.0.1 \
  --output /dev/null \
  https://proxmox.dell-r730xd.home.arpa:8006/

systemctl disable --now proxmox-vault-certificate.timer 2>/dev/null || true
rm -f \
  /etc/proxmox-vault-pki.env \
  /etc/systemd/system/proxmox-vault-certificate.service \
  /etc/systemd/system/proxmox-vault-certificate.timer \
  /usr/local/sbin/proxmox-vault-certificate
systemctl daemon-reload
systemctl reset-failed proxmox-vault-certificate.service 2>/dev/null || true

echo "Proxmox certificate lifecycle is managed by Vault Agent."
