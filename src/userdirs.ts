// Where per-user files live. Two of them, and only two: the OAuth credential
// store and the gate store.
//
// HOME is not an INPUT coverify needs to run — nothing it reads to do its job
// comes from there, and scripts/conformance-check.ts fails the build on any
// src/ file that reaches into a hand-written home path (that check is what
// caught coverify reading its own contract from ~/kb, issue #44).
//
// It is where two per-user OUTPUTS have to go, and neither has an alternative:
//
//   - credentials must NOT live in the repository (they would be committed)
//     and must NOT live in the campaign directory (a campaign is a project
//     folder that gets shared);
//   - the gate store must live outside the campaign tree ON PURPOSE. It is the
//     authoritative verification record, and the whole trust argument is that
//     no role's workspace write tools can reach it. Putting it in the campaign
//     would hand every agent a file that decides what it is allowed to promote.
//
// So `HOME=/nonexistent` is a useful PROBE — it proves there is no hidden
// input — but it is not a viable default: a real campaign needs somewhere to
// keep both. What a distributable tool owes instead is the standard: honour
// XDG so a container, a CI runner, or a multi-tenant host can point both
// somewhere writable without touching HOME at all, and fail with a sentence
// naming the variable when nothing is usable, rather than `EROFS: mkdir
// '/nonexistent'`.
import * as os from "node:os";
import * as path from "node:path";

/** `$XDG_CONFIG_HOME`, else `~/.config`. Absolute paths only: the spec says a
 *  relative value is invalid and must be ignored, and honouring one would put
 *  credentials somewhere that moves with the working directory. */
export function configHome(): string {
  return xdg("XDG_CONFIG_HOME", ".config");
}

/** `$XDG_STATE_HOME`, else `~/.local/state`. */
export function stateHome(): string {
  return xdg("XDG_STATE_HOME", ".local/state");
}

function xdg(variable: string, fallback: string): string {
  const set = process.env[variable];
  if (set !== undefined && set !== "" && path.isAbsolute(set)) return set;
  const home = os.homedir();
  // homedir() returns "" (or a path that cannot be created) when HOME is unset
  // or bogus — in a container, a systemd unit, or a `sudo -u` shell. Say which
  // variable fixes it instead of failing later inside an mkdir.
  if (home === "" || home === "/nonexistent") {
    throw new Error(
      `cannot resolve a per-user directory: $${variable} is unset and HOME is ` +
        `${home === "" ? "unset" : `"${home}"`}. Set $${variable} to an absolute writable path ` +
        "(coverify keeps only your credentials and the out-of-campaign gate store there; " +
        "COVERIFY_STATE_DIR overrides the gate store alone).",
    );
  }
  return path.join(home, fallback);
}
