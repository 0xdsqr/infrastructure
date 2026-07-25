{ pkgs, ... }:
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
        ".oxfmtrc.json"
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
