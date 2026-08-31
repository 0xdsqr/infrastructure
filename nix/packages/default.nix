{ pkgs }:
let
  nodeModules = pkgs.callPackage ./node-modules.nix { };
  cluster = pkgs.callPackage ./cluster.nix { inherit nodeModules; };
  gitops = pkgs.callPackage ./gitops.nix { inherit nodeModules; };
  pulumi = pkgs.callPackage ./pulumi.nix { };
  infra = pkgs.callPackage ./infra.nix { inherit nodeModules pulumi; };
  proxmoxStateMigrate = pkgs.callPackage ./proxmox-state-migrate.nix { inherit nodeModules; };
  securityAudit = pkgs.callPackage ./security-audit.nix { };
in
{
  inherit
    cluster
    gitops
    infra
    nodeModules
    pulumi
    proxmoxStateMigrate
    securityAudit
    ;
  gitopsCheck = gitops;
  gitopsGenerate = gitops;
  gitopsRender = gitops;
  default = infra;
}
