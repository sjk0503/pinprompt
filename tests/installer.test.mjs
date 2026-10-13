import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/pinprompt.mjs", import.meta.url));
const SRC = fileURLToPath(new URL("../src/pinprompt.js", import.meta.url));

function tmpProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinprompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const count = (s, needle) => s.split(needle).length - 1;

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}
const install = (root, ...extra) => run(["install", root, "--no-grab", ...extra]);
const uninstall = (root) => run(["uninstall", root]);

function nextPkg(root) {
  write(root, "package.json", JSON.stringify({ name: "app", dependencies: { next: "15.0.0", react: "19.0.0" } }, null, 2) + "\n");
}

const GRAB_SCRIPT = `        <Script
          src="//unpkg.com/react-grab/dist/index.global.js"
          crossOrigin="anonymous"
          strategy="beforeInteractive"
        />`;

const LAYOUT_WITH_HEAD = `import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
${GRAB_SCRIPT}
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

const LAYOUT_BODY_ONLY = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
      </body>
    </html>
  );
}
`;

const GITIGNORE = "node_modules\n.next\n";

test("--help prints usage and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /pinprompt install/);
  assert.match(r.stdout, /pinprompt uninstall/);
});

test("Next.js: inserts the block before </head> and reuses an existing Script import", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_WITH_HEAD);
  write(root, ".gitignore", GITIGNORE);

  const r = install(root);
  assert.equal(r.status, 0, r.stderr);

  const layout = read(root, "app/layout.tsx");
  const expectedBlock = [
    "        {/* pinprompt:start */}",
    '        {process.env.NODE_ENV === "development" && (',
    '          <Script src="/__dev/pinprompt.js" strategy="afterInteractive" />',
    "        )}",
    "        {/* pinprompt:end */}",
  ].join("\n");
  assert.ok(layout.includes(`${GRAB_SCRIPT}\n${expectedBlock}\n      </head>`), layout);
  assert.equal(count(layout, 'import Script from "next/script"'), 1);
  assert.ok(!layout.includes("// pinprompt\n"));

  const link = path.join(root, "public/__dev/pinprompt.js");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(SRC));

  const config = JSON.parse(read(root, "public/__dev/pinprompt.config.json"));
  assert.equal(fs.realpathSync(config.root), fs.realpathSync(root));

  assert.equal(
    read(root, ".gitignore"),
    GITIGNORE + "# pinprompt: dev-only UI notes overlay. Never deployed.\npublic/__dev/\n",
  );
});

test("Next.js: with no <head> and no Script import, adds the import and inserts before </body>", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);

  const r = install(root);
  assert.equal(r.status, 0, r.stderr);

  const layout = read(root, "app/layout.tsx");
  assert.ok(layout.startsWith('import Script from "next/script"; // pinprompt\nexport default function'), layout);
  assert.ok(
    layout.includes(
      [
        "        {children}",
        "        {/* pinprompt:start */}",
        '        {process.env.NODE_ENV === "development" && (',
        '          <Script src="/__dev/pinprompt.js" strategy="afterInteractive" />',
        "        )}",
        "        {/* pinprompt:end */}",
        "      </body>",
      ].join("\n"),
    ),
    layout,
  );
  assert.equal(count(layout, "pinprompt:start"), 1);
});

test('Next.js: places the import after a "use client" directive', (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", `"use client";\n\n${LAYOUT_BODY_ONLY}`);

  assert.equal(install(root).status, 0);
  const layout = read(root, "app/layout.tsx");
  assert.ok(layout.startsWith('"use client";\nimport Script from "next/script"; // pinprompt\n\nexport default'), layout);

  assert.equal(uninstall(root).status, 0);
  assert.equal(read(root, "app/layout.tsx"), `"use client";\n\n${LAYOUT_BODY_ONLY}`);
});

test("Next.js: also supports src/app/layout.tsx", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "src/app/layout.tsx", LAYOUT_WITH_HEAD);

  const r = install(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(read(root, "src/app/layout.tsx"), "pinprompt:start"), 1);
  assert.ok(exists(root, "public/__dev/pinprompt.js"));
});

test("running install twice adds the loader and .gitignore entry only once", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);
  write(root, ".gitignore", GITIGNORE);

  assert.equal(install(root).status, 0);
  const afterFirst = read(root, "app/layout.tsx");
  assert.equal(install(root).status, 0);

  const layout = read(root, "app/layout.tsx");
  assert.equal(layout, afterFirst);
  assert.equal(count(layout, "pinprompt:start"), 1);
  assert.equal(count(layout, "pinprompt:end"), 1);
  assert.equal(count(layout, "import Script"), 1);
  assert.equal(count(read(root, ".gitignore"), "public/__dev/"), 1);
});

test("an existing unmarked /__dev/pinprompt.js loader counts as installed", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  const manual = LAYOUT_BODY_ONLY.replace(
    "        {children}\n",
    '        {children}\n        <Script src="/__dev/pinprompt.js" strategy="afterInteractive" />\n',
  );
  write(root, "app/layout.tsx", manual);

  const r = install(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(root, "app/layout.tsx"), manual);
  assert.ok(exists(root, "public/__dev/pinprompt.js"));
});

test("does not append when /public/__dev/ is already in .gitignore", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);
  write(root, ".gitignore", "/public/__dev/\n");

  assert.equal(install(root).status, 0);
  assert.equal(read(root, ".gitignore"), "/public/__dev/\n");
});

test("--copy creates a regular file with the same content as the source, not a link", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);

  const r = install(root, "--copy");
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(root, "public/__dev/pinprompt.js");
  const st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(SRC, "utf8"));
});

test("switching to --copy does not touch the source (src/pinprompt.js)", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);
  const before = fs.readFileSync(SRC, "utf8");

  assert.equal(install(root).status, 0); // link
  assert.equal(install(root, "--copy").status, 0); // link -> copy
  assert.ok(!fs.lstatSync(path.join(root, "public/__dev/pinprompt.js")).isSymbolicLink());
  assert.equal(fs.readFileSync(SRC, "utf8"), before);
});

test("Vite: inserts the block at the top of the entry file", (t) => {
  const root = tmpProject(t);
  write(root, "package.json", JSON.stringify({ name: "v", devDependencies: { vite: "7.0.0" } }) + "\n");
  write(root, "index.html", '<!doctype html>\n<html><body><div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n</body></html>\n');
  const main = 'import React from "react";\nconsole.log("hi");\n';
  write(root, "src/main.tsx", main);

  const r = install(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    read(root, "src/main.tsx"),
    [
      "// pinprompt:start",
      "if (import.meta.env.DEV) {",
      '  const pinprompt = document.createElement("script");',
      '  pinprompt.src = "/__dev/pinprompt.js";',
      "  document.head.appendChild(pinprompt);",
      "}",
      "// pinprompt:end",
      "",
    ].join("\n") + main,
  );

  assert.equal(uninstall(root).status, 0);
  assert.equal(read(root, "src/main.tsx"), main);
});

test("uninstall: restores the layout and .gitignore and leaves the React Grab block alone", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_WITH_HEAD);
  write(root, ".gitignore", GITIGNORE);

  assert.equal(install(root).status, 0);
  assert.notEqual(read(root, "app/layout.tsx"), LAYOUT_WITH_HEAD);

  const r = uninstall(root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(root, "app/layout.tsx"), LAYOUT_WITH_HEAD);
  assert.ok(read(root, "app/layout.tsx").includes("react-grab/dist/index.global.js"));
  assert.equal(read(root, ".gitignore"), GITIGNORE);
  assert.ok(!exists(root, "public/__dev"));
});

test("uninstall: also removes the added import line, restoring the original", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);
  write(root, ".gitignore", GITIGNORE);

  assert.equal(install(root).status, 0);
  assert.equal(uninstall(root).status, 0);
  assert.equal(read(root, "app/layout.tsx"), LAYOUT_BODY_ONLY);
  assert.equal(read(root, ".gitignore"), GITIGNORE);
  assert.ok(!exists(root, "public/__dev"));
});

test("uninstall: keeps public/__dev/ if it contains other files", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);

  assert.equal(install(root).status, 0);
  write(root, "public/__dev/other.txt", "x");
  assert.equal(uninstall(root).status, 0);
  assert.ok(exists(root, "public/__dev/other.txt"));
  assert.ok(!exists(root, "public/__dev/pinprompt.js"));
  assert.ok(!exists(root, "public/__dev/pinprompt.config.json"));
});

test("CRLF files are installed and uninstalled with line endings preserved", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  const crlf = LAYOUT_BODY_ONLY.replace(/\n/g, "\r\n");
  write(root, "app/layout.tsx", crlf);
  write(root, ".gitignore", "node_modules\r\n");

  assert.equal(install(root).status, 0);
  const layout = read(root, "app/layout.tsx");
  assert.ok(!/(?<!\r)\n/.test(layout), "LF must not be mixed in");
  assert.ok(!/(?<!\r)\n/.test(read(root, ".gitignore")));

  assert.equal(uninstall(root).status, 0);
  assert.equal(read(root, "app/layout.tsx"), crlf);
  assert.equal(read(root, ".gitignore"), "node_modules\r\n");
});

test("unsupported project exits 1 and writes nothing", (t) => {
  const root = tmpProject(t);
  write(root, "package.json", '{ "name": "plain" }\n');

  const r = install(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unsupported project/);
  assert.deepEqual(fs.readdirSync(root), ["package.json"]);
});

test("layout with neither </head> nor </body> exits 1 and writes nothing", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  const layout = "export default function RootLayout({ children }) {\n  return children;\n}\n";
  write(root, "app/layout.tsx", layout);

  const r = install(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pinprompt:start/);
  assert.equal(read(root, "app/layout.tsx"), layout);
  assert.ok(!exists(root, "public"));
  assert.ok(!exists(root, ".gitignore"));
});

test("a subfolder project path resolves to the nearest package.json folder as root", (t) => {
  const root = tmpProject(t);
  nextPkg(root);
  write(root, "app/layout.tsx", LAYOUT_BODY_ONLY);

  const r = install(path.join(root, "app"));
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(read(root, "public/__dev/pinprompt.config.json"));
  assert.equal(fs.realpathSync(config.root), fs.realpathSync(root));
});
