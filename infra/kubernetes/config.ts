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
      "homelab.dev/cluster": "hub-a",
      "homelab.dev/environment": "homelab",
      "homelab.dev/physical-host": "dell-r730xd",
      "homelab.dev/owner": "platform",
      "homelab.dev/tier": "gitops",
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
    version: "1.19.1",
    valueYamlFiles: [
      "../../gitops/values/cilium/common.yaml",
      "../../gitops/values/cilium/hub-a.yaml",
    ],
  },
  metallb: {
    releaseName: "metallb",
    namespace: "metallb-system",
    chart: "metallb",
    enabled: false,
    repository: "https://metallb.github.io/metallb",
    version: "0.15.3",
    valueYamlFiles: [
      "../../gitops/values/metallb/common.yaml",
      "../../gitops/values/metallb/hub-a.yaml",
    ],
    dependsOn: ["cilium"],
  },
  traefik: {
    releaseName: "traefik",
    namespace: "traefik",
    chart: "traefik",
    enabled: false,
    repository: "https://traefik.github.io/charts",
    version: "39.0.7",
    valueYamlFiles: [
      "../../gitops/values/traefik/common.yaml",
      "../../gitops/values/traefik/hub-a.yaml",
    ],
    dependsOn: ["cilium"],
  },
  kubeStateMetrics: {
    releaseName: "kube-state-metrics",
    namespace: "kube-system",
    chart: "kube-state-metrics",
    enabled: false,
    repository: "https://prometheus-community.github.io/helm-charts",
    version: "7.2.2",
    valueYamlFiles: [
      "../../gitops/values/kube-state-metrics/common.yaml",
      "../../gitops/values/kube-state-metrics/hub-a.yaml",
    ],
    dependsOn: ["cilium"],
  },
  k8sMonitoring: {
    releaseName: "k8s-monitoring",
    namespace: "observability",
    chart: "k8s-monitoring",
    enabled: false,
    repository: "https://grafana.github.io/helm-charts",
    version: "3.5.3",
    valueYamlFiles: [
      "../../gitops/values/k8s-monitoring/common.yaml",
      "../../gitops/values/k8s-monitoring/hub-a.yaml",
    ],
    dependsOn: ["cilium", "kubeStateMetrics"],
  },
  argoCd: {
    releaseName: "argocd",
    namespace: "argocd",
    chart: "argo-cd",
    repository: "https://argoproj.github.io/argo-helm",
    version: "9.5.22",
    valueYamlFiles: [
      "../../gitops/values/argocd/common.yaml",
      "../../gitops/values/argocd/hub-a.yaml",
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
