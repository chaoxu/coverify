import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { createModels } from "@earendil-works/pi-ai";

type CredentialStore = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;

const DEFAULT_FILE = path.join(os.homedir(), ".config/coverify/auth.json");

/**
 * File-backed credential store for pi-ai OAuth credentials (subscription
 * auth: Anthropic Claude Pro/Max, OpenAI Codex/ChatGPT). One JSON map,
 * providerId → credential, mode 0600. pi-ai refreshes expiring tokens
 * through `modify`, which we serialize with a promise chain.
 */
export function fileCredentialStore(file = DEFAULT_FILE): CredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const load = (): Record<string, Credential> => {
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return {};
    }
  };
  const save = (map: Record<string, Credential>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
  return {
    async read(providerId) {
      return load()[providerId];
    },
    async list() {
      return Object.entries(load())
        .filter(([, c]) => c !== undefined)
        .map(([providerId, c]) => ({ providerId, type: (c as { type: "api_key" | "oauth" }).type }));
    },
    modify(providerId, fn) {
      return enqueue(async () => {
        const map = load();
        const next = await fn(map[providerId]);
        if (next === undefined) delete map[providerId];
        else map[providerId] = next;
        save(map);
        return next;
      });
    },
    async delete(providerId) {
      await enqueue(async () => {
        const map = load();
        delete map[providerId];
        save(map);
      });
    },
  };
}
