{
  buildNpmPackage,
  lib,
  nodejs_24,
  runCommand,
  stdenvNoCC,
}:
let
  src = import ../lib/manifest-source.nix { inherit lib runCommand; };
  npmDepsHash =
    {
      aarch64-darwin = "sha256-pn8NWu7ZCQp7Jvmcw6lfTm0wYjBKk9XuO91ClAhhdHk=";
      x86_64-linux = "sha256-pn8NWu7ZCQp7Jvmcw6lfTm0wYjBKk9XuO91ClAhhdHk=";
    }
    .${stdenvNoCC.hostPlatform.system};
in
(buildNpmPackage.override { nodejs = nodejs_24; }) {
  pname = "infrastructure-node-modules";
  version = "0.0.0";
  inherit npmDepsHash src;

  npmDepsFetcherVersion = 2;
  npmInstallFlags = [
    "--ignore-scripts"
    "--no-audit"
    "--no-fund"
    "--loglevel=warn"
  ];

  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp package.json package-lock.json "$out/"
    cp -R node_modules "$out/node_modules"
    rm -rf "$out/node_modules/@dsqr"
  '';

  meta.platforms = [
    "aarch64-darwin"
    "x86_64-linux"
  ];
}
