import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const hostRoot = new URL("../nix/scripts/proxmox/", import.meta.url)

const readHostFile = (name: string) => readFileSync(new URL(name, hostRoot), "utf8")

test("Proxmox reuses node-exporter for LVM-thin capacity metrics", () => {
  const installer = readHostFile("install-monitoring.sh")
  const collector = readHostFile("prometheus-lvm-thin-collector.sh")
  const service = readHostFile("prometheus-lvm-thin-collector.service")
  const timer = readHostFile("prometheus-lvm-thin-collector.timer")
  const rsyslog = readHostFile("rsyslog-loki.conf")

  assert.match(installer, /--collector\.textfile\.directory=/)
  assert.match(installer, /systemctl restart prometheus-node-exporter\.service/)
  assert.match(installer, /systemctl enable --now prometheus-lvm-thin-collector\.timer/)
  assert.match(installer, /systemctl enable --now rsyslog\.service/)
  assert.match(installer, /curl[\s\S]+127\.0\.0\.1:9100\/metrics/)

  assert.match(collector, /lvs/)
  assert.match(collector, /lv_attr/)
  assert.match(collector, /pve_lvmthin_data_percent/)
  assert.match(collector, /pve_lvmthin_metadata_percent/)
  assert.match(collector, /mktemp/)
  assert.match(collector, /mv "\$temporary_file" "\$metrics_file"/)

  assert.match(service, /Type=oneshot/)
  assert.match(service, /ProtectSystem=strict/)
  assert.match(service, /ReadWritePaths=\/var\/lib\/prometheus\/node-exporter/)
  assert.match(timer, /OnUnitActiveSec=5m/)
  assert.match(timer, /Persistent=true/)

  assert.match(rsyslog, /target="100\.97\.79\.78"/)
  assert.match(rsyslog, /port="1515"/)
  assert.match(rsyslog, /protocol="tcp"/)
  assert.match(rsyslog, /RSYSLOG_SyslogProtocol23Format/)
  assert.match(rsyslog, /queue\.filename="loki-forward"/)
  assert.match(rsyslog, /queue\.saveOnShutdown="on"/)
  assert.match(rsyslog, /action\.resumeRetryCount="-1"/)

  for (const script of ["install-monitoring.sh", "prometheus-lvm-thin-collector.sh"]) {
    execFileSync("bash", ["-n", fileURLToPath(new URL(script, hostRoot))])
  }
})
