{
  autoPatchelfHook,
  fetchurl,
  installShellFiles,
  lib,
  makeWrapper,
  stdenv,
}:
let
  version = "3.254.0";
  providerVersions = {
    cloudflare = "6.18.0";
    hcloud = "1.40.0";
    kubernetes = "4.33.0";
    proxmoxve = "8.3.0";
    tailscale = "0.29.0";
    vault = "7.11.0";
  };

  artifacts = {
    aarch64-darwin = [
      {
        url = "https://get.pulumi.com/releases/sdk/pulumi-v${version}-darwin-arm64.tar.gz";
        hash = "sha256-H+VV8u5Qzz2gEhkHGQLQlA1kYZh5IZOlokrtkBduQOM=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-cloudflare-v${providerVersions.cloudflare}-darwin-arm64.tar.gz";
        hash = "sha256-pldKgiZ7ubrmo17NqJO65+ddOoQv2ag1tFjIBku/0FM=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-hcloud-v${providerVersions.hcloud}-darwin-arm64.tar.gz";
        hash = "sha256-4STR6SUzu89IJtrbC2Nltlzsr5wjhHy3gL0YESW377E=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-kubernetes-v${providerVersions.kubernetes}-darwin-arm64.tar.gz";
        hash = "sha256-KZx3tmt8ScU3hJl9IF0uUSV8B8bLcsR2GHeYsJMIlLA=";
      }
      {
        url = "https://github.com/muhlba91/pulumi-proxmoxve/releases/download/v${providerVersions.proxmoxve}/pulumi-resource-proxmoxve-v${providerVersions.proxmoxve}-darwin-arm64.tar.gz";
        hash = "sha256-j4Z7AOjiJ3degV1/lIYhe+QZfnwKqq3AHGGpDr0ci2E=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-tailscale-v${providerVersions.tailscale}-darwin-arm64.tar.gz";
        hash = "sha256-fdQWRGDh5zCiAQf/xTc5u31QMvGbySEla3suZg4gVy4=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-vault-v${providerVersions.vault}-darwin-arm64.tar.gz";
        hash = "sha256-qFICWG8b416rV279N9fbwzPtSDVNC0uAxY5U1/I8hIA=";
      }
    ];

    x86_64-linux = [
      {
        url = "https://get.pulumi.com/releases/sdk/pulumi-v${version}-linux-x64.tar.gz";
        hash = "sha256-shZ8CTsOv8kYRW0HCr3g50CidsPm3AoTaEvHQwY2TCI=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-cloudflare-v${providerVersions.cloudflare}-linux-amd64.tar.gz";
        hash = "sha256-lHSSumzgK8cWN/1sYnnkPezeqJGCNDcKIvSjYVo4FHg=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-hcloud-v${providerVersions.hcloud}-linux-amd64.tar.gz";
        hash = "sha256-gujc/VNKgIazDdtpCCnlGU3bTa8a1UgkRvjH7+Uy5zg=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-kubernetes-v${providerVersions.kubernetes}-linux-amd64.tar.gz";
        hash = "sha256-5QoAp57W3lRb1bQObkdYDZU+vRZ6Mezxn8HqOpsTRiY=";
      }
      {
        url = "https://github.com/muhlba91/pulumi-proxmoxve/releases/download/v${providerVersions.proxmoxve}/pulumi-resource-proxmoxve-v${providerVersions.proxmoxve}-linux-amd64.tar.gz";
        hash = "sha256-ubxfOGtdaWmXuX9z1CPcfn2+3xPwlFZErNh1qwyYjK4=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-tailscale-v${providerVersions.tailscale}-linux-amd64.tar.gz";
        hash = "sha256-XQ/xTohP9/1KaKFmQ3Ay5CcjjQulWkMzXUpCkpLDAwg=";
      }
      {
        url = "https://api.pulumi.com/releases/plugins/pulumi-resource-vault-v${providerVersions.vault}-linux-amd64.tar.gz";
        hash = "sha256-oxIFAyT00d1Bb8WbuQCSe11vRpxgHqrAfvn24/EnonA=";
      }
    ];
  };
in
stdenv.mkDerivation {
  pname = "pulumi";
  inherit version;

  srcs = map fetchurl artifacts.${stdenv.hostPlatform.system};

  postUnpack = ''
    mv pulumi-* pulumi
  '';

  nativeBuildInputs = [
    installShellFiles
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
    makeWrapper
  ];

  buildInputs = [ stdenv.cc.cc.libgcc or null ];

  installPhase = ''
    runHook preInstall
    install -D -t "$out/bin" ./*
    runHook postInstall
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    wrapProgram "$out/bin/pulumi" \
      --set LD_LIBRARY_PATH "${lib.getLib stdenv.cc.cc}/lib"
  ''
  + lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
    installShellCompletion --cmd pulumi \
      --bash <("$out/bin/pulumi" completion bash) \
      --fish <("$out/bin/pulumi" completion fish) \
      --zsh <("$out/bin/pulumi" completion zsh)
  '';

  passthru = { inherit providerVersions; };

  meta = {
    description = "Pulumi CLI with the exact infrastructure provider plugins";
    homepage = "https://www.pulumi.com/";
    license = lib.licenses.asl20;
    mainProgram = "pulumi";
    platforms = builtins.attrNames artifacts;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
