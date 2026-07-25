#!/usr/bin/env node

import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

import { runGitOpsGenerateCli } from "../generate.ts"
import { runGitOpsMain } from "../main.ts"

runGitOpsMain(
  runGitOpsGenerateCli(process.argv.slice(2)).pipe(Effect.provide(NodeContext.layer)),
).pipe(NodeRuntime.runMain)
