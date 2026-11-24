{
  packages,
  pkgs,
}:
pkgs.runCommand "infrastructure-runtime-check"
  {
    nativeBuildInputs = [ pkgs.nodejs_24 ];
  }
  ''
    runtimeRoot="${packages.infra}/share/infrastructure"

    # Configuration rebuilds must not duplicate or refix third-party packages.
    test -d "$runtimeRoot/node_modules"
    test ! -L "$runtimeRoot/node_modules"
    test -z "$(find "$runtimeRoot/node_modules" -type f -print -quit)"
    test "$(readlink "$runtimeRoot/node_modules/@pulumi")" = "${packages.nodeModules}/node_modules/@pulumi"
    test "$(readlink "$runtimeRoot/node_modules/effect")" = "${packages.nodeModules}/node_modules/effect"
    test "$(readlink -f "$runtimeRoot/node_modules/@dsqr/pulumi-vault")" = "$runtimeRoot/packages/pulumi/vault"

    # Node's normal realpath-based resolution must work without preserve-symlinks
    # or NODE_PATH. Exercise the CLI and Pulumi SDK using offline resource mocks.
    unset INFRA_ROOT NODE_PATH NODE_OPTIONS
    ${packages.infra}/bin/infra validate
    cd "$runtimeRoot"
    node --test tests/infra-security.test.ts tests/vault-state-identity.test.ts

    touch "$out"
  ''
