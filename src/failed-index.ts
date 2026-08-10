// FAILED.md as the keyed record set it already is in practice (issue #28). The
// launcher's prior-route check is a LOOKUP, but the only affordance was reading
// an append-only file that grows for the life of a campaign.
//
// Measured across seven campaigns on 2026-08-10: 404 full-file reads in the
// reasoner lane at 31 KB each, and because a read sits in the session and is
// re-presented every later turn, 161.6M chars ~ 40.4M tokens presented — about
// 6.9% of that lane's presented tokens.
//
// Deliberately format-TOLERANT: entry ids vary across campaigns (`## F001 - M1`,
// `## CE-MAT-FLAG — ...`, `## F-H1-NAIVE-RELAY-01 — ...`), so nothing here
// parses an id scheme or expects a mechanism label in a fixed position. A parser
// demanding the documented shape returns nothing on six of seven campaigns,
// which is worse than the full read it replaces.

export interface FailedEntry {
  heading: string;
  /** Heading plus body, verbatim — what a matching lookup returns. */
  text: string;
}

/** Split an append-only FAILED.md into its `## ` entries. Text before the
 *  first entry (the `# FAILED (append-only)` banner) belongs to no entry. */
export function parseFailedEntries(md: string): FailedEntry[] {
  const out: FailedEntry[] = [];
  let heading: string | undefined;
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    if (heading !== undefined) out.push({ heading, text: [heading, ...lines].join("\n").trimEnd() });
    lines = [];
  };
  // CRLF-tolerant: a \r left glued to a heading is not verbatim, and the miss
  // path prints headings.
  for (const line of md.split(/\r?\n/)) {
    // Fence-aware: a `## ` inside a fenced block is a code comment, and treating
    // it as a heading both invents a phantom entry AND detaches the rest of the
    // real entry, including the "materially new" line a lookup is asked about.
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) {
      flush();
      heading = line;
    } else if (heading !== undefined) {
      lines.push(line);
    }
  }
  flush();
  return out;
}

/** Words that carry no routing signal. Without this list a sentence-shaped query
 *  ranks on "the" and "not": a heading with three stopwords scored 6 and
 *  outranked the entry whose body held the actual close route — noise presented
 *  first under a "best first" label. */
const STOPWORDS = new Set([
  "the", "and", "for", "not", "all", "any", "are", "but", "can", "did", "does", "from", "had", "has",
  "have", "how", "into", "its", "may", "non", "one", "only", "our", "out", "per", "should", "since",
  "some", "such", "than", "that", "them", "then", "there", "these", "they", "this", "those", "using",
  "was", "were", "what", "when", "which", "while", "with", "would", "you", "your", "want", "try",
]);

/** Words worth matching on: drops punctuation, one-character tokens, and
 *  stopwords. Case-insensitive, because mechanism labels are written
 *  inconsistently across campaigns. */
function terms(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

export interface FailedMatch extends FailedEntry {
  /** How many query terms this entry contains. Reported so a caller can see
   *  WHY something ranked, rather than trusting an opaque order. */
  score: number;
}

/**
 * Rank entries against a query, best first. A heading term counts double, since
 * headings carry the mechanism label when a campaign uses one. Returns EVERY
 * nonzero-scoring entry: selecting how many to return is the caller's job, or a
 * silent truncation here reintroduces the "cannot see what you did not fetch"
 * problem one layer down.
 */
export function matchFailedEntries(entries: readonly FailedEntry[], query: string): FailedMatch[] {
  const q = terms(query);
  if (q.length === 0) return [];
  return entries
    .map((e) => {
      const head = terms(e.heading);
      const body = terms(e.text);
      let score = 0;
      for (const t of q) {
        if (head.includes(t)) score += 2;
        else if (body.includes(t)) score += 1;
      }
      return { ...e, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
}
