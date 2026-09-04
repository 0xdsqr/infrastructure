{
  lib,
  nodeModules,
  pkgs,
}:
let
  src = import ../lib/source.nix { inherit lib; };
  runtimePath = lib.makeBinPath [ pkgs.kubectl ];
in
pkgs.stdenvNoCC.mkDerivation {
  name = "gitops-tools";
  inherit src;
  inherit runtimePath;

  nativeBuildInputs = [
    pkgs.go
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

    export GOCACHE="$TMPDIR/go-cache"
    CGO_ENABLED=0 GO111MODULE=off go build -o gitops-template-render packages/gitops/tools/render-template.go

    node_modules/.bin/esbuild \
      packages/gitops/src/bin/{check,generate,render}.ts \
      --bundle \
      --splitting \
      --format=esm \
      --platform=node \
      --target=node24 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --entry-names='gitops-[name]' \
      --chunk-names='chunks/[name]-[hash]' \
      --out-extension:.js=.mjs \
      --outdir=dist

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/libexec"
    cp -R dist/. "$out/libexec/"
    cp gitops-template-render "$out/libexec/"
    for command in check generate render; do
      makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/gitops-$command" \
        --set GITOPS_TEMPLATE_RENDERER "$out/libexec/gitops-template-render" \
        --add-flags "$out/libexec/gitops-$command.mjs" \
        --prefix PATH : "${runtimePath}"
    done

    runHook postInstall
  '';

  meta = {
    description = "Effect-based GitOps generation, rendering, and policy tools";
    license = lib.licenses.mit;
    mainProgram = "gitops-check";
    platforms = [
      "aarch64-darwin"
      "x86_64-linux"
    ];
  };
}
