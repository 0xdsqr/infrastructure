import { strict as assert } from "node:assert"
import { test } from "node:test"

import { transformResourceArgs } from "@dsqr/pulumi-shared"

test("Pulumi transforms return composable patches without mutating inputs", () => {
  const args = { name: "before", size: 1 }
  const options = { protect: false }
  const result = transformResourceArgs(
    (_args, _options, name) => ({
      args: { name: `${name}-after` },
      options: { protect: true },
    }),
    "resource",
    args,
    options,
  )

  assert.deepEqual(result, ["resource", { name: "resource-after", size: 1 }, { protect: true }])
  assert.deepEqual(args, { name: "before", size: 1 })
  assert.deepEqual(options, { protect: false })
})
