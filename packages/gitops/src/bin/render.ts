#!/usr/bin/env node

import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

import { runGitOpsMain } from "../main.ts"
import { runGitOpsRenderCli } from "../render.ts"

runGitOpsMain(
  runGitOpsRenderCli(process.argv.slice(2)).pipe(Effect.provide(NodeContext.layer)),
).pipe(NodeRuntime.runMain)
