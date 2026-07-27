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

  buildPhase = ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"

    cp -R ${nodeModules}/. .
    chmod -R u+w node_modules

    while IFS= read -r manifest; do
      packageName="$(jq --raw-output .name "$manifest")"
      packageDirectory="$(dirname "$manifest")"
      packageLink="node_modules/$packageName"
      mkdir -p "$(dirname "$packageLink")"
      rm -rf "$packageLink"
      ln -s "$PWD/$packageDirectory" "$packageLink"
    done < <(find packages -name package.json -type f | sort)

    node_modules/.bin/esbuild \
      packages/cli/src/bin.ts \
      --bundle \
      --format=esm \
      --platform=node \
      --target=node24 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --outfile=infra.mjs
  '';

  installPhase = ''
    runtimeRoot="$out/share/infrastructure"
    mkdir -p "$out/bin" "$out/libexec" "$runtimeRoot"
    cp infra.mjs "$out/libexec/infra.mjs"
    cp -R ${src}/. "$runtimeRoot"
    cp -R ${nodeModules}/node_modules "$runtimeRoot/node_modules"
    chmod -R u+w "$runtimeRoot/node_modules"

    while IFS= read -r manifest; do
      packageName="$(jq --raw-output .name "$manifest")"
      packageDirectory="''${manifest#"$runtimeRoot/"}"
      packageDirectory="$(dirname "$packageDirectory")"
      packageLink="$runtimeRoot/node_modules/$packageName"
      mkdir -p "$(dirname "$packageLink")"
      rm -rf "$packageLink"
      ln -s "$runtimeRoot/$packageDirectory" "$packageLink"
    done < <(find "$runtimeRoot/packages" -name package.json -type f | sort)

    substituteAll ${../scripts/infra.sh} "$out/bin/infra"
    chmod +x "$out/bin/infra"
  '';
}
