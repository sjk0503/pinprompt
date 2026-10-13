#!/usr/bin/env node
// pinprompt installer. Node 20+, no dependencies. See SPEC.md (installer section) for the spec.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC_URL = new URL("../src/pinprompt.js", import.meta.url);

const START = "pinprompt:start";
const END = "pinprompt:end";
const LOADER_PATH = "/__dev/pinprompt.js";
const GITIGNORE_COMMENT = "# pinprompt: dev-only UI notes overlay. Never deployed.";
const GITIGNORE_ENTRY = "public/__dev/";

const USAGE = `pinprompt - install a dev-only UI notes overlay into a web project.

Usage
  pinprompt install [project-path] [--copy] [--no-grab]
  pinprompt uninstall [project-path]

Options
  --copy      Copy pinprompt.js instead of symlinking it
  --no-grab   Skip the React Grab setup step
  -h, --help  Show this help

If project-path is omitted, the current directory is used. The closest
folder with a package.json (that folder or a parent) is the project root.
Supported: Next.js App Router, Vite`;

class UserError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

// ---------- file helpers ----------

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

const rel = (root, p) => path.relative(root, p).split(path.sep).join("/") || ".";

const detectEol = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

function findRoot(dirArg) {
  let dir = path.resolve(dirArg ?? process.cwd());
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new UserError(`Directory not found: ${dir}`);
  }
  if (!st.isDirectory()) throw new UserError(`Not a directory: ${dir}`);
  dir = fs.realpathSync(dir);
  for (;;) {
    if (isFile(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new UserError(`No folder with a package.json found (started from: ${dirArg ?? process.cwd()})`);
    }
    dir = parent;
  }
}

function readPkg(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (e) {
    throw new UserError(`Could not read package.json: ${e.message}`);
  }
}

// ---------- project detection ----------

const EXTS = ["tsx", "jsx", "ts", "js"];

function nextLayouts(root) {
  const found = [];
  for (const base of ["app", "src/app"]) {
    for (const ext of EXTS) {
      const f = path.join(root, base, `layout.${ext}`);
      if (isFile(f)) found.push(f);
    }
  }
  return found;
}

function viteEntries(root) {
  const found = [];
  const htmlPath = path.join(root, "index.html");
  if (isFile(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf8");
    for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
      if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
      const m = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!m || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(m[1])) continue;
      const clean = m[1].split(/[?#]/)[0].replace(/^\/+/, "");
      const f = path.join(root, clean);
      if (/\.(?:[cm]?[jt]sx?)$/.test(f) && isFile(f)) found.push(f);
    }
  }
  for (const ext of EXTS) {
    const f = path.join(root, "src", `main.${ext}`);
    if (isFile(f)) found.push(f);
  }
  return [...new Set(found)];
}

function detectProject(root, pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) {
    const [file] = nextLayouts(root);
    if (file) return { kind: "next", file };
  }
  if (deps.vite) {
    const [file] = viteEntries(root);
    if (file) return { kind: "vite", file };
    throw new UserError(
      "Vite entry file not found (<script type=\"module\" src> in index.html, or src/main.*).",
      manualInstructions({ vite: true }),
    );
  }
  throw new UserError(
    "Unsupported project (only Next.js App Router and Vite are supported).",
    manualInstructions({}),
  );
}

// ---------- loader code ----------

const nextBlockLines = (name) => [
  `{/* ${START} */}`,
  `{process.env.NODE_ENV === "development" && (`,
  `  <${name} src="${LOADER_PATH}" strategy="afterInteractive" />`,
  `)}`,
  `{/* ${END} */}`,
];

const viteBlockLines = () => [
  `// ${START}`,
  `if (import.meta.env.DEV) {`,
  `  const pinprompt = document.createElement("script");`,
  `  pinprompt.src = "${LOADER_PATH}";`,
  `  document.head.appendChild(pinprompt);`,
  `}`,
  `// ${END}`,
];

function manualInstructions({ next, vite }) {
  const out = [
    "To install manually (see 'Manual install' in README.md):",
    `  1. Copy or symlink ${fileURLToPath(SRC_URL)} to <project>/public/__dev/pinprompt.js.`,
    `  2. Write { "root": "<absolute project path>" } to <project>/public/__dev/pinprompt.config.json.`,
    `  3. Add public/__dev/ to .gitignore.`,
    `  4. Load ${LOADER_PATH} in development only.`,
  ];
  if (next) {
    out.push(
      "",
      'Add import Script from "next/script"; to the layout and put this inside <head> or <body>:',
      ...nextBlockLines("Script").map((l) => "  " + l),
    );
  } else if (vite) {
    out.push("", "Put this at the top of the entry file:", ...viteBlockLines().map((l) => "  " + l));
  } else {
    out.push(
      "",
      "For Next.js (App Router), put this in the layout:",
      '  import Script from "next/script";',
      ...nextBlockLines("Script").map((l) => "  " + l),
      "",
      "For Vite, put this at the top of the entry file:",
      ...viteBlockLines().map((l) => "  " + l),
    );
  }
  return out.join("\n");
}

// After leading directives like "use client", otherwise at the top (after a BOM).
const DIRECTIVE_RE = /^﻿?(?:[ \t]*(["'])use [^"'\r\n]+\1;?[ \t]*\r?\n)+/;

function insertAtTop(s, text, eol) {
  const m = s.match(DIRECTIVE_RE);
  const pos = m ? m[0].length : s.startsWith("﻿") ? 1 : 0;
  return s.slice(0, pos) + text.join(eol) + eol + s.slice(pos);
}

function insertBlockBefore(s, idx, lines, eol) {
  const lineStart = idx === 0 ? 0 : s.lastIndexOf("\n", idx - 1) + 1;
  const prefix = s.slice(lineStart, idx);
  const indent = prefix.match(/^[ \t]*/)[0];
  const body = lines.map((l) => indent + "  " + l).join(eol);
  if (/^[ \t]*$/.test(prefix)) {
    return s.slice(0, lineStart) + body + eol + s.slice(lineStart);
  }
  // If other code precedes the tag on its line, start a new line.
  return s.slice(0, idx) + eol + body + eol + indent + s.slice(idx);
}

const isInstalled = (s) => s.includes(START) || s.includes(LOADER_PATH);

const SCRIPT_IMPORT_RE = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*["']next\/script["']/;

// Compute the result without touching the file: { installed: true } or { text }.
function planLoader(project) {
  const s = fs.readFileSync(project.file, "utf8");
  if (isInstalled(s)) return { installed: true };
  const eol = detectEol(s);

  if (project.kind === "vite") {
    return { text: insertAtTop(s, viteBlockLines(), eol) };
  }

  const existing = s.match(SCRIPT_IMPORT_RE);
  const name = existing ? existing[1] : "Script";
  let tagIdx = s.indexOf("</head>");
  if (tagIdx === -1) tagIdx = s.indexOf("</body>");
  if (tagIdx === -1) {
    throw new UserError(
      `Could not find </head> or </body> in ${path.basename(project.file)}; cannot insert automatically.`,
      manualInstructions({ next: true }),
    );
  }
  let text = insertBlockBefore(s, tagIdx, nextBlockLines(name), eol);
  if (!existing) {
    text = insertAtTop(text, [`import Script from "next/script"; // pinprompt`], eol);
  }
  return { text };
}

// ---------- install ----------

function runGrab(root) {
  const res = spawnSync("npx", ["-y", "grab@latest", "init", "-y", "--cwd", root], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return !res.error && res.status === 0;
}

function placeScript(dest, copy, srcPath) {
  const st = lstatOrNull(dest);
  if (!copy) {
    if (st?.isSymbolicLink()) {
      const cur = path.resolve(path.dirname(dest), fs.readlinkSync(dest));
      if (cur === srcPath) return { changed: false, mode: "link" };
    }
    if (st) fs.rmSync(dest, { force: true });
    try {
      fs.symlinkSync(srcPath, dest);
      return { changed: true, mode: "link" };
    } catch (e) {
      console.warn(`Warning: could not create a symlink, copying instead (${e.code ?? e.message}).`);
    }
  } else if (st?.isFile() && fs.readFileSync(dest).equals(fs.readFileSync(srcPath))) {
    return { changed: false, mode: "copy" };
  }
  // dest may be a link to srcPath, so always remove it before writing.
  if (lstatOrNull(dest)) fs.rmSync(dest, { force: true });
  fs.copyFileSync(srcPath, dest);
  return { changed: true, mode: "copy" };
}

function writeIfChanged(file, text) {
  if (isFile(file) && fs.readFileSync(file, "utf8") === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

const isDevEntry = (line) => {
  const t = line.trim().replace(/^\//, "");
  return t === GITIGNORE_ENTRY || t === GITIGNORE_ENTRY.slice(0, -1);
};

function addGitignore(root) {
  const file = path.join(root, ".gitignore");
  const exists = isFile(file);
  const s = exists ? fs.readFileSync(file, "utf8") : "";
  if (s.split(/\r?\n/).some(isDevEntry)) return false;
  const eol = detectEol(s);
  const lead = s === "" || s.endsWith("\n") ? "" : eol;
  fs.writeFileSync(file, s + lead + GITIGNORE_COMMENT + eol + GITIGNORE_ENTRY + eol);
  return true;
}

function install(opts) {
  const root = findRoot(opts.dir);
  const pkg = readPkg(root);
  const project = detectProject(root, pkg);
  planLoader(project); // Fail now, before anything is written.

  const srcPath = (() => {
    try {
      return fs.realpathSync(fileURLToPath(SRC_URL));
    } catch {
      throw new UserError(`pinprompt.js source not found: ${fileURLToPath(SRC_URL)}`);
    }
  })();

  console.log(`pinprompt install: ${root} (${project.kind === "next" ? "Next.js App Router" : "Vite"})`);
  const changed = [];

  // 1) React Grab
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (opts.noGrab) {
    console.log("React Grab: skipped (--no-grab)");
  } else if (deps["react-grab"]) {
    console.log("React Grab: already installed.");
  } else {
    console.log("React Grab: installing (npx -y grab@latest init -y)");
    if (runGrab(root)) {
      console.log("React Grab: installed (see the output above for changed files).");
    } else {
      console.warn("Warning: React Grab install failed. Notes will use selectors instead of source locations. Continuing.");
    }
  }

  // 2) Place the script
  const devDir = path.join(root, "public", "__dev");
  fs.mkdirSync(devDir, { recursive: true });
  const scriptDest = path.join(devDir, "pinprompt.js");
  const placed = placeScript(scriptDest, opts.copy, srcPath);
  if (placed.changed) {
    changed.push(
      placed.mode === "link"
        ? `public/__dev/pinprompt.js (symlink -> ${srcPath})`
        : "public/__dev/pinprompt.js (copy)",
    );
  }

  // 3) Config file
  const configText = `{ "root": ${JSON.stringify(root)} }\n`;
  if (writeIfChanged(path.join(devDir, "pinprompt.config.json"), configText)) {
    changed.push("public/__dev/pinprompt.config.json");
  }

  // 4) .gitignore
  if (addGitignore(root)) changed.push(".gitignore");

  // 5) Insert the loader. React Grab may have edited the same file, so recompute.
  const plan = planLoader(project);
  if (plan.installed) {
    console.log(`Loader: already present (${rel(root, project.file)})`);
  } else {
    fs.writeFileSync(project.file, plan.text);
    changed.push(rel(root, project.file));
  }

  if (changed.length) {
    console.log("\nChanged files:");
    for (const c of changed) console.log(`  - ${c}`);
  } else {
    console.log("\nNo files changed (already installed).");
  }
  const target = opts.dir ? ` ${opts.dir}` : "";
  console.log("\nUse: start your dev server -> click + (bottom-left) -> click an element -> type a note, Enter -> Copy");
  console.log(`Remove: pinprompt uninstall${target}`);
}

// ---------- uninstall ----------

const BLOCK_RE = /^[^\r\n]*pinprompt:start[^\r\n]*\r?\n[\s\S]*?^[^\r\n]*pinprompt:end[^\r\n]*(?:\r?\n|$)/m;
const MARKED_IMPORT_RE = /^[ \t]*import\b[^\r\n]*["']next\/script["'][^\r\n]*\/\/ pinprompt[ \t]*(?:\r?\n|$)/m;

function removeLoader(s) {
  return s.replace(BLOCK_RE, "").replace(MARKED_IMPORT_RE, "");
}

function removeGitignore(root) {
  const file = path.join(root, ".gitignore");
  if (!isFile(file)) return false;
  const s = fs.readFileSync(file, "utf8");
  const lines = s.split(/(?<=\n)/); // keep each line ending attached to its line.
  const text = (l) => l.replace(/\r?\n$/, "");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (text(lines[i]).trim() === GITIGNORE_COMMENT && isDevEntry(text(lines[i + 1]))) {
      lines.splice(i, 2);
      fs.writeFileSync(file, lines.join(""));
      return true;
    }
  }
  return false;
}

function uninstall(opts) {
  const root = findRoot(opts.dir);
  const changed = [];

  const files = new Set([...nextLayouts(root), ...viteEntries(root)]);
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    const out = removeLoader(s);
    if (out !== s) {
      fs.writeFileSync(f, out);
      changed.push(rel(root, f));
    }
  }

  const devDir = path.join(root, "public", "__dev");
  for (const name of ["pinprompt.js", "pinprompt.config.json"]) {
    const p = path.join(devDir, name);
    if (lstatOrNull(p)) {
      fs.rmSync(p, { force: true });
      changed.push(`public/__dev/${name} (deleted)`);
    }
  }
  try {
    if (fs.readdirSync(devDir).length === 0) {
      fs.rmdirSync(devDir);
      changed.push("public/__dev/ (empty folder deleted)");
    }
  } catch {
    // No folder, nothing to do.
  }

  if (removeGitignore(root)) changed.push(".gitignore");

  console.log(`pinprompt uninstall: ${root}`);
  if (changed.length) {
    console.log("\nChanged files:");
    for (const c of changed) console.log(`  - ${c}`);
    console.log("\nReact Grab is left in place.");
  } else {
    console.log("\nNothing to remove (pinprompt is not installed).");
  }
}

// ---------- entry point ----------

function parseArgs(argv) {
  const opts = { command: null, dir: null, copy: false, noGrab: false, help: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--copy") opts.copy = true;
    else if (a === "--no-grab") opts.noGrab = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new UserError(`Unknown option: ${a}`, USAGE);
    else positional.push(a);
  }
  [opts.command, opts.dir] = positional;
  if (positional.length > 2) throw new UserError(`Too many arguments: ${positional.slice(2).join(" ")}`, USAGE);
  return opts;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || opts.command === "help") {
      console.log(USAGE);
      return;
    }
    if (opts.command === "install") install(opts);
    else if (opts.command === "uninstall") uninstall(opts);
    else if (!opts.command) throw new UserError("Missing command.", USAGE);
    else throw new UserError(`Unknown command: ${opts.command}`, USAGE);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    console.error(`Error: ${e.message}`);
    if (e.detail) console.error(`\n${e.detail}`);
    process.exitCode = 1;
  }
}

main();
