{
  lib,
  runCommand,
}:
let
  policy = import ../lib/source-policy.nix { inherit lib; };
  src = import ../lib/source.nix { inherit lib; };

  rejectedNames = [
    ".env"
    ".env.development"
    ".envrc.local"
    "Pulumi.dev.yaml"
    "Pulumi.production.yaml"
    "proxmox-dev.pulumi-state.json"
    "private.key"
    "certificate.pem"
    "identity.p12"
    "identity.pfx"
  ];

  allowedNames = [
    ".env.example"
    "Pulumi.yaml"
    "certificate.crt"
    "package.json"
  ];

  unexpectedlyAllowed = builtins.filter (name: !policy.isPrivateName name) rejectedNames;
  unexpectedlyRejected = builtins.filter policy.isPrivateName allowedNames;
in
assert lib.assertMsg (
  unexpectedlyAllowed == [ ]
) "source policy unexpectedly allowed: ${builtins.toJSON unexpectedlyAllowed}";
assert lib.assertMsg (
  unexpectedlyRejected == [ ]
) "source policy unexpectedly rejected: ${builtins.toJSON unexpectedlyRejected}";
assert lib.assertMsg (
  !policy.filter "/tmp/result-audit" "symlink"
) "source policy unexpectedly allowed a result-prefixed symlink";
runCommand "infrastructure-source-policy-check" { } ''
  test -f ${src}/.env.example

  if ! awk '
    /^[[:space:]]*(#.*)?$/ { next }
    /^[A-Z][A-Z0-9_]*=$/ { next }
    { exit 1 }
  ' ${src}/.env.example; then
    echo ".env.example must contain only comments and empty variable assignments" >&2
    exit 1
  fi

  forbidden="$(
    find ${src} -type f \
      \( \
        -name '.env' \
        -o -name '.envrc.local' \
        -o \( -name '.env.*' ! -name '.env.example' \) \
        -o -name 'Pulumi.*.yaml' \
        -o -name '*.pulumi-state.json' \
        -o -name '*.key' \
        -o -name '*.pem' \
        -o -name '*.p12' \
        -o -name '*.pfx' \
      \) \
      -print \
      -quit
  )"

  if [ -n "$forbidden" ]; then
    echo "private file entered the Nix source closure: $forbidden" >&2
    exit 1
  fi

  touch "$out"
''
