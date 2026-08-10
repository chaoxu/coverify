// FAILED.md as the keyed record set it already is in practice (issue #28).
//
// The launcher requires a check before every route, materially changed retry,
// or variant: "check `FAILED.md` and record either `no close prior route` or
// `closest prior route is X; this differs materially because ...`". That is a
// LOOKUP. The only affordance was reading the file, which is append-only and
// grows for the life of a campaign, so the check got more expensive with every
// entry it was supposed to consult.
//
// Measured across the seven campaigns on 2026-08-10: 404 full-file reads in
// the reasoner lane at 31 KB and 20 entries each, and because a read sits in
// the session and is re-presented on every later turn, 161.6M chars ≈ 40.4M
// tokens presented — about 6.9% of that lane's presented tokens.
//
// This module is deliberately format-TOLERANT. The issue that motivated it
// assumed entries look like `## F001 - M1 <title>`; that holds in ONE of seven
// campaigns. The others use `## CE-MAT-FLAG — ...` and
// `## F-H1-NAIVE-RELAY-01 — ...`. So nothing here parses an id scheme or
// expects a mechanism label in a fixed position: an entry is a `## ` heading
// and the lines under it, and matching is over that text. A parser that
// demanded the documented shape would silently return nothing on six campaigns
// out of seven, which is worse than the full read it replaces.

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
    // Fence-aware. A `## ` inside a fenced block is a code comment, not a
    // heading, and treating it as one both invents a phantom entry AND
    // detaches everything after it from the real entry — including the
    // "what would make a retry materially new" line the launcher requires,
    // which is precisely the text a lookup is asked about. Latent today (zero
    // instances across the eight ledgers on disk), but technician output and
    // counterexample transcripts are exactly what gets fenced into FAILED.md.
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

/** Words that carry no routing signal. Without this list a query written as a
 *  sentence ranks on "the" and "not": an entry whose HEADING contains three
 *  stopwords scored 6 and outranked the entry whose body held the actual close
 *  route — the tool presenting noise first under a "best first" label, which
 *  is the false-"no close prior route" failure this lookup exists to prevent. */
const STOPWORDS = new Set([
  "the", "and", "for", "not", "all", "any", "are", "but", "can", "did", "does", "from", "had", "has",
  "have", "how", "into", "its", "may", "non", "one", "only", "our", "out", "per", "should", "since",
  "some", "such", "than", "that", "them", "then", "there", "these", "they", "this", "those", "using",
  "was", "were", "what", "when", "which", "while", "with", "would", "you", "your", "want", "try",
]);

/** Words worth matching on: drops punctuation, one-character tokens, and
 *  stopwords, so a query written as a sentence matches on its content words.
 *  Case-insensitive throughout, because mechanism labels are written
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
 * Rank entries against a query. A term in the heading counts double: headings
 * carry the mechanism label when a campaign uses one, so "closest prior route"
 * is usually a heading question.
 *
 * Returns every entry with a nonzero score, best first. Selecting how many to
 * return is the CALLER's job, not this function's — a lookup that silently
 * truncated would reintroduce, one layer down, the "you cannot see what you
 * did not fetch" problem the whole issue is about.
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
