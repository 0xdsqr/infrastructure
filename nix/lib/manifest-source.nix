{
  lib,
  runCommand,
}:
let
  policy = import ./source-policy.nix { inherit lib; };
  manifests = lib.cleanSourceWith {
    src = ../..;
    filter =
      path: type:
      policy.filter path type
      && (
        type == "directory"
        || builtins.elem (baseNameOf (toString path)) [
          "package-lock.json"
          "package.json"
        ]
      );
  };
in
runCommand "infrastructure-package-manifests" { } ''
  cp -R ${manifests} "$out"
''
