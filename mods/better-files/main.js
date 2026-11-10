// Better Files: a lazy file browser for the focused pane's folder, with bounded read-only previews.
// Markdown files render as formatted text, with a header button that flips to the source.
// A header button sorts the tree by name or by modification time. Right-click a row to type its path into the terminal.
// Modified from Herdr's shipped "files" mod (v0.1.15, Apache-2.0): adds the Markdown preview, sorting and path insertion.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const MARKDOWN = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);
const isMarkdown = (path) => Boolean(path) && MARKDOWN.has((path.split(".").pop() ?? "").toLowerCase());
// Sort modes, in the order the header button cycles through them. Folders always come first.
const SORTS = [
  { id: "name", label: "Name A–Z", cmp: (a, b) => a.name.localeCompare(b.name) },
  { id: "name-desc", label: "Name Z–A", cmp: (a, b) => b.name.localeCompare(a.name) },
  { id: "newest", label: "Newest", cmp: (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.name.localeCompare(b.name) },
  { id: "oldest", label: "Oldest", cmp: (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || a.name.localeCompare(b.name) },
];
// A path the way Finder drops one into a terminal, then a space. POSIX shells: characters other than letters,
// digits and _-.,:/@%+= get a backslash; a path with control characters (a newline) uses $'…' quoting instead.
// Windows: native separators inside PowerShell single quotes, with quote characters doubled.
const shellPath = (p, windows) => {
  if (windows) return "'" + p.replace(/\//g, "\\").replace(/['‘’‚‛]/g, "$&$&") + "' ";
  if (/[\x00-\x1f\x7f]/.test(p)) return "$'" + p.replace(/[\\']/g, "\\$&").replace(/[\x00-\x1f\x7f]/g, c => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")) + "' ";
  return p.replace(/[^\p{L}\p{N}_\-.,:\/@%+=]/gu, "\\$&") + " ";
};
// macOS clipboard helper (JXA). "swap <dir> <text>" saves every clipboard item and type to <dir>, then puts
// <text> on the clipboard. "restore <dir>" puts the saved items back, unless something else was copied since,
// and deletes <dir>. A clipboard marked concealed or transient (a password manager's) is not saved to disk.
const CLIP = [
  "ObjC.import('AppKit');",
  "function run(argv) {",
  "  const [mode, dir, text] = argv, pb = $.NSPasteboard.generalPasteboard, fm = $.NSFileManager.defaultManager;",
  "  if (mode === 'swap') {",
  "    const all = pb.types, secret = [];",
  "    for (let k = 0; k < all.count; k++) secret.push(all.objectAtIndex(k).js);",
  "    const skip = secret.includes('org.nspasteboard.ConcealedType') || secret.includes('org.nspasteboard.TransientType');",
  "    const items = skip ? $.NSArray.array : pb.pasteboardItems, saved = [];",
  "    for (let i = 0; i < items.count; i++) {",
  "      const it = items.objectAtIndex(i), types = it.types, kept = [];",
  "      for (let j = 0; j < types.count; j++) {",
  "        const t = types.objectAtIndex(j), data = it.dataForType(t);",
  "        if (!data.isNil() && data.writeToFileAtomically(dir + '/' + i + '_' + j, true)) kept.push(t.js);",
  "      }",
  "      saved.push(kept);",
  "    }",
  "    pb.clearContents;",
  "    pb.setStringForType($(text), $.NSPasteboardTypeString);",
  "    $(JSON.stringify({ items: saved, skip: skip, change: String(pb.changeCount) })).writeToFileAtomicallyEncodingError(dir + '/manifest.json', true, $.NSUTF8StringEncoding, null);",
  "    return 'ok';",
  "  }",
  "  const raw = $.NSString.stringWithContentsOfFileEncodingError(dir + '/manifest.json', $.NSUTF8StringEncoding, null);",
  "  const m = raw.isNil() ? { skip: true } : JSON.parse(raw.js);",
  "  if (!m.skip && String(pb.changeCount) === m.change) {",
  "    const objs = $.NSMutableArray.array;",
  "    m.items.forEach((types, i) => {",
  "      const item = $.NSPasteboardItem.alloc.init;",
  "      types.forEach((t, j) => item.setDataForType($.NSData.dataWithContentsOfFile(dir + '/' + i + '_' + j), $(t)));",
  "      objs.addObject(item);",
  "    });",
  "    pb.clearContents;",
  "    if (Number(objs.count) > 0) pb.writeObjects(objs);",
  "  }",
  "  fm.removeItemAtPathError(dir, null);",
  "  return 'ok';",
  "}",
].join("\n");
// swap: makes a private temporary folder, swaps the clipboard into it and prints the folder's path.
// restore (also run when a swap fails) deletes that folder itself.
const clipSwap = (text) => exec("sh", ["-c", 'd=$(mktemp -d "${TMPDIR:-/tmp}/herdr-better-files.XXXXXX") || exit 1; osascript -l JavaScript -e "$1" swap "$d" "$2" >/dev/null || { osascript -l JavaScript -e "$1" restore "$d" "" >/dev/null; exit 1; }; printf %s "$d"', "clip", CLIP, text]);
const clipRestore = (dir) => exec("sh", ["-c", 'osascript -l JavaScript -e "$1" restore "$2" "" >/dev/null', "clip", CLIP, dir]);
const storedSort = () => { try { return localStorage.getItem("sort"); } catch { return null; } };

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 5001 | ForEach-Object { @{ name=$_.Name; mtime=([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds(); dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  // Lists kind/name pairs (at most 5,001), then a "t" field, then one modification time per entry from a single
  // stat call (GNU stat -c on Linux, BSD stat -f on macOS). If that call fails (a file removed mid-listing), each
  // entry is stat'ed alone and a missing one gets 0. The times are dropped only if their count does not match.
  const script = 'dir=$1; shift; n=0; for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; set -- "$@" "$p"; n=$((n+1)); [ "$n" -gt 5000 ] && break; done; test -d "$dir" || exit 1; printf "t\\0"; [ $# -eq 0 ] && exit 0; if stat -c %Y / >/dev/null 2>&1; then s() { stat -c %Y -- "$@"; }; else s() { stat -f %m -- "$@"; }; fi; if out=$(s "$@" 2>/dev/null); then printf "%s\\n" "$out"; else for p; do s "$p" 2>/dev/null || echo 0; done; fi; exit 0';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  let i = 0;
  for (; i + 1 < fields.length && fields[i] !== "t"; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  const times = fields.slice(i + 1).join("").split("\n").filter(Boolean).map(Number);
  if (times.length === out.length) out.forEach((e, k) => { e.mtime = times[k]; });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.sort = Math.max(0, SORTS.findIndex(s => s.id === storedSort()));
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    // The whole listing (up to 5,000) is kept so that sorting by time sees every entry; `cap` is how many of
    // the sorted entries the tree shows (500 per folder, 5,000 in total).
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.cap, 0);
    entries.cap = Math.max(0, Math.min(PER_FOLDER, TOTAL - used, entries.length));
    this.entries.set(path, entries);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.markdown = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        if (isMarkdown(path)) this.markdown = text.length > 400000 ? text.slice(0, 400000) + "\n\n… (file truncated)" : text;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Right-click a file or folder: type its absolute path into the focused terminal, as a Finder drop would.
  // Herdr pastes from the clipboard, so on macOS the clipboard is saved first and put back afterwards.
  insertPath(path, cx) {
    if (this.inserting) return;
    this.inserting = true;
    // The clipboard is always this computer's; the path is the folder's own (on a connected machine, its path there).
    const platform = window()?.platform, windows = platform === "windows" && !this.on;
    const text = shellPath(`${this.root}/${path}`, windows);
    let saved = null;
    const restore = () => (saved ? clipRestore(saved) : Promise.resolve()).catch(() => {}).finally(() => { this.inserting = false; });
    cx.spawn(async cx => {
      try {
        const r = platform === "macos" ? await clipSwap(text)
          : platform === "windows" ? await exec("powershell", ["-NoProfile", "-Command", "& { param($p) Set-Clipboard -Value $p } '" + text.replace(/['‘’‚‛]/g, "$&$&") + "'"])
          : await exec("sh", ["-c", 'printf %s "$1" | { wl-copy || xclip -selection clipboard; } >/dev/null 2>&1', "copy", text]);
        if (r.code !== 0) throw new Error(r.stderr);
        if (platform === "macos") saved = r.stdout.trim() || null;
        run("terminal.paste");
        // Herdr reads the clipboard when it handles the paste; put the old contents back after that.
        cx.timer.after(400, () => { restore(); });
      } catch { restore(); }
    });
  }

  // A folder's entries in the chosen order, folders first. Cached per loaded list, so a render does not re-sort.
  sorted(list) {
    this.sortCache ??= new WeakMap();
    const hit = this.sortCache.get(list);
    if (hit?.sort === this.sort) return hit.rows;
    const cmp = SORTS[this.sort].cmp;
    const rows = [...list].sort((a, b) => Number(b.dir) - Number(a.dir) || cmp(a, b)).slice(0, list.cap ?? PER_FOLDER);
    this.sortCache.set(list, { sort: this.sort, rows });
    return rows;
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const sorted = this.sorted(this.entries.get(prefix) ?? []);
    for (const entry of sorted) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.insertPath(path, cx); })
        .child(entry.dir ? svg(`mods/better-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/better-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file, el => el.child(div().id("better-files-sort").flex_none().px(8).py(2).rounded(6).cursor_pointer()
          .bg(t.hover).text_size(11).text_color(t.muted)
          .on_click((_e, cx) => {
            this.sort = (this.sort + 1) % SORTS.length;
            try { localStorage.setItem("sort", SORTS[this.sort].id); } catch {}
            cx.notify();
          })
          .child(SORTS[this.sort].label)))
        .when(this.markdown != null, el => el.child(div().id("better-files-mode").flex_none().px(8).py(2).rounded(6).cursor_pointer()
          .bg(t.hover).text_size(11).text_color(t.muted)
          .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
          .child(this.source ? "Preview" : "Source"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(
        this.markdown != null && !this.source
          ? v_flex().id("better-files-preview").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14)
              .child(TextView.markdown(`better-files-${this.file}`, this.markdown).selectable(true))
          : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
