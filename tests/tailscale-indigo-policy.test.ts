import { strict as assert } from "node:assert"
import { test } from "node:test"

import { tailscale, tailscaleAdminUser } from "../infra/tailscale/config.ts"

const policy = tailscale.createPolicy({ adminUser: tailscaleAdminUser })
const indigoTag = tailscale.tags.cluster.indigoNode

test("device retagging targets exactly the six verified Indigo nodes", () => {
  assert.deepEqual(tailscale.deviceTagSpecs, {
    indigoControl01: {
      resourceName: "dsqr-indigo-control-01-tags",
      deviceId: "nm4BFMYxnZ11CNTRL",
      tags: [indigoTag],
    },
    indigoControl02: {
      resourceName: "dsqr-indigo-control-02-tags",
      deviceId: "nH9Rfjf4oE11CNTRL",
      tags: [indigoTag],
    },
    indigoControl03: {
      resourceName: "dsqr-indigo-control-03-tags",
      deviceId: "nXV4JPcFBh11CNTRL",
      tags: [indigoTag],
    },
    indigoWorker01: {
      resourceName: "dsqr-indigo-worker-01-tags",
      deviceId: "nE487d2SVb11CNTRL",
      tags: [indigoTag],
    },
    indigoWorker02: {
      resourceName: "dsqr-indigo-worker-02-tags",
      deviceId: "nVhza1oALE11CNTRL",
      tags: [indigoTag],
    },
    indigoWorker03: {
      resourceName: "dsqr-indigo-worker-03-tags",
      deviceId: "n35gDmGxvw11CNTRL",
      tags: [indigoTag],
    },
  })
})

test("Indigo identity staging preserves every existing network grant and route approval", () => {
  assert.deepEqual(policy.grants, [
    { src: [tailscaleAdminUser], dst: ["*"], ip: ["*"] },
    { src: ["tag:workstation"], dst: ["*"], ip: ["*"] },
    { src: ["tag:server"], dst: ["tag:server"], ip: ["*"] },
    {
      src: ["tag:mail"],
      dst: ["beacon-observability"],
      ip: ["tcp:9090", "tcp:3100"],
    },
    { src: ["tag:mail"], dst: ["tag:backup"], ip: ["tcp:22"] },
    { src: ["tag:backup"], dst: ["tag:proxmox"], ip: ["tcp:22"] },
  ])
  assert.deepEqual(policy.autoApprovers, { exitNode: ["tag:exit-node"] })
  assert.deepEqual(policy.hosts, { "beacon-observability": "100.97.79.78" })
  assert.equal("ssh" in policy, false, "Do not switch OpenSSH to Tailscale SSH")
})

test("the staged DSQR Indigo tag is admin-owned without changing legacy enrollment", () => {
  assert.equal(indigoTag, "tag:dsqr-indigo-node")
  assert.deepEqual(policy.tagOwners[indigoTag], [tailscaleAdminUser])
  assert.deepEqual(Object.keys(tailscale.keySpecs).sort(), [
    "homelabBackup",
    "homelabServer",
    "indigoNode",
    "mailServer",
  ])
  assert.deepEqual(tailscale.keySpecs.homelabServer.tags, ["tag:homelab", "tag:server"])
})

test("new Indigo enrollments use only the restricted Indigo identity", () => {
  assert.deepEqual(tailscale.keySpecs.indigoNode, {
    resourceName: "dsqr-indigo-node-key",
    description: "DSQR Indigo node bootstrap",
    tags: [indigoTag],
    lifecycle: "server-bootstrap",
  })
})

// Assert the policy submitted to Tailscale contains the required checks. The
// Tailscale control plane evaluates them; this is not a local policy evaluator.
test("policy assertions protect admin SSH and check representative lateral-access denials", () => {
  for (const src of [tailscaleAdminUser, "tag:workstation"]) {
    const check = policy.tests.find((entry) => entry.src === src)
    assert.ok(check)
    assert.equal(check.proto, "tcp")
    assert.ok("accept" in check && new Set<string>(check.accept).has(`${indigoTag}:22`))
  }

  const fromServer = policy.tests.find((entry) => entry.src === "tag:server")
  assert.ok(fromServer && "deny" in fromServer)
  assert.deepEqual(fromServer.deny, [
    `${indigoTag}:22`,
    `${indigoTag}:443`,
    `${indigoTag}:6443`,
    `${indigoTag}:10250`,
  ])

  const fromIndigo = policy.tests.find((entry) => entry.src === indigoTag)
  assert.ok(fromIndigo && "deny" in fromIndigo)
  assert.deepEqual(fromIndigo.deny, [
    "tag:server:22",
    "tag:server:443",
    "tag:backup:22",
    `${indigoTag}:22`,
    `${indigoTag}:2379`,
    `${indigoTag}:6443`,
    `${indigoTag}:10250`,
    "beacon-observability:9090",
    "beacon-observability:3100",
  ])
})

test("policy assertions use the configured admin identity rather than a hardcoded account", () => {
  const alternate = tailscale.createPolicy({ adminUser: "admin@example.test" })
  assert.deepEqual(alternate.tagOwners[indigoTag], ["admin@example.test"])
  assert.deepEqual(alternate.tests[0], {
    src: "admin@example.test",
    proto: "tcp",
    accept: [`${indigoTag}:22`],
  })
})
