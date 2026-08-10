// Helpers shared by the read-only measurement consumers. A reader may import from core;
// core may never import from a view (scripts/conformance-check.ts).
import { GateStore } from "../gates.js";

/** Open a campaign and read its records, optionally narrowed to one run. The
 *  `as unknown` cast is the single place the deliberately-open write shape is
 *  narrowed for the view layer, and the run filter is what keeps `runId` from
 *  being a write-only field. */
export function runRecords(
  campaignDir: string,
  run?: string,
): { store: GateStore; records: Record<string, unknown>[] } {
  const store = new GateStore(campaignDir);
  const records = (store.all() as unknown as Record<string, unknown>[]).filter(
    (r) => run === undefined || r.runId === run,
  );
  return { store, records };
}

/** Tokens in millions, the unit every spend table prints. */
export const M = (n: number): string => `${(n / 1e6).toFixed(2)}M`;

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
