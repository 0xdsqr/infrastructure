#!/usr/bin/env node

import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

import { runGitOpsCheckCli } from "../check.ts"
import { runGitOpsMain } from "../main.ts"

runGitOpsMain(
  runGitOpsCheckCli(process.argv.slice(2)).pipe(Effect.provide(NodeContext.layer)),
).pipe(NodeRuntime.runMain)
