{
  nodeModules,
  pkgs,
}:
import ../lib/workspace-command.nix {
  inherit nodeModules pkgs;
  inherit (pkgs) lib;
  name = "infrastructure-quality";
  extraNativeBuildInputs = [
    pkgs.kubectl
    pkgs.go
  ];
  command = ''
    export GOCACHE="$TMPDIR/go-cache"
    export GITOPS_TEMPLATE_RENDERER="$TMPDIR/gitops-template-render"
    CGO_ENABLED=0 GO111MODULE=off go build -o "$GITOPS_TEMPLATE_RENDERER" packages/gitops/tools/render-template.go
    npm run lint
    npm run typecheck
    npm test
    npm run infra -- validate
  '';
}
