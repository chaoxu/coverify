// Per-user paths for the OAuth credential store and the gate store. Neither
// may live in the repo (credentials get committed) or in the campaign
// directory (no role's write tools may reach the gate store). XDG first, so a
// container or CI runner needs no HOME at all.
import * as os from "node:os";
import * as path from "node:path";

/** `$XDG_CONFIG_HOME`, else `~/.config`. Relative values are ignored per the
 *  spec: one would move the credential store with the working directory. */
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
