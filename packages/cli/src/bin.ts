#!/usr/bin/env node

import { Command } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

import { infrastructure } from "../../../infra.config.ts"
import { makeInfraCommand } from "./command.ts"

const cli = Command.run(makeInfraCommand(infrastructure, infrastructure.stage), {
  name: "DSQR Infrastructure",
  version: "0.0.0",
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
