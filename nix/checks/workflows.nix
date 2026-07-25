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
      ../packages/infra.sh
      ../../tools/proxmox/install.sh
      ../../tools/proxmox/install-vault-certificate.sh
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
    tail -n +2 nix/packages/infra.sh | shellcheck --shell=sh -
    shellcheck \
      tools/proxmox/install.sh \
      tools/proxmox/install-vault-certificate.sh

    mkdir -p "$out"
    touch "$out/workflows-check"

    runHook postInstall
  '';
}
