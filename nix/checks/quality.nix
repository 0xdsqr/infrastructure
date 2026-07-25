{
  nodeModules,
  pkgs,
}:
import ../lib/workspace-command.nix {
  inherit nodeModules pkgs;
  inherit (pkgs) lib;
  name = "infrastructure-quality";
  extraNativeBuildInputs = [ pkgs.kubectl ];
  command = ''
    npm run lint
    npm run typecheck
    npm test
    npm run infra -- validate
  '';
}
