{
  lib,
  nodeModules,
  pkgs,
}:
let
  src = import ../lib/source.nix { inherit lib; };
in
pkgs.stdenvNoCC.mkDerivation {
  name = "proxmox-state-migrate";
  inherit src;

  nativeBuildInputs = [
    pkgs.jq
    pkgs.makeWrapper
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
      tools/migrations/proxmox-v7-to-v8-state.ts \
      --bundle \
      --format=esm \
      --platform=node \
      --target=node24 \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
      --outfile=proxmox-state-migrate.mjs
  '';

  installPhase = ''
    mkdir -p "$out/bin" "$out/libexec"
    cp proxmox-state-migrate.mjs "$out/libexec/proxmox-state-migrate.mjs"
    makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/proxmox-state-migrate" \
      --add-flags "$out/libexec/proxmox-state-migrate.mjs"
  '';
}
