{
  actionlint,
  lib,
  shellcheck,
  stdenvNoCC,
}:
let
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../.github
      ../scripts/infra.sh
      ../scripts/proxmox/install-monitoring.sh
      ../scripts/proxmox/export-backup.sh
      ../scripts/proxmox/install.sh
      ../scripts/proxmox/install-vault-certificate.sh
      ../scripts/proxmox/prometheus-lvm-thin-collector.sh
    ];
  };
in
stdenvNoCC.mkDerivation {
  name = "infrastructure-workflows-check";
  inherit src;

  nativeBuildInputs = [
    actionlint
    shellcheck
  ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    actionlint -no-color .github/workflows/*.yml
    tail -n +2 nix/scripts/infra.sh | shellcheck --shell=sh -
    shellcheck \
      nix/scripts/proxmox/export-backup.sh \
      nix/scripts/proxmox/install-monitoring.sh \
      nix/scripts/proxmox/install.sh \
      nix/scripts/proxmox/install-vault-certificate.sh \
      nix/scripts/proxmox/prometheus-lvm-thin-collector.sh

    mkdir -p "$out"
    touch "$out/workflows-check"

    runHook postInstall
  '';
}
