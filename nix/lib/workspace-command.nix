{
  command,
  extraNativeBuildInputs ? [ ],
  lib,
  name,
  nodeModules,
  pkgs,
}:
let
  src = import ./source.nix { inherit lib; };
in
pkgs.stdenvNoCC.mkDerivation {
  inherit name src;

  nativeBuildInputs = [
    pkgs.jq
    pkgs.nodejs_24
  ]
  ++ extraNativeBuildInputs;

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

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

    export PATH="$PWD/node_modules/.bin:$PATH"

    ${command}

    runHook postBuild
  '';

  installPhase = ''
    touch "$out"
  '';
}
