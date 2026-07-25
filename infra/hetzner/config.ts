export const hetznerMail = {
  name: "mail-vps",
  serverType: "cpx11",
  location: "ash",
  image: "ubuntu-24.04",
  sshKeyName: "dsqr-homelab",
  createFirewall: true,
  adminIpv4: "98.156.203.63",
  adminIpv6: "2603:8080:7000:4c14:7400:4c92:47a4:6f56",
  rdnsHostname: "mx.dsqr.dev",
} as const
