{
  description = "Core homelab infrastructure managed with Pulumi and GitOps";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
      packagesFor = system: import ./nix/packages { pkgs = pkgsFor system; };
      treefmtFor = system: treefmt-nix.lib.evalModule (pkgsFor system) ./nix/treefmt.nix;
    in
    {
      apps = forAllSystems (
        system:
        let
          packages = packagesFor system;
        in
        {
          default = {
            type = "app";
            program = "${packages.infra}/bin/infra";
            meta.description = "Run infrastructure stack commands";
          };
          infra = {
            type = "app";
            program = "${packages.infra}/bin/infra";
            meta.description = "Run infrastructure stack commands";
          };
          proxmox-state-migrate = {
            type = "app";
            program = "${packages.proxmoxStateMigrate}/bin/proxmox-state-migrate";
            meta.description = "Convert an exported Proxmox provider v7 state file to v8";
          };
          gitops-generate = {
            type = "app";
            program = "${packages.gitopsGenerate}/bin/gitops-generate";
            meta.description = "Generate Argo CD Applications";
          };
          gitops-check = {
            type = "app";
            program = "${packages.gitopsCheck}/bin/gitops-check";
            meta.description = "Validate GitOps generation, rendering, and policy";
          };
          gitops-render = {
            type = "app";
            program = "${packages.gitopsRender}/bin/gitops-render";
            meta.description = "Render every GitOps surface";
          };
          security-audit = {
            type = "app";
            program = "${packages.securityAudit}/bin/security-audit";
            meta.description = "Audit JavaScript dependencies";
          };
        }
      );

      checks = forAllSystems (
        system:
        import ./nix/checks {
          packages = packagesFor system;
          pkgs = pkgsFor system;
          treefmtCheck = (treefmtFor system).config.build.check self;
        }
      );

      devShells = forAllSystems (system: {
        default = import ./nix/devshell.nix {
          pkgs = pkgsFor system;
          pulumi = (packagesFor system).pulumi;
          treefmtWrapper = (treefmtFor system).config.build.wrapper;
        };
      });

      formatter = forAllSystems (system: (treefmtFor system).config.build.wrapper);
      packages = forAllSystems (system: packagesFor system);
    };
}
