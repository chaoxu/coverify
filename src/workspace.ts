// The role tool surface — launcher-clause enforcement (design rule 1), because
// the tool surface is where these clauses bite: append-only ledgers
// (APPEND_ONLY_LEDGERS), preregistered-code-only writes (PROSE_EXTS),
// literature-report provenance names, and the campaign read scope derived from
// the user-frozen STATEMENT.md. Conformance rows live in docs/design.md.
// The mechanics this lane stands on — sandboxing, supervision, scope
// resolution — live in sandbox.ts; the import edge points that way only.
// Role prompt text does NOT live here (LIBRARIAN_CHARGE is in roles.ts).
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { type AgentTool } from "@earendil-works/pi-agent-core";
import { campaignExists } from "./campaign.js";
import { matchFailedEntries, parseFailedEntries } from "./failed-index.js";
import { LIBRARIAN_CHARGE } from "./roles.js";
import {
  OUTPUT_LIMIT,
  assertInScope,
  inScope,
  realResolve,
  runMemMb,
  runTimeoutMs,
  sandboxedArgv,
  supervise,
  toolText,
  under,
  type WriteScope,
} from "./sandbox.js";
import {
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The only way a role executes code. Enforces the launcher's "Never run
 * unsupervised detached compute.": argv only and confined to the role's own
 * directory (no shell, no host interpreter, so detach primitives are not
 * expressible), whole-process-tree kill on exit/timeout, and an RSS watchdog
 * so a runaway search is killed before it exhausts the host — detached
 * setsid-nohup search jobs memory-exhausted saturn into a kernel panic on
 * 2026-08-01.
 */
export function runScriptTool(
  cwd: string,
  scope: WriteScope,
  opts?: { exclusiveDir?: boolean },
): AgentTool {
  return {
    name: "run_script",
    label: "Run scripts",
    description:
      `Run 1-8 script files concurrently, supervised, under ONE shared cap. Working directory: ${cwd}. ` +
      "Each script must be a file inside your assigned directory: a .py runs under python3, " +
      "anything else must be executable. Write scripts with the write tool first. Limits for the " +
      `whole batch: ${Math.round(runTimeoutMs() / 60000)} minutes, ${runMemMb()} MB combined RSS; ` +
      "writes are OS-sandboxed to your assigned directories; when the batch ends (or hits a limit) " +
      "the whole process tree is killed — nothing survives the call. Route genuinely long " +
      "computation through the scheduler front door instead.",
    parameters: Type.Object({
      runs: Type.Array(
        Type.Object({
          path: Type.String({ description: "Script file to run" }),
          args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script" })),
        }),
        { minItems: 1, maxItems: 8, description: "Scripts to run concurrently under the shared cap" },
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const { runs } = params as { runs: { path: string; args?: string[] }[] };
      const jobs: { label: string; script: string; argv: string[] }[] = [];
      for (const r of runs) {
        const script = path.resolve(cwd, r.path);
        const label = [r.path, ...(r.args ?? [])].join(" ");
        // The script must be one the role wrote in its own scope. Without
        // this, `path` could name any host executable (/bin/sh -c ..., or
        // python3 -c ...), handing back the general shell this tool removes.
        if (!inScope(scope, script)) {
          return toolText(
            `[error: ${r.path}: run_script executes only scripts inside your assigned directory; ` +
              "write the script there first]",
          );
        }
        if (!fs.existsSync(script)) return toolText(`[error: no such script: ${script}]`);
        if (script.endsWith(".py")) jobs.push({ label, script, argv: ["python3", script, ...(r.args ?? [])] });
        else {
          try {
            fs.accessSync(script, fs.constants.X_OK);
            jobs.push({ label, script, argv: [script, ...(r.args ?? [])] });
          } catch {
            return toolText(`[error: ${r.path}: script must be .py or an executable file]`);
          }
        }
      }
      // Sweep marks. The batch's own script paths are always safe to match.
      // The working directory is added only when it belongs exclusively to
      // this batch (a dispatched agent's own evidence directory): that is what
      // catches a helper launched in a new session running a *different* file
      // there. On a shared directory — vanilla pi opened on a project — the
      // same match would adopt and kill other agents' processes, so it is
      // omitted and that recall is given up deliberately.
      const marks = jobs.map((j) => j.script);
      if (opts?.exclusiveDir) marks.push(cwd);
      const { outs, fate } = await supervise(
        jobs.map(({ argv }) => sandboxedArgv(argv, scope)),
        { cwd, marks, signal },
      );
      const sections = jobs.map(({ label }, i) => {
        let out = [outs[i].stdout, outs[i].stderr].filter(Boolean).join("\n--- stderr ---\n");
        if (out.length > OUTPUT_LIMIT) {
          // Tee before truncating (ecosystem review 2026-08-02, from hypa's
          // pattern): the tail was the tool layer's one silently-lost data.
          // The full output lands in the role's own directory as an ordinary
          // retrievable artifact.
          let ref = "";
          try {
            const teeName = `run_script-full-${Date.now()}-${i}.log`;
            fs.writeFileSync(path.join(cwd, teeName), out);
            ref = `; full output saved to ${teeName}`;
          } catch {
            /* tee is best-effort; truncation marker stays honest either way */
          }
          out = out.slice(0, OUTPUT_LIMIT) + `\n[truncated${ref}]`;
        }
        if (outs[i].failure) out = `${out}\n[error: ${outs[i].failure}]`;
        return jobs.length === 1 ? out : `## ${label}\n${out || "(no output)"}`;
      });
      let combined = sections.join("\n\n");
      if (fate) combined = `${combined}\n[error: ${fate}; whole process tree killed]`;
      return toolText(combined || "(no output)");
    },
  } as AgentTool;
}

/** Without a code grant, roles write prose artifacts only. */
const PROSE_EXTS = new Set([".md", ".txt"]);

/** Launcher: FAILED.md and PROVED.md are append-only. PROVED.md is already
 *  write-denied by scope (record_promotion is its sole writer); FAILED.md
 *  rewrites must preserve existing entries as an unchanged prefix. */
const APPEND_ONLY_LEDGERS = new Set(["failed.md"]);

/**
 * Librarian command: an external subscription CLI agent that does the web
 * search and returns a compiled report, so no campaign role ever touches the
 * network itself. Space-split argv; the librarian prompt is appended as the
 * final argument.
 */
const literatureCmd = () =>
  (process.env.COVERIFY_LITERATURE_CMD ?? "agy --dangerously-skip-permissions --print-timeout 168h -p").split(
    /\s+/,
  );

/**
 * State directories the librarian CLI may write (token refresh, cache).
 * Deliberately narrow: `~/.claude`, `~/.codex`, and `~/.config` hold settings
 * and hook files that execute on a later run — and coverify's own OAuth store
 * lives in `~/.config/coverify` — so a role-authored prompt must not reach
 * them. Override for a different librarian binary with
 * COVERIFY_LITERATURE_STATE_DIRS (colon-separated absolute paths).
 */
const librarianStateDirs = () =>
  (
    process.env.COVERIFY_LITERATURE_STATE_DIRS?.split(":").filter(Boolean) ??
    [".gemini", ".antigravity"].map((d) => path.join(os.homedir(), d))
  ).filter((d) => path.isAbsolute(d) && d !== os.homedir());

/**
 * Delegated literature search: spawns the librarian CLI supervised (own
 * process group, killed on exit/timeout) and archives the full report as an
 * evidence artifact so citations remain auditable.
 */
function literatureSearchTool(
  cwd: string,
  scope: WriteScope,
  onUnmetered?: (lane: string, detail: string) => void,
): AgentTool {
  return {
    name: "literature_search",
    label: "Literature search",
    description:
      "Ask an external librarian agent (with live web search) one literature question. Returns a " +
      "compiled report with citations and URLs, archived verbatim under your evidence directory " +
      "as literature-<n>.md. The librarian's claims are secondhand: treat them as leads, cite the " +
      "archived report, and label dependencies per the contract. One question per call; " +
      `${Math.round(runTimeoutMs() / 60000)}-minute limit.`,
    parameters: Type.Object({
      question: Type.String({ description: "The literature question, self-contained" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const { question } = params as { question: string };
      // Sandboxed and supervised exactly like run_script — the librarian is a
      // full coding agent (its default argv skips its own permission prompts)
      // driven by a role-authored question, so it gets the same write
      // confinement, memory cap, tree kill, and reaper. Its own state
      // directories stay writable: a CLI that cannot refresh its OAuth token
      // fails as an opaque non-zero exit.
      const spec = sandboxedArgv([...literatureCmd(), LIBRARIAN_CHARGE + question], {
        allow: [...scope.allow, ...librarianStateDirs()],
        deny: scope.deny,
      });
      const { outs, fate } = await supervise([spec], {
        cwd,
        signal,
        outputLimit: OUTPUT_LIMIT * 4,
        // 7-day wall: hang protection, never a search-work limit (user
        // decision, Chao 2026-08-09). The 10-minute batch cap is for
        // host-protection of computation, not for a thinking librarian.
        timeoutMs: 7 * 24 * 3_600_000,
      });
      // Real spend, no measurement: agy's -p mode emits a plain report with no
      // usage payload. Recorded as a gap whether it succeeded or failed —
      // a failed librarian was still billed for whatever it searched.
      onUnmetered?.(
        "librarian",
        `literature_search via \`${literatureCmd()[0]}\` — external agent, no machine-readable usage`,
      );
      const { stdout, stderr, failure } = outs[0];
      if (fate || failure || !stdout.trim()) {
        const detail = fate ?? failure ?? "produced no report";
        return toolText(`[error: librarian ${detail}]${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`);
      }
      // The harness owns the archive name and content: a librarian report is
      // provenance, so a role must never be able to author one by hand.
      const n = fs.readdirSync(cwd).filter((f) => /^literature-\d+\.md$/i.test(f)).length + 1;
      const artifact = path.join(cwd, `literature-${n}.md`);
      fs.writeFileSync(
        artifact,
        `# Literature search ${n}\n\nLibrarian: \`${literatureCmd().join(" ")}\` (self-attested provenance)\n\n## Question\n\n${question}\n\n## Report\n\n${stdout}\n`,
      );
      let out = stdout;
      if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated; full report in artifact]";
      return toolText(`[archived: ${artifact}]\n\n${out}`);
    },
  } as AgentTool;
}

/**
 * Read scope: a role may read only campaign content — the campaign tree plus
 * the prior-route paths its STATEMENT.md declares (both are model-written
 * campaign material; the statement is user-frozen). Nothing else: on
 * 2026-08-09 workers literature-hunted with grep over all of $HOME and other
 * agents' caches, blowing their sessions past the model context window
 * (issue #22) and leaking unrelated files into provider-bound prompts.
 * External questions belong to literature_search.
 */
export function readRoots(cwd: string): string[] {
  // The campaign root is the nearest ancestor holding STATEMENT.md — cwd is
  // a worker's evidence dir or the campaign dir itself.
  let root = realResolve(cwd);
  for (let d = root; ; d = path.dirname(d)) {
    if (campaignExists(d)) {
      root = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  const roots = [root];
  try {
    const stmt = fs.readFileSync(path.join(root, "STATEMENT.md"), "utf-8");
    // Path-like tokens: ~/x, /x, or ../x (relative to the campaign root, the
    // lin3cut convention for sibling campaigns). The preceding character must
    // not be a word char or ':', so `https://host/tmp` does not grant /tmp.
    // Trailing sentence punctuation is stripped ("... at ~/research/x." must
    // not silently drop the root). Only existing paths at depth >= 3 count —
    // a bare `/var` or `/tmp` mentioned in prose is never a read grant.
    for (const m of stmt.matchAll(/(?:^|[^\w:])((?:~\/|\.\.\/|\/)[\w.@+-][\w.@/+-]*)/g)) {
      const tok = (m[1] ?? "").replace(/[.,;:!?]+$/, "");
      if (!tok) continue;
      const abs = tok.startsWith("~/") ? path.join(os.homedir(), tok.slice(2)) : path.resolve(root, tok);
      if (abs.split(path.sep).filter(Boolean).length < 3) continue;
      if (fs.existsSync(abs)) roots.push(realResolve(abs));
    }
  } catch {
    /* foreign campaign without a statement: campaign tree only */
  }
  return roots;
}

/** Mirror of pi's resolveToCwd (core/tools/path-utils.ts, 0.83.0): the read
 *  tools strip a leading '@', expand `~`, and accept file:// URLs BEFORE
 *  touching the filesystem — so the guard must judge the path the tool will
 *  actually use. Judging the raw param lets `grep {path: "~"}` resolve to
 *  `<evidenceDir>/~` for the check and to $HOME for the search — reopening
 *  the exact issue-#22 hole. (Deep-importing pi's helper is blocked by its
 *  package exports map; drift is pinned by tests/read-scope.test.ts.) */
function normalizeLikePi(v: string, cwd: string): string {
  let s = v.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  if (/^file:\/\//.test(s)) s = fileURLToPath(s);
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(cwd, s);
}

const COVERIFY_STATE_RE = /(^|\/)\.coverify(\/|$)/;

/** Drop grep/ls result lines whose LEADING PATH sits under .coverify/:
 *  ripgrep runs with --hidden, so a pathless or campaign-root grep would
 *  otherwise return journal and session-transcript lines — a verification-
 *  blindness leak the param check alone cannot stop (the param was in
 *  scope). Anchored to the relpath prefix of grep's `path:line:` / `path-
 *  line-` and ls's bare-entry formats: a result line whose CONTENT merely
 *  mentions .coverify/ (after the separator) is legitimate and kept — which
 *  is also why the read tool (raw file content, no path prefix) is exempt. */
function dropCoverifyLines(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => {
    // Extract the leading path structurally, then judge it segment-exact:
    // grep match/context lines are "<path>:12: text" / "<path>-12- text"
    // (pi builds both; the \d+ requirement keeps a ':' or '-' inside a
    // directory name from ending the path early); anything else (ls
    // entries) is judged whole. Character-class prefix guessing broke both
    // ways — paths with spaces leaked, .coverify-* siblings were dropped.
    const m = /^(.*?)[:-]\d+[:-] /.exec(l);
    const prefix = m?.[1] ?? l.trimEnd();
    return !COVERIFY_STATE_RE.test(prefix);
  });
  const dropped = lines.length - kept.length;
  return dropped === 0 ? text : `${kept.join("\n")}\n[${dropped} line(s) under .coverify/ withheld: harness state]`;
}

function dropCoverifyResult(result: Awaited<ReturnType<AgentTool["execute"]>>): typeof result {
  return {
    ...result,
    content: result.content.map((b) => (b.type === "text" ? { ...b, text: dropCoverifyLines(b.text) } : b)),
  };
}

/** Cap a read-tool result's text to OUTPUT_LIMIT chars — the same bound
 *  run_script output gets. 130k-char grep results were a direct cause of the
 *  issue-#22 worker context overflows; the full file is always re-readable
 *  with a narrower query. */
function capResultText(result: Awaited<ReturnType<AgentTool["execute"]>>): typeof result {
  let budget = OUTPUT_LIMIT;
  const content = result.content.map((block) => {
    if (block.type !== "text") return block;
    if (block.text.length <= budget) {
      budget -= block.text.length;
      return block;
    }
    const kept = budget;
    budget = 0;
    return {
      ...block,
      text:
        block.text.slice(0, kept) +
        `\n[truncated: result exceeded the ${OUTPUT_LIMIT}-char read budget; narrow the query]`,
    };
  });
  return { ...result, content };
}

function confineReads(tool: AgentTool, roots: string[], cwd: string): AgentTool {
  // Result-side .coverify filtering applies to the directory-traversing tools
  // (grep/ls, whose lines carry a path prefix); read returns raw file content
  // where a .coverify mention is content, not a leak.
  const filterResults = tool.name !== "read";
  const guard = (r: Awaited<ReturnType<AgentTool["execute"]>>) =>
    capResultText(filterResults ? dropCoverifyResult(r) : r);
  // Stated up front in the schema so roles do not discover the fence by
  // bumping into it (63 refusal round-trips measured on the first night).
  const scopeNote =
    " Readable scope: this campaign's directory and the prior-route paths its STATEMENT.md " +
    "declares; .coverify/ is harness state and is never readable. Results are capped at " +
    `${OUTPUT_LIMIT} chars — narrow queries beat broad sweeps.`;
  const execute: AgentTool["execute"] = async (toolCallId, params, signal, onUpdate) => {
    const rec = (params ?? {}) as Record<string, unknown>;
    // All three pi tools name their path parameter `path` (read/ls/grep
    // schemas, verified 0.83.0); grep's is optional and defaults to cwd,
    // which is in scope by construction.
    {
      const v = rec.path;
      if (typeof v !== "string" || v.trim() === "") {
        return guard(await tool.execute(toolCallId, params, signal, onUpdate));
      }
      let real = realResolve(normalizeLikePi(v, cwd));
      // Packets conventionally cite campaign-root-relative paths
      // (EVIDENCE/rNNN/...), but a worker's cwd is its own evidence dir —
      // five mandated reads ENOENT'd in one audited session before the
      // worker guessed ../. Fall back to root-relative when the cwd-relative
      // target does not exist (2026-08-09 session audit).
      if (!path.isAbsolute(v) && !fs.existsSync(real)) {
        const atRoot = realResolve(path.resolve(roots[0], v));
        if (fs.existsSync(atRoot)) real = atRoot;
      }
      if (!roots.some((r) => under(real, r))) {
        return toolText(
          `READ SCOPE REFUSED: ${v} is outside this campaign's read scope. In scope: ` +
            `${roots.join(", ")}. For literature or any other external material, use ` +
            "literature_search (if granted) or state the need in your report — repeating " +
            "out-of-scope attempts wastes your turn.",
        );
      }
      // Harness state is never reasoning material: journals, session
      // transcripts, and gate mirrors live under .coverify/, and reading a
      // transcript would also breach verification blindness (another agent's
      // reasoning must stay unseen).
      if (COVERIFY_STATE_RE.test(real)) {
        return toolText(
          `READ SCOPE REFUSED: ${v} is harness state (.coverify/ journals and transcripts), ` +
            "not campaign reasoning material. Read the ledgers and EVIDENCE/ instead.",
        );
      }
    }
    // Result-side filtering as well: an in-scope directory grep/ls still
    // traverses .coverify/ (ripgrep runs --hidden), so matched transcript
    // lines are withheld even when the param was legal.
    return guard(await tool.execute(toolCallId, params, signal, onUpdate));
  };
  return { ...tool, description: `${tool.description}${scopeNote}`, execute };
}

/**
 * The role tool surface for a workspace: pi's read-only file tools
 * (read, ls, grep) — confined to readRoots(cwd) — and pi's write tool wrapped
 * with the role's write scope.
 * No general shell. Code is gated: only a role whose dispatch packet carried
 * a computation declaration (launcher: "preregistered finite domain and
 * stopping rule") gets run_script and the right to write non-prose files.
 */
/**
 * Keyed access to FAILED.md, the check the contract requires before every
 * route (issue #28). Purely additive: the file stays readable in full by the
 * ordinary read tool, so this can only make the required check cheaper, never
 * hide an entry from it. That is what keeps it semantics-invisible mechanics
 * (rule 2) and out of contract territory — the filename stays meaningful and
 * the clause needs no rewording.
 *
 * A miss returns the full HEADING INDEX rather than nothing, because "no close
 * prior route" is an assertion the reasoner has to be able to make honestly.
 * Headings are a few hundred bytes against ~31 KB for the file.
 */
/** Payload bound for a match list, below the 50 KB read-tool cap so the lookup
 *  is always cheaper than the read it replaces — the whole claim of the tool. */
const FAILED_MATCH_LIMIT = 24_000;

/** Heading plus its first non-empty body line: enough to judge closeness on a
 *  miss without returning the file. */
function summarize(e: { heading: string; text: string }): string {
  const first = e.text
    .split("\n")
    .slice(1)
    .find((l) => l.trim().length > 0);
  return first === undefined ? e.heading : `${e.heading}\n    ${first.trim().slice(0, 200)}`;
}

function failedRoutesTool(failedLedger: string): AgentTool {
  return {
    name: "failed_routes",
    label: "Closed routes",
    description:
      "Look up closed routes in FAILED.md by mechanism label or keywords. Returns the matching " +
      "entries verbatim, best first, bounded; on no match, every entry's heading and first line. " +
      "Matching is lexical, so it can miss a route that is close in mechanism but differently " +
      "worded — FAILED.md remains readable in full with the read tool, and this is a lookup over " +
      "it, never a substitute for it or a restriction on it.",
    parameters: Type.Object({
      query: Type.String({
        description: "Mechanism label and/or keywords describing the route you are about to take",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const { query } = params as { query: string };
      if (!fs.existsSync(failedLedger)) {
        return toolText("FAILED.md does not exist yet — no closed routes recorded in this campaign.");
      }
      const md = await fs.promises.readFile(failedLedger, "utf8");
      const entries = parseFailedEntries(md);
      if (entries.length === 0) {
        return toolText("FAILED.md has no `## ` entries yet — no closed routes recorded.");
      }
      const matches = matchFailedEntries(entries, query);
      if (matches.length === 0) {
        // Headings ALONE are not enough to judge "close prior route": the
        // obstruction and the retry bar live in the body, and a miss is
        // lexical, so a route close in mechanism but differently worded lands
        // here. Each heading gets its first body line, which is where those
        // ledgers put the obstruction — still a fraction of the file.
        return toolText(
          `No entry in FAILED.md matched "${query}". All ${entries.length} entries, heading and ` +
            `first line, so the judgement is yours on the evidence rather than on this tool's ` +
            `lexical miss — read FAILED.md in full if any looks close:\n\n` +
            entries.map((e) => summarize(e)).join("\n"),
        );
      }
      // Bounded, and it SAYS so when it bites. An unbounded result was a net
      // regression: a query naming a revision id or a date matched every entry
      // and returned the whole 86 KB ledger — more than the ordinary read tool,
      // which caps at 50 KB and announces its offset. That re-opened the
      // issue-#22 context overflow this layer exists to prevent.
      const shown: string[] = [];
      let used = 0;
      for (const m of matches) {
        if (used + m.text.length > FAILED_MATCH_LIMIT && shown.length > 0) break;
        shown.push(m.text);
        used += m.text.length;
      }
      const head =
        `${matches.length} of ${entries.length} entries in FAILED.md matched "${query}", best first.`;
      const cut =
        shown.length < matches.length
          ? `\n\nShowing ${shown.length} of ${matches.length} matches (${FAILED_MATCH_LIMIT}-char limit). ` +
            `The rest are NOT below — narrow the query, or read FAILED.md directly, before concluding ` +
            `there is no close prior route.`
          : "";
      return toolText(`${head}${cut}\n\n${shown.join("\n\n")}`);
    },
  } as AgentTool;
}

export function workspaceTools(
  cwd: string,
  scope: WriteScope,
  opts?: {
    code?: boolean;
    literature?: boolean;
    /** Absolute path to the campaign's FAILED.md, enabling keyed lookup of
     *  closed routes (issue #28). Omitted for roles with no such check. */
    failedLedger?: string;
    /** Called when a tool spawns a provider whose tokens this harness cannot
     *  measure. The librarian is a full external agent with live web search
     *  and no machine-readable usage output, so its spend is real and
     *  invisible. Recording the GAP is the contract (measurement-protocol
     *  rule 10): a silent omission reads as "this cost nothing". */
    onUnmetered?: (lane: string, detail: string) => void;
  },
): AgentTool[] {
  const code = opts?.code === true;
  const scopedWrite = createWriteTool(cwd, {
    operations: {
      writeFile: async (absolutePath: string, content: string) => {
        assertInScope(scope, absolutePath);
        // Every rule below judges the resolved path, never the typed one: a
        // symlink named `notes.md` must not smuggle a write into a script or
        // through to a ledger under another name.
        const real = realResolve(absolutePath);
        const base = path.basename(real).toLowerCase();
        if (!code && !PROSE_EXTS.has(path.extname(base))) {
          throw new Error(
            "this role writes prose artifacts only (.md/.txt); code runs only in a technician " +
              "dispatch (launcher preregistration)",
          );
        }
        if (APPEND_ONLY_LEDGERS.has(base) && fs.existsSync(real)) {
          const prior = await fs.promises.readFile(real, "utf8");
          if (!content.startsWith(prior) && !content.startsWith(prior.trimEnd())) {
            throw new Error(
              `${path.basename(real)} is append-only (launcher): new content must begin with the existing ` +
                "content unchanged; append below it",
            );
          }
        }
        if (/^literature-\d+\.md$/i.test(base)) {
          throw new Error(
            "literature-<n>.md names are owned by literature_search (provenance): a role may " +
              "neither author nor edit one; use a different filename",
          );
        }
        await fs.promises.writeFile(absolutePath, content);
      },
      mkdir: async (dir: string) => {
        assertInScope(scope, dir);
        await fs.promises.mkdir(dir, { recursive: true });
      },
    },
  });
  const roots = readRoots(cwd);
  const tools = [
    ...[createReadTool(cwd), createLsTool(cwd), createGrepTool(cwd)].map((t) =>
      confineReads(t as AgentTool, roots, cwd),
    ),
    scopedWrite,
  ] as AgentTool[];
  if (code) tools.push(runScriptTool(cwd, scope, { exclusiveDir: true }));
  if (opts?.literature === true) tools.push(literatureSearchTool(cwd, scope, opts.onUnmetered));
  if (opts?.failedLedger !== undefined) tools.push(failedRoutesTool(opts.failedLedger));
  return tools;
}
