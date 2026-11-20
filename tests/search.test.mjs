import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("excludes unstaged-deleted paths from Git search", async t => {
  const repo = mkdtempSync(join(tmpdir(), "better-files-search-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const root = join(repo, "nested");
  mkdirSync(root);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(repo, "no-global-config") };
  const git = (...args) => execFileSync("git", args, { cwd: repo, env });
  git("init", "-q", "--template=");
  writeFileSync(join(repo, ".gitignore"), "ignored-note.md\n");
  writeFileSync(join(repo, "outside-note.md"), "outside the search folder");
  writeFileSync(join(root, "note.md"), "tracked text");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial fixture");
  unlinkSync(join(root, "note.md"));
  writeFileSync(join(root, "project-notes.md"), "untracked text");
  writeFileSync(join(root, "ignored-note.md"), "ignored text");

  // Run the installed mod's actual search and submit handlers, substituting only
  // the Herdr SDK bindings; Git and the fixture's files are real.
  const events = new Map(), tasks = [];
  const input = { value: () => "note", on: (event, fn) => events.set(event, fn) };
  const cx = { notify() {}, timer: { every() {} }, spawn: fn => tasks.push(fn(cx)) };
  const drain = async () => { while (tasks.length) await tasks.shift(); };
  const file = new URL("../mods/better-files/main.js", import.meta.url);
  const source = readFileSync(file, "utf8").replace(/^import .*;\r?$/gm, "").replace("export default class Files", "class Files");
  const Files = runInNewContext(source + "\nFiles;", {
    View: class {},
    InputState: { new: () => input },
    EditorState: { new: opts => ({ ...opts, release() {} }) },
    exec: async (cmd, args, { cwd, on }) => {
      assert.equal(cmd, "git");
      assert.equal(cwd, root);
      assert.equal(on, "connected-machine");
      const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
      if (result.error) throw result.error;
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    readTextFile: async path => {
      try { return readFileSync(path, "utf8"); }
      catch (err) { if (err.code === "ENOENT") return null; throw err; }
    },
    theme: () => ({}),
    settings: () => ({}),
  });
  const panel = new Files();
  // Suppress unrelated tree refresh and watches. The search is still indexed on
  // input, with the cwd and connected machine from the panel's current context.
  panel.refresh = () => {};
  panel.current = context => context === panel.context;
  panel.init({}, cx);
  panel.root = root;
  panel.on = "connected-machine";
  panel.context = { cwd: root, on: panel.on };

  events.get("change")(null, cx);
  await drain();
  assert.deepEqual(Array.from(panel.results()), ["project-notes.md"]);
  events.get("submit")(null, cx);
  await drain();
  assert.equal(panel.file, "project-notes.md");
  assert.equal(panel.markdown, "untracked text");
  assert.equal(panel.fileError, null);

  // A later refresh includes the same tracked path if the user recreates it.
  writeFileSync(join(root, "note.md"), "recreated text");
  panel.stale = true;
  events.get("change")(null, cx);
  await drain();
  assert.deepEqual(Array.from(panel.results()), ["note.md", "project-notes.md"]);
});
