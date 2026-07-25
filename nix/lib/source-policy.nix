{ lib }:
let
  excludedDirectories = [
    ".direnv"
    ".git"
    ".pulumi"
    "dist"
    "node_modules"
  ];

  isExcludedDirectoryName =
    name: builtins.elem name excludedDirectories || lib.hasPrefix "result" name;

  isPulumiStackConfig =
    name: lib.hasPrefix "Pulumi." name && name != "Pulumi.yaml" && lib.hasSuffix ".yaml" name;

  isPrivateName =
    name:
    name == ".env"
    || name == ".envrc.local"
    || (lib.hasPrefix ".env." name && name != ".env.example")
    || isPulumiStackConfig name
    || lib.hasSuffix ".pulumi-state.json" name
    || builtins.any (extension: lib.hasSuffix extension name) [
      ".key"
      ".pem"
      ".p12"
      ".pfx"
    ];
in
{
  inherit isPrivateName;

  filter =
    path: type:
    let
      name = baseNameOf (toString path);
    in
    !isPrivateName name
    && name != ".DS_Store"
    && !((type == "directory" || type == "symlink") && isExcludedDirectoryName name);
}
