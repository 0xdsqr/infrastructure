{
  lib,
  nodeModules,
  pkgs,
  pulumi,
}:
let
  src = import ../lib/source.nix { inherit lib; };
  runtimePath = lib.makeBinPath [
    pkgs.nodejs_24
    pulumi
  ];
in
pkgs.stdenvNoCC.mkDerivation {
  name = "infra";
  inherit src;
  node = "${pkgs.nodejs_24}/bin/node";
  inherit runtimePath;
  shell = pkgs.runtimeShell;

  nativeBuildInputs = [
    pkgs.jq
    pkgs.nodejs_24
  ];

  dontConfigure = true;

  # Third-party dependencies are already installed and fixed up in nodeModules.
  # Keep a shallow link tree: workspace imports resolve into this package's source,
  # while dependencies resolve into their immutable, reusable store output.
  preBuild = ''
    linkWorkspaceDependencies() {
      local workspaceRoot="$1"
      local dependency manifest packageName packageDirectory packageLink
      mkdir -p "$workspaceRoot/node_modules"

      for dependency in ${nodeModules}/node_modules/* ${nodeModules}/node_modules/.bin; do
        ln -s "$dependency" "$workspaceRoot/node_modules/$(basename "$dependency")"
      done

      while IFS= read -r manifest; do
        packageName="$(jq --raw-output .name "$manifest")"
        packageDirectory="$(dirname "$manifest")"
        packageLink="$workspaceRoot/node_modules/$packageName"
        # The dependency-only derivation excludes the @dsqr workspace scope.
        # Refuse to replace or write through any third-party dependency link.
        case "$packageName" in @dsqr/*) ;; *) exit 1 ;; esac
        test ! -L "$workspaceRoot/node_modules/@dsqr"
        mkdir -p "$workspaceRoot/node_modules/@dsqr"
        test ! -e "$packageLink" && test ! -L "$packageLink"
        ln -s "$packageDirectory" "$packageLink"
      done < <(find "$workspaceRoot/packages" -name package.json -type f | sort)
    }
  '';

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    linkWorkspaceDependencies "$PWD"

    node_modules/.bin/esbuild \
      packages/cli/src/bin.ts \
      --bundle \
      --format=esm \
      --platform=node \
      --target=node24 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --outfile=infra.mjs

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    runtimeRoot="$out/share/infrastructure"
    mkdir -p "$out/bin" "$out/libexec" "$runtimeRoot"
    cp infra.mjs "$out/libexec/infra.mjs"
    cp -R ${src}/. "$runtimeRoot"
    linkWorkspaceDependencies "$runtimeRoot"

    substituteAll ${../scripts/infra.sh} "$out/bin/infra"
    chmod +x "$out/bin/infra"

    runHook postInstall
  '';
}
