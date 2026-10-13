# pinprompt spec

Pick an element on a page under development and pin a note to it. Each note stays on screen as a small numbered pin and survives navigation and reloads. One click on "Copy" puts a list of "location — note" lines on the clipboard, ready to paste into a coding agent (Claude Code, etc.).

## Distribution

- A single file, `src/pinprompt.js`. No build step, no dependencies. An IIFE loaded as a plain `<script>`, ES2020.
- Initializes only once, even if loaded twice. If `window.__PINPROMPT__` already exists, it returns immediately.
- Global API (for tests and debugging): `window.__PINPROMPT__ = { version: "0.3.1", startPick(), stopPick(), list(), toText(), copyAll(), clear(), relativize() }`.
  - `list()` returns a copy of the notes array.
  - `toText()` returns the copy-format string described below.
  - `copyAll()` does the same thing as the Copy button and returns a Promise<boolean>.
  - `clear()` deletes everything without a confirm dialog.
  - `relativize(path)` is described under "Relative paths".
- If `window` or `document` is missing, it does nothing.

## Source location

- When a note is saved, `window.__REACT_GRAB__?.getSource(el)` is awaited. If it does not finish within 2 seconds, it is abandoned.
- The returned `{ filePath, lineNumber, columnNumber, componentName }` is stored as `source = { filePath, line, column, component }`.
- If React Grab is missing, fails, or `filePath` is empty, `source = null`. Errors are never thrown to the outside.

## React Grab toolbar

React Grab ships its own floating toolbar (bottom centre) that copies an element immediately, without a note. Next to the pinprompt launcher it reads as a second launcher that "doesn't save notes", so pinprompt hides it.

- On boot, register a React Grab plugin: `window.__REACT_GRAB__.registerPlugin({ name: "pinprompt", theme: { toolbar: { enabled: false } } })`.
- React Grab may load after pinprompt (Vite, or `afterInteractive` ordering). Retry every 250 ms, up to 40 times (10 s), until `registerPlugin` exists.
- If `registerPlugin` is missing (older React Grab) or throws, do nothing. Never throw to the outside.
- Only the toolbar is hidden. `getSource` and React Grab's own hover + Cmd/Ctrl+C copy keep working.

## Data model

Stored as a JSON array under the localStorage key `pinprompt:v1`. One item looks like this:

```
{
  id: string,          // random
  createdAt: number,
  path: string,        // location.pathname at save time
  selector: string,
  tag: string,         // lowercase tag name
  text: string,        // start of the element's innerText, whitespace collapsed to single spaces, max 30 chars (cut and append "…" if longer)
  memo: string,        // the note text
  source: null | { filePath: string, line: number, column: number, component: string }
}
```

- All localStorage reads and writes are wrapped in try/catch. On failure, notes are kept in memory only.
- When another tab changes the data, the `storage` event triggers a re-read and re-render.

## Selector generation

- Use the nearest element (the element itself or an ancestor) that has an id unique in the document as the anchor, and start with `#id` (using `CSS.escape`).
- If there is no anchor, start from `body`.
- From the anchor down to the element, join `tag:nth-of-type(n)` parts with ` > `. If the anchor is the element itself, the selector is just `#id`.
- Class names are not used, because Tailwind classes are long and change often.

## UI

Everything is drawn inside a Shadow DOM.

- Append a host `<div id="pinprompt-host">` to `document.documentElement`. It sits outside body, so React does not touch it.
- `attachShadow({ mode: "open" })`. The host gets `all: initial`. Styles live in a single `<style>` inside the shadow root.
- z-index values are in the 2147483000 range.
- The design is small and neutral: white background, dark text, 1px gray border, 8px rounded corners, system font at 13px. One accent color, orange `#ff5a1f`. No emoji.

### 1) Launcher bar

- Fixed at the bottom left (left 64px, bottom 16px), always visible. It steps aside because the Next.js dev indicator (the "N" button) uses the left 16px spot.
- Three buttons.

| Button | Label | Test hook |
|---|---|---|
| List toggle | `Notes N` | `data-pinprompt="toggle-list"` |
| Add | `+` (aria-label `Add note`) | `data-pinprompt="add"` |
| Copy | `Copy` | `data-pinprompt="copy"` |

- When N is 0, `Copy` is disabled.
- The shortcut Alt+Shift+P toggles pick mode. It is detected with `e.code === "KeyP"` so it works regardless of the active input language or layout. It is ignored while the editor has focus.

### 2) Pick (add) mode

- Entered with `+` or the shortcut. While active, the `+` button shows as pressed (`aria-pressed="true"`) and the cursor is a crosshair.
- The element under the mouse is highlighted with a box (2px orange border, translucent fill, pointer-events: none). A small label `tag "start of text"` is shown above it.
- The element is chosen with `document.elementFromPoint`. The host, `html`, and `body` are excluded.
- While the mode is active, `pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`, `dblclick`, and `contextmenu` are blocked in the window capture phase with `preventDefault()` + `stopImmediatePropagation()`. This stops link navigation and button actions in the app.
  - However, if `event.composedPath()` contains the host, the event is not blocked. Interaction with our own UI passes through.
- Clicking an app element opens the editor for that element and ends pick mode. To add several notes in a row, press `+` again.
- Esc ends pick mode.
- Ending the mode restores everything: the highlight box, the cursor, and event blocking.

### 3) Editor (popover)

- Shown below the target element. If there is not enough room below, it is shown above. It is clamped into the viewport. Width 280px.
- A `textarea` (`data-pinprompt="editor-input"`) is auto-focused, with the placeholder "What should change?".
- Buttons are `Save` (`data-pinprompt="editor-save"`) and `Cancel` (`data-pinprompt="editor-cancel"`). `Delete` (`data-pinprompt="editor-delete"`) is added only when editing an existing note.
- Key behavior
  - Enter saves, Shift+Enter inserts a newline, Esc cancels.
  - **Enter during IME composition (`e.isComposing === true` or `e.keyCode === 229`) does not save.** This is essential for CJK input.
- A note that is empty after trimming whitespace is not saved.
- keydown events inside the editor call `stopPropagation()` so they do not leak into the app's shortcuts.
- Saving a new note creates its pin and closes the editor.

### 4) Pins

- One pin is drawn for every note whose `path` equals the current `location.pathname`.
- A pin is a 20px-diameter circle at the top right corner of the element, containing the number. Hook: `data-pinprompt="pin"`, `data-index="<number>"`. The aria-label is `Note N`.
- Numbers start at 1 and follow the full notes array (creation order). They must match the numbers in the copy format.
- Positions are updated in a requestAnimationFrame loop, only while the current page has at least one note.
  - Element references are cached; if one is not `isConnected`, it is looked up again by selector.
  - If the element cannot be found or has zero size, the pin is hidden.
  - If the element is off screen, the pin is clamped to the viewport edge and made translucent.
- Hovering a pin shows the note text in a tooltip.
- Clicking a pin opens the editor for that note (edit or delete).

### 5) List panel

- Toggled with the `Notes N` button. It opens above the launcher, with a max height of 50vh and scrolling when it overflows.
- Each item (`data-pinprompt="item"`) contains the number, the location (see "Copy format"), the page path, the note text, and a delete button (`data-pinprompt="item-delete"`, label `Delete`). Notes that do not belong to the current page are shown in gray.
- At the bottom there is `Clear all` (`data-pinprompt="clear"`). It asks for confirmation with `window.confirm("Delete all notes?")` before clearing.
- When there are no notes, it shows "No notes yet".

### 6) Copy

- Pressing `Copy` puts the `toText()` result on the clipboard.
- If `navigator.clipboard.writeText` fails, it creates a hidden textarea inside the shadow root and retries with `document.execCommand("copy")`.
- On success, a toast (`data-pinprompt="toast"`) reading "Copied 1 note" or "Copied N notes" is shown next to the launcher for 1.5 seconds.
- Notes are not deleted after copying.

## Copy format (`toText()`)

No header, one note per line, numbered in creation order.

```
1. app/page.tsx:21:11 (a "Log in") — Overflows the header on mobile
2. /pricing #plans > div:nth-of-type(2) > button:nth-of-type(1) (button "Subscribe") — Make the button bigger
```

- Location
  - If source exists: `{filePath cleaned to a relative path}:{line}:{column}` (see "Relative paths" below)
  - If source does not exist: `{path} {selector}`
- The parentheses hold `({tag} "{text}")`. If text is empty, `({tag})`.
- Newlines inside a note are replaced with ` / ` so the note stays on one line.
- The separator is ` — ` (space + em dash + space).
- Lines are joined with `\n` with no trailing newline. With no notes, the result is an empty string.

## Navigation detection

Both the `popstate` event and a 300ms interval comparison of `location.pathname` are used. When the path changes, pins are redrawn. It must work with SPA routing (history.pushState) too.

## Don'ts

- No external network requests, no telemetry.
- Do not add elements to the app DOM other than the host. Do not inject global CSS either.
- Deciding whether this is a production environment is the loader's job (the app's `<Script>` condition). The script does not check NODE_ENV.

## Relative paths

React Grab returns relative paths for server components (like `app/page.tsx`) and absolute paths for `"use client"` components (like `/Users/.../project/app/login/page.tsx`). The copy output and the list panel always show paths relative to the project.

- The project root is obtained in this order.
  1. `window.__PINPROMPT_CONFIG__.root` (a string), set before the script runs
  2. `pinprompt.config.json` in the same folder as the script (`{ "root": "/abs/path" }`). The script URL is captured from `document.currentScript.src` at load time; if unavailable, `/__dev/pinprompt.js` is assumed. Fetched with `fetch(url, { cache: "no-store" })`. Failures or a wrong shape are silently ignored. It is a same-origin request, so it does not conflict with "no external network requests".
- Path cleanup (`relativize`) is applied **at display time** (copy, list), not at save time. This way, even if the config arrives late, notes saved earlier come out as relative paths.
- Cleanup rules (in order)
  1. Remove a `file://` prefix
  2. Remove the prefixes `webpack-internal:///`, `(app-pages-browser)/`, `(rsc)/`, `(ssr)/`
  3. If a root is known and the path starts with `root + "/"`, cut that part off (a trailing `/` on the root is ignored).
  4. Remove a leading `./`
- If the root is unknown, only step 3 is skipped. A path that is already relative is left as is.
- `relativize(path)` is exposed on the global API (for tests).

## Installer (`bin/pinprompt.mjs`)

A Node 20+ script with no dependencies. Exposed through `"bin": { "pinprompt": "bin/pinprompt.mjs" }` in `package.json`. Output is short English.

```
pinprompt install [project-path] [--copy] [--no-grab]
pinprompt uninstall [project-path]
```

If project-path is omitted, the current folder is used. The nearest folder (that folder or an ancestor) containing a `package.json` is used as the project root.

### Supported projects

- **Next.js App Router**: `next` is in the package.json dependencies, and `app/layout.{tsx,jsx,ts,js}` or `src/app/layout.*` exists.
- **Vite**: `vite` is in the dependencies. The entry file is read from `<script type="module" src="...">` in `index.html`; if there is none, `src/main.{tsx,ts,jsx,js}` is searched.
- If neither matches, print what to do by hand (pointing to the README) and exit with code 1.

### Install steps

1. **Check React Grab**: if `react-grab` is not in dependencies/devDependencies, run `npx -y grab@latest init -y --cwd <root>`. If that fails, only warn and continue (it still works with selector locations without React Grab). Skipped with `--no-grab`.
2. **Place the script**: create `<root>/public/__dev/pinprompt.js` as a symlink pointing to the absolute path of this package's `src/pinprompt.js`. If a file or link already exists, replace it. With `--copy`, copy instead of linking.
3. **Config file**: write `{ "root": "<absolute root path>" }` to `<root>/public/__dev/pinprompt.config.json` (with a trailing newline).
4. **.gitignore**: if there is no `public/__dev/` line (a leading `/` counts as the same), append the following two lines. Create the file if it does not exist.
   ```
   # pinprompt: dev-only UI notes overlay. Never deployed.
   public/__dev/
   ```
5. **Insert the loader**: place it between marker comments. If the markers already exist, skip (running several times inserts it only once). Even without markers, if `/__dev/pinprompt.js` is already present, treat it as installed and skip.
   - Next.js: if the layout has no `import Script from "next/script"`, add it. If the file starts with a `"use client"`/`'use client'` directive, put it on the line after that; otherwise at the very top. Append a `// pinprompt` comment to the end of the import line added this way. Put the block right before `</head>`, or right before `</body>` if there is no `</head>`, with indentation equal to that line's indentation plus 2 spaces. If neither exists, print the code to add by hand and exit with code 1.
     ```tsx
     {/* pinprompt:start */}
     {process.env.NODE_ENV === "development" && (
       <Script src="/__dev/pinprompt.js" strategy="afterInteractive" />
     )}
     {/* pinprompt:end */}
     ```
   - Vite: put it at the very top of the entry file (after any directive).
     ```ts
     // pinprompt:start
     if (import.meta.env.DEV) {
       const pinprompt = document.createElement("script");
       pinprompt.src = "/__dev/pinprompt.js";
       document.head.appendChild(pinprompt);
     }
     // pinprompt:end
     ```
6. **Print a summary**: the list of changed files, a one-line usage hint (bottom-left `+` → click an element → write a note → Enter, then `Copy`), and the removal command.

### uninstall

- Remove the block between the markers (including the marker lines). Also remove the import line carrying the `// pinprompt` comment. Other Script imports (React Grab, etc.) are left alone.
- Delete `public/__dev/pinprompt.js` and `pinprompt.config.json`, and delete the `public/__dev/` folder too if it becomes empty.
- Remove the two lines above (comment + `public/__dev/`) from .gitignore if they appear together.
- React Grab is left alone.
- Print the list of changed files.
