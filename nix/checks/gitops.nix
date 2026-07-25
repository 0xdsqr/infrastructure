{
  gitops,
  lib,
  stdenvNoCC,
}:
let
  src = lib.fileset.toSource {
    root = ../..;
    fileset = ../../gitops;
  };
in
stdenvNoCC.mkDerivation {
  name = "infrastructure-gitops-check";
  inherit src;

  nativeBuildInputs = [ gitops ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    gitops-check "$PWD"

    mkdir -p "$out"
    touch "$out/gitops-check"

    runHook postInstall
  '';
}
