{
  pkgs,
  pulumi,
  treefmtWrapper,
}:
pkgs.mkShell {
  packages = with pkgs; [
    git
    jq
    kubectl
    kubernetes-helm
    nodejs_24
    oxfmt
    oxlint
    pulumi
    treefmtWrapper
    yq-go
  ];

  shellHook = ''
    export PATH="$PWD/node_modules/.bin:$PATH"

    echo "infrastructure dev shell"
    echo "  node:   $(node --version)"
    echo "  npm:    $(npm --version)"
    echo "  pulumi: $(pulumi version)"
  '';
}
