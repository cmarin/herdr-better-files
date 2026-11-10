# Better Files for Herdr

A [Herdr](https://herdr.dev) desktop mod: the Files panel, with three additions.

- **Markdown that renders.** Click a `.md` file and it opens as a formatted document. A **Source** button in the header shows the raw text, and **Preview** switches back.
- **Sorting.** A button in the header cycles the tree through **Name A–Z**, **Name Z–A**, **Newest** and **Oldest** (by modification time). Folders stay on top. The choice is remembered.
- **Right-click to insert a path.** Right-click a file or folder and its absolute path is typed into the focused terminal, escaped the same as a Finder drop (`/a/my\ notes.md `), without pressing Enter. On macOS your clipboard is saved first and put back after.

All other files open as before.

![Better Files](preview.png)

## Install

Ask the agent in your Herdr window:

> Add the mod at github.com/cmarin/herdr-better-files

Or do it by hand:

1. Copy `mods/better-files/` to `~/.config/herdr-app/mods/better-files/`.
2. Clone your layout, because Herdr's own layouts are read-only:
   ```sh
   herdr-app do layout.clone '{"name":"main","as":"main-better-files"}'
   ```
3. In `~/.config/herdr-app/layouts/main-better-files.json`, find `"mod": "files"` and change it to `"mod": "better-files"`.
4. Check it:
   ```sh
   herdr-app check ~/.config/herdr-app/mods/better-files
   ```
5. Click **Files** at the top right of the window.

To undo, switch back to the `main` layout from the command palette.

## What it does and does not do

- It reads files in the focused pane's folder, and runs `sh`, `stat` and `git` (and `powershell` on Windows) to list folders, read modification times and show git marks, the same as Herdr's own Files panel.
- Right-click runs Herdr's `terminal.paste` command. Before that, it puts the path on the clipboard: on macOS it runs `osascript` to save and restore the clipboard, on Linux `wl-copy` or `xclip` (one must be installed), and on Windows `Set-Clipboard`. On Linux and Windows the path stays on the clipboard.
- On macOS the saved clipboard is kept in a private temporary folder (`$TMPDIR/herdr-better-files.XXXXXX`) for about half a second, then deleted. A clipboard that a password manager marks as concealed or transient is never written to disk; in that case the path stays on the clipboard.
- It does not reach the network and does not write to your project.

`RECIPE.md` describes the mod in full, so that an agent can rebuild it from scratch.

## License

Apache-2.0. This mod is a modified copy of Herdr's shipped `files` mod (version 0.1.15, Apache-2.0, © Herdr). The changes: a rendered Markdown preview with a Source/Preview toggle, a sort button, and right-click path insertion. See `LICENSE`.
