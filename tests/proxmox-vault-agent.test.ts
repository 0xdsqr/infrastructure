import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const hostRoot = new URL("../tools/proxmox/", import.meta.url)

const readHostFile = (name: string) => readFileSync(new URL(name, hostRoot), "utf8")

test("Proxmox uses Vault Agent for exact, verified PKI rotation", () => {
  const installer = readHostFile("install.sh")
  const agent = readHostFile("vault-agent.hcl")
  const service = readHostFile("proxmox-vault-agent.service")
  const certificateInstaller = readHostFile("install-vault-certificate.sh")

  assert.match(installer, /readonly vault_version="2\.0\.3"/)
  assert.match(installer, /readonly vault_archive_sha256="[a-f0-9]{64}"/)
  assert.match(installer, /sha256sum --check --status/)
  assert.match(installer, /systemctl enable proxmox-vault-agent\.service/)
  assert.match(installer, /systemctl restart proxmox-vault-agent\.service/)
  assert.match(installer, /systemctl disable --now proxmox-vault-certificate\.timer/)
  assert.match(installer, /installed_fingerprint_file/)

  assert.match(agent, /type = "approle"/)
  assert.match(agent, /ca_cert = "\/etc\/ssl\/certs\/ca-certificates\.crt"/)
  assert.match(agent, /remove_secret_id_file_after_reading = false/)
  assert.match(agent, /lease_renewal_threshold = 0\.75/)
  assert.match(agent, /pkiCert \\"pki_int\/issue\/proxmox-dell-r730xd-listener\\"/)
  assert.match(agent, /common_name=proxmox\.dell-r730xd\.home\.arpa/)
  assert.doesNotMatch(agent, /\bsink\s*{/)
  assert.doesNotMatch(agent, /tls_skip_verify|VAULT_TOKEN/)

  assert.match(certificateInstaller, /openssl verify/)
  assert.match(certificateInstaller, /-verify_hostname "\$common_name"/)
  assert.match(certificateInstaller, /pvenode cert set/)
  assert.match(certificateInstaller, /mark_installed/)
  assert.match(certificateInstaller, /systemctl is-active --quiet pveproxy\.service/)

  assert.match(service, /NoNewPrivileges=true/)
  assert.match(service, /ProtectSystem=full/)
  assert.match(service, /ReadWritePaths=\/etc\/pve\/nodes\/pve/)
  assert.match(service, /RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX/)

  for (const script of ["install.sh", "install-vault-certificate.sh"]) {
    execFileSync("bash", ["-n", fileURLToPath(new URL(script, hostRoot))])
  }
})
