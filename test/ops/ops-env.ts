/**
 * Shared by the ops cases. They need tools and privileges the CI runner does not always have
 * (nft, unprivileged namespaces, clang with the linux headers, libbpf, root for BPF). A case whose
 * prerequisite is missing says so: the reason goes to stderr (vitest's default reporter hides
 * console output but not that) and to the skip note of the verbose reporters. With
 * HAXLITE_REQUIRE_OPS=1 the case fails instead, so a runner that is meant to cover them cannot
 * lose them quietly.
 */
import type { TestContext } from 'vitest';

export const REQUIRE_OPS = process.env.HAXLITE_REQUIRE_OPS === '1';

const told = new Set<string>();

/** Skips the case (fails it under HAXLITE_REQUIRE_OPS=1) when `missing`, the reason it cannot run, is not null. */
export function needs(ctx: TestContext, missing: string | null): void {
  if (missing === null) return;
  if (REQUIRE_OPS) throw new Error(`HAXLITE_REQUIRE_OPS=1 but ${missing}`);
  if (!told.has(missing)) {
    told.add(missing);
    process.stderr.write(`[ops] skipped: ${missing} (HAXLITE_REQUIRE_OPS=1 makes it an error)\n`);
  }
  ctx.skip(missing);
}

/** First line of what a failed probe printed, for the reason. */
export function why(what: string, r: { stderr?: string | null; error?: Error }): string {
  const detail = (r.error?.message ?? r.stderr ?? '').trim().split('\n')[0];
  return detail ? `${what} (${detail})` : what;
}
