#!/usr/bin/env node
/**
 * The M2 CJK latency gate, run on its own.
 *
 * `history_search_stays_within_the_cjk_latency_budget_on_a_large_history` builds
 * a ten-thousand-session fixture and times Chinese `SessionHistorySearch` calls
 * against the plan's p95 budget. Run inside the parallel host-core suite the
 * samples measure the host's load instead of the query — the same calls cost
 * 63 ms with the machine to itself and 225-384 ms while that suite runs — so the
 * budget is only enforced when this script asks for it, with the test running
 * alone. The distribution is printed either way.
 */
import { spawn } from "node:child_process";

const child = spawn(
  "cargo",
  [
    "test",
    "-p",
    "host-core",
    "--locked",
    "--",
    "--nocapture",
    "--test-threads=1",
    "history_search_stays_within_the_cjk_latency_budget",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, MINIH_MEMORY_PERF_GATE: "1" },
  },
);

child.on("error", (error) => {
  console.error(`could not run cargo: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
