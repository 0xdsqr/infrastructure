{ lib }:
let
  policy = import ./source-policy.nix { inherit lib; };
in
lib.cleanSourceWith {
  src = ../..;
  inherit (policy) filter;
}
