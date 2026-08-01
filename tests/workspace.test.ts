// Enforcement-layer tests: workspace tool surface, grants, caps, ledger
// append-only. These lock in the hardening added after the 2026-08-01 saturn
// panic (see docs/design.md "Workspace tools and confinement").
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

process.env.COVERIFY_RUN_MEM_MB = "200";
process.env.COVERIFY_LITERATURE_CMD = "/bin/echo";
const { workspaceTools } = await import("../src/roles.ts");
const { checkDispatch } = await import("../src/gates.ts");

const store = { all: () => [] } as any;
const base = { mechanism: "m1", task: "t", context: "c", deliverable: "d", failedCheck: "no close prior route" };
const dispatch = (role: "reasoner" | "technician", extra: object = {}) =>
  checkDispatch(store, role, { ...base, ...extra } as any, undefined, 0, 0);

const text = (r: any) => r.content[0].text as string;
function tools(ws: string, opts?: { code?: boolean; literature?: boolean }) {
  const list = workspaceTools(ws, { allow: [ws], deny: [] }, opts);
  return Object.fromEntries(list.map((t: any) => [t.name, t]));
}
const tmp = (label: string) => fs.mkdtempSync(`/private/tmp/coverify-test-${label}-`);

describe("dispatch gate", () => {
  test("plain reasoner allowed", () => expect(dispatch("reasoner").allowed).toBe(true));
  test("technician with thin computation refused", () =>
    expect(dispatch("technician", { computation: "run stuff" }).allowed).toBe(false));
  test("technician with concrete bounds allowed", () =>
    expect(
      dispatch("technician", {
        computation: "exhaustive search over digraphs with n<=9 vertices, stop after 4000 samples",
      }).allowed,
    ).toBe(true));
  test("reasoner with thin literature refused", () =>
    expect(dispatch("reasoner", { literature: "check the web" }).allowed).toBe(false));
  test("reasoner with substantive literature allowed", () =>
    expect(
      dispatch("reasoner", { literature: "Is s-t linear 3-cut on directed graphs known NP-hard?" }).allowed,
    ).toBe(true));
});

describe("tool surface per grant", () => {
  const ws = tmp("surface");
  test("no grant: prose tools only", () => {
    const t = tools(ws);
    expect("run_script" in t).toBe(false);
    expect("literature_search" in t).toBe(false);
  });
  test("code grant adds run_script only", () => {
    const t = tools(ws, { code: true });
    expect("run_script" in t).toBe(true);
    expect("literature_search" in t).toBe(false);
  });
  test("literature grant adds literature_search only", () => {
    const t = tools(ws, { literature: true });
    expect("literature_search" in t).toBe(true);
    expect("run_script" in t).toBe(false);
  });
});

describe("scoped write", () => {
  const ws = tmp("write");
  const outside = tmp("outside");
  const t = tools(ws, { code: true });
  const prose = tools(ws);
  test("inside scope ok", async () => {
    await t.write.execute("t", { path: path.join(ws, "a.py"), content: "print(1)\n" });
    expect(fs.existsSync(path.join(ws, "a.py"))).toBe(true);
  });
  test("outside scope refused", async () => {
    await expect(
      t.write.execute("t", { path: path.join(outside, "evil.txt"), content: "x" }),
    ).rejects.toThrow(/outside assigned scope/);
  });
  test("code write without grant refused, prose ok", async () => {
    await expect(prose.write.execute("t", { path: path.join(ws, "b.py"), content: "x" })).rejects.toThrow(
      /prose artifacts only/,
    );
    await prose.write.execute("t", { path: path.join(ws, "note.md"), content: "# ok" });
    expect(fs.existsSync(path.join(ws, "note.md"))).toBe(true);
  });
  test("FAILED.md is append-only", async () => {
    const ledger = path.join(ws, "FAILED.md");
    await prose.write.execute("t", { path: ledger, content: "# Failed\n\n- route A\n" });
    await prose.write.execute("t", { path: ledger, content: "# Failed\n\n- route A\n- route B\n" });
    await expect(
      prose.write.execute("t", { path: ledger, content: "# Failed\n\n- route B only\n" }),
    ).rejects.toThrow(/append-only/);
    expect(fs.readFileSync(ledger, "utf8")).toContain("route A");
  });
  test("librarian report names are harness-owned (no forging, no editing)", async () => {
    const fresh = path.join(ws, "literature-7.md");
    await expect(prose.write.execute("t", { path: fresh, content: "# invented citation" })).rejects.toThrow(
      /owned by literature_search/,
    );
    expect(fs.existsSync(fresh)).toBe(false);
    const rep = path.join(ws, "literature-1.md");
    fs.writeFileSync(rep, "report");
    await expect(prose.write.execute("t", { path: rep, content: "tampered" })).rejects.toThrow(
      /owned by literature_search/,
    );
    expect(fs.readFileSync(rep, "utf8")).toBe("report");
  });
});

describe("run_script", () => {
  const ws = tmp("run");
  const t = tools(ws, { code: true });
  test("single run captures output", async () => {
    fs.writeFileSync(path.join(ws, "hello.py"), "print('hi')\n");
    expect(text(await t.run_script.execute("t", { runs: [{ path: "hello.py" }] }))).toContain("hi");
  });
  test("parallel batch runs concurrently with labeled sections", async () => {
    fs.writeFileSync(path.join(ws, "s.py"), "import sys,time\ntime.sleep(1)\nprint('done',sys.argv[1])\n");
    const t0 = Date.now();
    const out = text(
      await t.run_script.execute("t", { runs: [{ path: "s.py", args: ["a"] }, { path: "s.py", args: ["b"] }] }),
    );
    expect(Date.now() - t0).toBeLessThan(1900); // concurrent, not 2x sequential
    expect(out).toContain("done a");
    expect(out).toContain("done b");
    expect(out).toContain("## s.py a");
  });
  test("forked survivors are reaped", async () => {
    fs.writeFileSync(
      path.join(ws, "forker.py"),
      "import os,time\npid=os.fork()\nif pid==0:\n  time.sleep(300)\nelse:\n  print('BG',pid)\n",
    );
    const out = text(await t.run_script.execute("t", { runs: [{ path: "forker.py" }] }));
    const bgPid = Number(out.match(/BG (\d+)/)?.[1]);
    await new Promise((r) => setTimeout(r, 400));
    let alive = true;
    try {
      process.kill(bgPid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(bgPid, 9);
    expect(alive).toBe(false);
  });
  test("shared memory cap kills the batch", async () => {
    fs.writeFileSync(
      path.join(ws, "hog.py"),
      "import time\nb=[]\nfor i in range(150):\n  b.append(bytearray(1024*1024))\n  time.sleep(0.01)\ntime.sleep(4)\nprint('survived')\n",
    );
    const out = text(
      await t.run_script.execute("t", { runs: [{ path: "hog.py" }, { path: "hog.py" }] }),
    );
    expect(out).toContain("memory cap");
    expect(out).not.toContain("survived");
  }, 20000);
  test("sandbox blocks writes outside scope (non-temp)", async () => {
    const home = fs.mkdtempSync(process.env.HOME + "/coverify-sbx-test-");
    try {
      fs.writeFileSync(path.join(ws, "esc.py"), `open(${JSON.stringify(home + "/esc.txt")}, "w").write("x")\n`);
      const out = text(await t.run_script.execute("t", { runs: [{ path: "esc.py" }] }));
      expect(fs.existsSync(path.join(home, "esc.txt"))).toBe(false);
      expect(out).toContain("error");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// Bypasses demonstrated by review on 2026-08-01; each is a live escape from
// the confinement design.md claims, so each keeps a test.
describe("enforcement bypasses (regression)", () => {
  const ws = tmp("bypass");
  const t = tools(ws, { code: true });
  test("run_script refuses a host executable outside the scope", async () => {
    const out = text(
      await t.run_script.execute("t", { runs: [{ path: "/bin/sh", args: ["-c", "echo SHELL_REACHED"] }] }),
    );
    expect(out).not.toContain("SHELL_REACHED");
    expect(out).toContain("inside your assigned directory");
  });
  test("run_script refuses an interpreter reached by traversal", async () => {
    const out = text(await t.run_script.execute("t", { runs: [{ path: "../../../bin/sh" }] }));
    expect(out).toContain("inside your assigned directory");
  });
  test("a child that leaves the process group is still reaped", async () => {
    fs.writeFileSync(
      path.join(ws, "escape.py"),
      "import os,sys,time\npid=os.fork()\nif pid==0:\n  os.setpgrp()\n  time.sleep(300)\nelse:\n  print('BG',pid)\n  sys.stdout.flush()\n",
    );
    const out = text(await t.run_script.execute("t", { runs: [{ path: "escape.py" }] }));
    const bgPid = Number(out.match(/BG (\d+)/)?.[1]);
    expect(Number.isFinite(bgPid)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    let alive = true;
    try {
      process.kill(bgPid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(bgPid, 9);
    expect(alive).toBe(false);
  }, 20000);
  test("deny-list holds against a case-variant filename", async () => {
    const scoped = Object.fromEntries(
      workspaceTools(ws, { allow: [ws], deny: [path.join(ws, "PROVED.md")] }).map((x: any) => [x.name, x]),
    );
    fs.writeFileSync(path.join(ws, "PROVED.md"), "# real promotions\n");
    await expect(
      scoped.write.execute("t", { path: path.join(ws, "proved.md"), content: "# forged" }),
    ).rejects.toThrow(/outside assigned scope/);
    expect(fs.readFileSync(path.join(ws, "PROVED.md"), "utf8")).toContain("real promotions");
  });
  test("write refuses a symlink pointing outside the scope", async () => {
    const outside = tmp("symlink-target");
    const victim = path.join(outside, "victim.md");
    fs.writeFileSync(victim, "# untouched\n");
    const link = path.join(ws, "innocent.md");
    fs.symlinkSync(victim, link);
    const prose = tools(ws);
    await expect(prose.write.execute("t", { path: link, content: "# OWNED" })).rejects.toThrow(
      /outside assigned scope/,
    );
    expect(fs.readFileSync(victim, "utf8")).toContain("untouched");
    fs.rmSync(outside, { recursive: true, force: true });
  });
  test("run_script refuses a symlink to a host interpreter", async () => {
    const link = path.join(ws, "sh");
    if (!fs.existsSync(link)) fs.symlinkSync("/bin/sh", link);
    const out = text(
      await t.run_script.execute("t", { runs: [{ path: "sh", args: ["-c", "echo SHELL_REACHED"] }] }),
    );
    expect(out).not.toContain("SHELL_REACHED");
    expect(out).toContain("inside your assigned directory");
  });
  test("a helper launched in a new session is still reaped", async () => {
    fs.writeFileSync(path.join(ws, "helper.py"), "import time\ntime.sleep(300)\n");
    fs.writeFileSync(
      path.join(ws, "launcher.py"),
      "import subprocess,sys,os\n" +
        "p=subprocess.Popen([sys.executable, os.path.join(os.path.dirname(__file__),'helper.py')], start_new_session=True)\n" +
        "print('BG',p.pid)\nsys.stdout.flush()\n",
    );
    const out = text(await t.run_script.execute("t", { runs: [{ path: "launcher.py" }] }));
    const bgPid = Number(out.match(/BG (\d+)/)?.[1]);
    expect(Number.isFinite(bgPid)).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    let alive = true;
    try {
      process.kill(bgPid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(bgPid, 9);
    expect(alive).toBe(false);
  }, 20000);
  test("append-only holds through a differently-named symlink", async () => {
    const ledger = path.join(ws, "FAILED.md");
    fs.writeFileSync(ledger, "# Failed\n\n- route A\n");
    const link = path.join(ws, "notes-link.md");
    if (!fs.existsSync(link)) fs.symlinkSync(ledger, link);
    const prose = tools(ws);
    await expect(
      prose.write.execute("t", { path: link, content: "# history erased\n" }),
    ).rejects.toThrow(/append-only/);
    expect(fs.readFileSync(ledger, "utf8")).toContain("route A");
  });
  test("an already-aborted signal stops the batch immediately", async () => {
    fs.writeFileSync(path.join(ws, "slow2.py"), "import time\ntime.sleep(120)\nprint('finished')\n");
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const out = text((await t.run_script.execute("t", { runs: [{ path: "slow2.py" }] }, ac.signal)) as any);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(out).not.toContain("finished");
    expect(out).toContain("cancelled");
  }, 20000);
  test("a script cannot create a denied file that does not exist yet", async () => {
    const denied = path.join(ws, "PROVED.md");
    fs.rmSync(denied, { force: true });
    const guarded = Object.fromEntries(
      workspaceTools(ws, { allow: [ws], deny: [denied] }, { code: true }).map((x: any) => [x.name, x]),
    );
    fs.writeFileSync(
      path.join(ws, "forge.py"),
      `open(${JSON.stringify(denied)}, "w").write("FORGED")\n`,
    );
    await guarded.run_script.execute("t", { runs: [{ path: "forge.py" }] });
    expect(fs.existsSync(denied)).toBe(false);
  });
  test("an abort signal stops a running batch", async () => {
    fs.writeFileSync(path.join(ws, "slow.py"), "import time\ntime.sleep(120)\nprint('finished')\n");
    const ac = new AbortController();
    const started = Date.now();
    const run = t.run_script.execute("t", { runs: [{ path: "slow.py" }] }, ac.signal);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const out = text((await run) as any);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(out).not.toContain("finished");
  }, 20000);
  test("append-only holds against a case-variant ledger name", async () => {
    const prose = tools(ws);
    const ledger = path.join(ws, "FAILED.md");
    await prose.write.execute("t", { path: ledger, content: "# Failed\n\n- route A\n" });
    await expect(
      prose.write.execute("t", { path: path.join(ws, "failed.md"), content: "# erased\n" }),
    ).rejects.toThrow(/append-only/);
    expect(fs.readFileSync(ledger, "utf8")).toContain("route A");
  });
});

describe("literature_search (stub librarian)", () => {
  const ws = tmp("lit");
  const t = tools(ws, { literature: true });
  test("returns report and archives artifact", async () => {
    const out = text(await t.literature_search.execute("t", { question: "test question about Kneser graphs" }));
    expect(out).toContain("test question about Kneser graphs");
    const artifact = path.join(ws, "literature-1.md");
    expect(fs.existsSync(artifact)).toBe(true);
    expect(fs.readFileSync(artifact, "utf8")).toContain("## Question");
  });
});
