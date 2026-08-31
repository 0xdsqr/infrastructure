{
  lib,
  nodeModules,
  pkgs,
}:
let
  src = import ../lib/source.nix { inherit lib; };
  runtimePath = lib.makeBinPath [
    pkgs.kubectl
    pkgs.kubernetes-helm
  ];
in
pkgs.stdenvNoCC.mkDerivation {
  name = "cluster-bootstrap";
  inherit src;

  nativeBuildInputs = [
    pkgs.nodejs_24
    pkgs.makeWrapper
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"

    cp -R ${nodeModules}/. .
    chmod -R u+w node_modules

    node_modules/.bin/esbuild \
      packages/cluster/src/bin.ts \
      --bundle \
      --format=esm \
      --platform=node \
      --target=node24 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --outfile=cluster.mjs

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/libexec" "$out/share/cluster"
    cp cluster.mjs "$out/libexec/cluster.mjs"
    cp -R gitops "$out/share/cluster/gitops"
    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/cluster" \
      --add-flags "$out/libexec/cluster.mjs" \
      --prefix PATH : "${runtimePath}" \
      --set CLUSTER_REPO_ROOT "$out/share/cluster"

    runHook postInstall
  '';

  meta = {
    description = "Guarded Effect-based Kubernetes cluster bootstrap runner";
    license = lib.licenses.mit;
    mainProgram = "cluster";
    platforms = [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  };
}
