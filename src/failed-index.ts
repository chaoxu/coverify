// FAILED.md as the keyed record set it already is in practice (issue #28): the
// launcher's prior-route check is a LOOKUP, not a full read of a file that grows
// for the life of a campaign. Measured across seven campaigns on 2026-08-10: 404
// full-file reads in the reasoner lane at 31 KB each, ~40.4M tokens presented,
// 6.9% of that lane. Deliberately format-TOLERANT: entry ids vary across
// campaigns, so nothing parses an id scheme or expects a mechanism label in a
// fixed position — a parser demanding the documented shape returns nothing on
// six of seven campaigns.

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
  // CRLF-tolerant: a \r glued to a heading is not verbatim, and the miss path
  // prints headings.
  for (const line of md.split(/\r?\n/)) {
    // Fence-aware: a `## ` inside a fenced block is a code comment; treating it
    // as a heading invents a phantom entry AND detaches the rest of the real
    // one, including the "materially new" line a lookup is asked about.
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

/** Words that carry no routing signal: without this list a heading with three
 *  stopwords outranks the entry whose body holds the actual close route. */
const STOPWORDS = new Set([
  "the", "and", "for", "not", "all", "any", "are", "but", "can", "did", "does", "from", "had", "has",
  "have", "how", "into", "its", "may", "non", "one", "only", "our", "out", "per", "should", "since",
  "some", "such", "than", "that", "them", "then", "there", "these", "they", "this", "those", "using",
  "was", "were", "what", "when", "which", "while", "with", "would", "you", "your", "want", "try",
]);

/** Words worth matching on. Case-insensitive: mechanism labels are written
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
  /** How many query terms this entry contains, so a caller sees WHY it ranked. */
  score: number;
}

/** Rank entries against a query, best first; a heading term counts double.
 *  Returns EVERY nonzero-scoring entry — truncating here would reintroduce the
 *  "cannot see what you did not fetch" problem one layer down. */
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
