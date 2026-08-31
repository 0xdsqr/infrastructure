import {
  type HelmReleaseInventory,
  type MetalLbAddressPoolInventory,
  type MetalLbL2AdvertisementInventory,
  type NamespaceInventory,
} from "@dsqr/model"

const namespaces = {
  argocd: {
    name: "argocd",
    annotations: {
      "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
    },
    labels: {
      "app.kubernetes.io/managed-by": "pulumi",
      "app.kubernetes.io/part-of": "dsqr-gitops",
      "platform.dsqr.dev/cluster": "hub-a",
      "platform.dsqr.dev/environment": "lab",
      "platform.dsqr.dev/physical-host": "dell-r730xd",
      "platform.dsqr.dev/owner": "platform",
      "platform.dsqr.dev/tier": "gitops",
      "pod-security.kubernetes.io/enforce": "baseline",
    },
  },
} satisfies NamespaceInventory

const helmReleases = {
  cilium: {
    releaseName: "cilium",
    namespace: "kube-system",
    chart: "cilium",
    enabled: false,
    repository: "https://helm.cilium.io/",
    version: "1.19.6",
    valueYamlFiles: [
      "../../gitops/components/cilium/base/values-common.yaml",
      "../../gitops/components/cilium/overlays/hub-a/values-overrides.yaml",
    ],
  },
  metallb: {
    releaseName: "metallb",
    namespace: "metallb-system",
    chart: "metallb",
    enabled: false,
    repository: "https://metallb.github.io/metallb",
    version: "0.16.1",
    valueYamlFiles: [
      "../../gitops/components/metallb/base/values-common.yaml",
      "../../gitops/components/metallb/overlays/hub-a/values-overrides.yaml",
    ],
    dependsOn: ["cilium"],
  },
  traefik: {
    releaseName: "traefik",
    namespace: "traefik",
    chart: "traefik",
    enabled: false,
    repository: "https://traefik.github.io/charts",
    version: "41.0.2",
    valueYamlFiles: [
      "../../gitops/components/traefik/base/values-common.yaml",
      "../../gitops/components/traefik/overlays/hub-a/values-overrides.yaml",
    ],
    dependsOn: ["cilium"],
  },
  kubeStateMetrics: {
    releaseName: "kube-state-metrics",
    namespace: "kube-system",
    chart: "kube-state-metrics",
    enabled: false,
    repository: "https://prometheus-community.github.io/helm-charts",
    version: "8.0.0",
    valueYamlFiles: [
      "../../gitops/components/kube-state-metrics/base/values-common.yaml",
      "../../gitops/components/kube-state-metrics/overlays/hub-a/values-overrides.yaml",
    ],
    dependsOn: ["cilium"],
  },
  k8sMonitoring: {
    releaseName: "k8s-monitoring",
    namespace: "observability",
    chart: "k8s-monitoring",
    enabled: false,
    repository: "https://grafana.github.io/helm-charts",
    version: "4.3.1",
    valueYamlFiles: [
      "../../gitops/components/k8s-monitoring/base/values-common.yaml",
      "../../gitops/components/k8s-monitoring/overlays/hub-a/values-overrides.yaml",
    ],
    dependsOn: ["cilium", "kubeStateMetrics"],
  },
  argoCd: {
    releaseName: "argocd",
    namespace: "argocd",
    chart: "argo-cd",
    repository: "https://argoproj.github.io/argo-helm",
    version: "10.2.1",
    valueYamlFiles: [
      "../../gitops/components/argocd/base/values-common.yaml",
      "../../gitops/components/argocd/overlays/hub-a/values-overrides.yaml",
    ],
  },
} satisfies HelmReleaseInventory

const metallbAddressPools = {} satisfies MetalLbAddressPoolInventory

const metallbL2Advertisements = {} satisfies MetalLbL2AdvertisementInventory

export const kubernetes = {
  namespaces,
  helmReleases,
  metallb: {
    addressPools: metallbAddressPools,
    l2Advertisements: metallbL2Advertisements,
  },
} as const
