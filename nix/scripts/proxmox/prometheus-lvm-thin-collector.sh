#!/usr/bin/env bash

set -euo pipefail
umask 0022

readonly metrics_directory="/var/lib/prometheus/node-exporter"
readonly metrics_file="${metrics_directory}/lvm-thin.prom"
temporary_file="$(mktemp "${metrics_directory}/.lvm-thin.XXXXXX")"
readonly temporary_file

cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT

{
  printf '%s\n' \
    '# HELP pve_lvmthin_data_percent Percentage of allocated data space in a Proxmox LVM-thin pool.' \
    '# TYPE pve_lvmthin_data_percent gauge' \
    '# HELP pve_lvmthin_metadata_percent Percentage of allocated metadata space in a Proxmox LVM-thin pool.' \
    '# TYPE pve_lvmthin_metadata_percent gauge'

  lvs \
    --noheadings \
    --separator '|' \
    --options vg_name,lv_name,lv_attr,data_percent,metadata_percent \
  | awk -F '|' '
      function trim(value) {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        return value
      }

      {
        vg = trim($1)
        lv = trim($2)
        attr = trim($3)
        data = trim($4)
        metadata = trim($5)
      }

      substr(attr, 1, 1) == "t" && data != "" && metadata != "" {
        printf "pve_lvmthin_data_percent{vg=\"%s\",lv=\"%s\"} %s\n", vg, lv, data
        printf "pve_lvmthin_metadata_percent{vg=\"%s\",lv=\"%s\"} %s\n", vg, lv, metadata
      }
    '
} > "$temporary_file"

chmod 0644 "$temporary_file"
mv "$temporary_file" "$metrics_file"
trap - EXIT
