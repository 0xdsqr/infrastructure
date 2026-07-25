{ pkgs }:
pkgs.writeShellApplication {
  name = "security-audit";
  runtimeInputs = [ pkgs.nodejs_24 ];
  text = ''
    exec npm audit --audit-level=moderate "$@"
  '';
}
