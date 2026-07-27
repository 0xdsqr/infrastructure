{ pkgs, ... }:
let
  oxfmtConfig = pkgs.writeText "oxfmt.json" (
    builtins.toJSON {
      semi = false;
      tabWidth = 2;
      ignorePatterns = [ "gitops/**" ];
    }
  );
in
{
  projectRootFile = "flake.nix";

  programs.nixfmt = {
    enable = true;
    package = pkgs.nixfmt;
  };

  settings = {
    global.excludes = [
      ".direnv/**"
      ".git/**"
      "dist/**"
      "node_modules/**"
      "result*"
    ];

    formatter.oxfmt = {
      command = "${pkgs.oxfmt}/bin/oxfmt";
      options = [
        "--config"
        (toString oxfmtConfig)
      ];
      includes = [
        "*.js"
        "*.json"
        "*.jsonc"
        "*.jsx"
        "*.ts"
        "*.tsx"
      ];
    };
  };
}
