import { test, expect } from "@playwright/test";

const KEY = "pinprompt:v1";
const CONFIG_GLOB = "**/pinprompt.config.json";
const ABS = "/abs/project/app/login/page.tsx:140:320";
const REL = "app/login/page.tsx:140:320";

const hook = (page, name) => page.locator(`[data-pinprompt="${name}"]`);
const toText = (page) => page.evaluate(() => window.__PINPROMPT__.toText());

/** Clear localStorage once per test. */
async function clearOnce(page) {
  await page.addInitScript((key) => {
    try {
      if (!sessionStorage.getItem("__pinprompt_test_cleared")) {
        localStorage.removeItem(key);
        sessionStorage.setItem("__pinprompt_test_cleared", "1");
      }
    } catch (_) {
      /* ignore */
    }
  }, KEY);
}

async function addLoginNote(page, note) {
  await hook(page, "add").click();
  await page.locator("#login").click();
  const input = hook(page, "editor-input");
  await input.fill(note);
  await input.press("Enter");
  await expect(input).not.toBeVisible();
  await expect(hook(page, "pin")).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await clearOnce(page);
});

test("root from __PINPROMPT_CONFIG__ makes copy output relative", async ({ page }) => {
  await page.addInitScript(() => {
    window.__PINPROMPT_CONFIG__ = { root: "/abs/project" };
  });
  // The global config wins, so the config file is never requested.
  let configRequests = 0;
  await page.route(CONFIG_GLOB, (route) => {
    configRequests++;
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("abs.html");
  await addLoginNote(page, "Log in button");
  expect(await toText(page)).toBe(`1. ${REL} (a "Log in") — Log in button`);
  // Stored value stays absolute (cleanup happens at display time only).
  const list = await page.evaluate(() => window.__PINPROMPT__.list());
  expect(list[0].source.filePath).toBe("/abs/project/app/login/page.tsx");
  expect(configRequests).toBe(0);
});

test("root from pinprompt.config.json (same folder as script) applies after fetch", async ({ page }) => {
  let requestedUrl = "";
  await page.route(CONFIG_GLOB, (route) => {
    requestedUrl = route.request().url();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root: "/abs/project" }),
    });
  });
  await page.goto("abs.html");
  await addLoginNote(page, "Config file");
  await expect.poll(() => toText(page)).toBe(`1. ${REL} (a "Log in") — Config file`);
  expect(new URL(requestedUrl).pathname).toBe("/src/pinprompt.config.json");
});

test("list panel shows the relative path too", async ({ page }) => {
  await page.route(CONFIG_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"root":"/abs/project"}' }),
  );
  await page.goto("abs.html");
  await addLoginNote(page, "Panel");
  await hook(page, "toggle-list").click();
  await expect(hook(page, "item").locator(".loc")).toHaveText(REL);
});

test("no config at all (404): absolute path stays and nothing throws", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/404/.test(m.text())) errors.push(m.text());
  });
  await page.route(CONFIG_GLOB, (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("abs.html");
  await addLoginNote(page, "No config");
  await page.waitForTimeout(300);
  expect(await toText(page)).toBe(`1. ${ABS} (a "Log in") — No config`);
  expect(errors).toEqual([]);
});

test("bad config shape or invalid JSON is ignored silently", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(CONFIG_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"root": 42}' }),
  );
  await page.goto("abs.html");
  await addLoginNote(page, "Odd config");
  await page.waitForTimeout(300);
  expect(await toText(page)).toBe(`1. ${ABS} (a "Log in") — Odd config`);

  await page.unroute(CONFIG_GLOB);
  await page.route(CONFIG_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "<html>nope" }),
  );
  await page.reload();
  await expect(hook(page, "toggle-list")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await toText(page)).toBe(`1. ${ABS} (a "Log in") — Odd config`);
  expect(errors).toEqual([]);
});

test("relativize unit cases", async ({ page }) => {
  await page.addInitScript(() => {
    window.__PINPROMPT_CONFIG__ = { root: "/abs/project" };
  });
  await page.goto("abs.html");
  const out = await page.evaluate(() => {
    const r = window.__PINPROMPT__.relativize;
    return {
      file: r("file:///abs/project/app/a.tsx"),
      webpack: r("webpack-internal:///(app-pages-browser)/./app/b.tsx"),
      rsc: r("(rsc)/./app/rsc.tsx"),
      ssr: r("(ssr)/app/ssr.tsx"),
      dot: r("./app/c.tsx"),
      already: r("app/page.tsx"),
      outside: r("/other/place/app/d.tsx"),
      sibling: r("/abs/project-two/app/e.tsx"),
      webpackAbs: r("webpack-internal:///(app-pages-browser)//abs/project/app/f.tsx"),
    };
  });
  expect(out).toEqual({
    file: "app/a.tsx",
    webpack: "app/b.tsx",
    rsc: "app/rsc.tsx",
    ssr: "app/ssr.tsx",
    dot: "app/c.tsx",
    already: "app/page.tsx",
    outside: "/other/place/app/d.tsx",
    sibling: "/abs/project-two/app/e.tsx",
    webpackAbs: "app/f.tsx",
  });
});

test("relativize ignores a trailing slash on root", async ({ page }) => {
  await page.addInitScript(() => {
    window.__PINPROMPT_CONFIG__ = { root: "/abs/project/" };
  });
  await page.goto("abs.html");
  const out = await page.evaluate(() => window.__PINPROMPT__.relativize("/abs/project/app/a.tsx"));
  expect(out).toBe("app/a.tsx");
});

test("relativize without a known root only strips prefixes", async ({ page }) => {
  await page.route(CONFIG_GLOB, (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("abs.html");
  const out = await page.evaluate(() => {
    const r = window.__PINPROMPT__.relativize;
    return [r("/abs/project/app/a.tsx"), r("file:///abs/project/app/a.tsx"), r("./app/b.tsx")];
  });
  expect(out).toEqual(["/abs/project/app/a.tsx", "/abs/project/app/a.tsx", "app/b.tsx"]);
});

test("note saved before the config arrives copies as relative afterwards", async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route(CONFIG_GLOB, async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ root: "/abs/project" }),
    });
  });
  await page.goto("abs.html");
  await addLoginNote(page, "Arrives late");
  // Config has not arrived yet, so the path is still absolute.
  expect(await toText(page)).toBe(`1. ${ABS} (a "Log in") — Arrives late`);
  await hook(page, "toggle-list").click();
  await expect(hook(page, "item").locator(".loc")).toHaveText(ABS);

  release();
  await expect.poll(() => toText(page)).toBe(`1. ${REL} (a "Log in") — Arrives late`);
  // The already-open list panel re-renders too.
  await expect(hook(page, "item").locator(".loc")).toHaveText(REL);
});
