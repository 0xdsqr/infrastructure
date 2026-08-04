import { Config, Effect } from "effect"

import { requiredRedacted, requiredString } from "../environment.ts"

const environment = Config.all({
  accountId: requiredString("CLOUDFLARE_ACCOUNT_ID"),
  apiToken: requiredRedacted("CLOUDFLARE_API_TOKEN"),
  r2ApiToken: requiredRedacted("CLOUDFLARE_R2_API_TOKEN"),
  dsqrDevZoneId: requiredString("CLOUDFLARE_DSQR_DEV_ZONE_ID"),
  fidaraZoneId: requiredString("CLOUDFLARE_FIDARA_ZONE_ID"),
  tastingswithtayZoneId: requiredString("CLOUDFLARE_TWT_ZONE_ID"),
  tunnelSecret: requiredRedacted("CLOUDFLARE_TUNNEL_SECRET"),
})

export const loadCloudflareConfig = Effect.fn("CloudflareConfig.load")(function* () {
  return {
    ...(yield* environment),
    hetznerMailStack: "0xdsqr/hetzner-mail/dev",
  } as const
})

export const cloudflare = {
  tunnel: {
    name: "gateway",
    defaultService: "http_status:404",
  },
  zones: {
    dsqrDev: "dsqr.dev",
    fidaraIo: "fidara.io",
    tastingswithtayCom: "tastingswithtay.com",
  },
  zoneSecurity: {
    // HSTS stays opt-in until the provider can safely import and read security_header.
    dsqrDev: {},
    fidaraIo: {},
    tastingswithtayCom: {},
  },
  mailHostname: "mx.dsqr.dev",
  dnsRecords: [
    {
      zone: "dsqrDev",
      name: "dsqr.dev",
      type: "MX",
      content: "mx.dsqr.dev",
      priority: 10,
      ttl: 1,
    },
    {
      zone: "dsqrDev",
      name: "dsqr.dev",
      type: "TXT",
      content: "v=spf1 mx -all",
      ttl: 1,
    },
    {
      zone: "dsqrDev",
      name: "_dmarc.dsqr.dev",
      type: "TXT",
      content: "v=DMARC1; p=quarantine; rua=mailto:postmaster@dsqr.dev; adkim=s; aspf=s",
      ttl: 1,
    },
    {
      zone: "dsqrDev",
      name: "rsa._domainkey.dsqr.dev",
      type: "TXT",
      content:
        "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuDCKIcqtrCFKCQWZ0Lv66vu0b3Sj9Unkmvic2l6rL41Y7VEBhfifOJ00T16K5Dzhbv8rkDrSkqj21gW4BcOe/gIahy4XwKwSsLPolYt2ElS4UqOkjxswwRKIeLtP5QP+yN1oXtEWMoUtHDzjOeILqwl8Sq/9n6n1S+fgeyumWMIm+qKqku84CuzxPpYdxXMipNa5q6cijfx+11sqDwep4rx1nTvUTawM4x/eYMj5zgMfRvFhhIPacr5QMq1RQYs5rv9tYrj44Q6eslXeDIA7Q01TXOeUZtTuM17cObIkU0Pm9uneMhCTXGUVxhk9eiZvsgZpy2rLaEjWNThKogoDxwIDAQAB",
      ttl: 1,
    },
    {
      zone: "dsqrDev",
      name: "ed25519._domainkey.dsqr.dev",
      type: "TXT",
      content: "v=DKIM1; k=ed25519; p=vLn6/q7xPftjFkPXw9m31vE6tEt+pyoJVmAmp0Q/JEs=",
      ttl: 1,
    },
  ],
  r2Buckets: [
    {
      resourceName: "homelab-backups",
      name: "dsqr-homelab-backups",
      location: "enam",
      jurisdiction: "default",
      storageClass: "Standard",
      lock: {
        retentionDays: 30,
      },
    },
  ],
  ingressRules: [
    {
      hostname: "argocd-hooks-hub-a.dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "argocd-hooks-hub-a.dsqr.dev",
        originServerName: "argocd-hooks-hub-a.dsqr.dev",
      },
    },
    {
      hostname: "dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "dsqr.dev",
        originServerName: "dsqr.dev",
      },
    },
    {
      hostname: "studio.dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "studio.dsqr.dev",
        originServerName: "studio.dsqr.dev",
      },
    },
    {
      hostname: "labs.dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "labs.dsqr.dev",
        originServerName: "labs.dsqr.dev",
      },
    },
    {
      hostname: "fidara.io",
      zone: "fidaraIo",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "fidara.io",
        originServerName: "fidara.io",
      },
    },
    {
      hostname: "api.fidara.io",
      zone: "fidaraIo",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "api.fidara.io",
        originServerName: "api.fidara.io",
      },
    },
    {
      hostname: "s3.dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.107:9000",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "s3.dsqr.dev",
        originServerName: "rustfs.service.home.arpa",
      },
    },
    {
      hostname: "cdn.dsqr.dev",
      zone: "dsqrDev",
      service: "https://10.10.30.107:9000",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "cdn.dsqr.dev",
        originServerName: "rustfs.service.home.arpa",
      },
    },
    {
      hostname: "tastingswithtay.com",
      zone: "tastingswithtayCom",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "tastingswithtay.com",
        originServerName: "tastingswithtay.com",
      },
    },
    {
      hostname: "admin.tastingswithtay.com",
      zone: "tastingswithtayCom",
      service: "https://10.10.30.200",
      originRequest: {
        http2Origin: false,
        httpHostHeader: "admin.tastingswithtay.com",
        originServerName: "admin.tastingswithtay.com",
      },
    },
  ],
} as const
