pid_file = "/run/proxmox-vault-agent.pid"

vault {
  address = "https://vault.service.home.arpa:8200"
  ca_cert = "/etc/ssl/certs/ca-certificates.crt"
}

auto_auth {
  method {
    type = "approle"

    config = {
      role_id_file_path                   = "/etc/vault-agent-proxmox/role-id"
      secret_id_file_path                 = "/etc/vault-agent-proxmox/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }
}

template_config {
  exit_on_retry_failure   = false
  lease_renewal_threshold = 0.75
}

template {
  contents = "{{- with pkiCert \"pki_int/issue/proxmox-dell-r730xd-listener\" \"common_name=proxmox.dell-r730xd.home.arpa\" \"ttl=720h\" -}}\n{{ .Cert }}{{ .CA }}{{ .Key }}\n{{- end -}}\n"

  destination         = "/var/lib/vault-agent-proxmox/certificate-bundle.pem"
  create_dest_dirs    = false
  error_on_missing_key = true
  perms               = "0600"
  backup              = true

  exec {
    command = [
      "/usr/local/libexec/install-proxmox-vault-certificate",
      "/var/lib/vault-agent-proxmox/certificate-bundle.pem",
    ]
    timeout = "90s"
  }
}
