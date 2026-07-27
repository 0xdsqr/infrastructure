#!@shell@
set -eu

export INFRA_ROOT="${INFRA_ROOT:-@out@/share/infrastructure}"
export PATH="@runtimePath@:$PATH"
exec @node@ @out@/libexec/infra.mjs "$@"
