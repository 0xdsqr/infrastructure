{
  packages,
  pkgs,
  treefmtCheck,
}:
{
  apps = pkgs.callPackage ./apps.nix { inherit packages; };
  format = treefmtCheck;
  gitops = pkgs.callPackage ./gitops.nix {
    inherit (packages) gitops;
  };
  package = packages.infra;
  quality = pkgs.callPackage ./quality.nix {
    nodeModules = packages.nodeModules;
  };
  source-policy = pkgs.callPackage ./source-policy.nix { };
  workflows = pkgs.callPackage ./workflows.nix { };
}
