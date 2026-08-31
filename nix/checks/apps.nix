{
  packages,
  pkgs,
}:
let
  expectedProviderVersions = {
    cloudflare = "6.18.0";
    hcloud = "1.40.0";
    kubernetes = "4.33.0";
    proxmoxve = "8.3.0";
    tailscale = "0.29.0";
    vault = "7.11.0";
  };
in
assert packages.pulumi.version == "3.254.0";
assert packages.pulumi.providerVersions == expectedProviderVersions;
pkgs.runCommand "infrastructure-packaged-apps-check"
  {
    nativeBuildInputs = [ pkgs.jq ];
  }
  ''
    test "$(${packages.pulumi}/bin/pulumi version)" = "v3.254.0"
    for provider in cloudflare hcloud kubernetes proxmoxve tailscale vault; do
      test -x "${packages.pulumi}/bin/pulumi-resource-$provider"
    done

    ${packages.infra}/bin/infra validate > infra-validate.log
    grep -F "Validated 6 infrastructure projects and 4 groups." infra-validate.log

    ${packages.cluster}/bin/cluster --help > cluster-help.log
    grep -F "cluster bootstrap indigo --step argocd" cluster-help.log

    input="$TMPDIR/proxmox-v7.pulumi-state.json"
    output="$TMPDIR/proxmox-v8.pulumi-state.json"
    printf '%s\n' '{"type":"proxmoxve:VM/virtualMachine:VirtualMachine"}' > "$input"
    ${packages.proxmoxStateMigrate}/bin/proxmox-state-migrate "$input" "$output"
    jq -e '.type == "proxmoxve:index/vmLegacy:VmLegacy"' "$output" > /dev/null
    test "$(stat -c %a "$output")" = 600

    touch "$out"
  ''
