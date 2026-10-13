import { test, expect } from "@playwright/test";

const KEY = "pinprompt:v1";

// ---------- helpers ----------

const hook = (page, name) => page.locator(`[data-pinprompt="${name}"]`);
const pin = (page, index) =>
  index === undefined
    ? hook(page, "pin")
    : page.locator(`[data-pinprompt="pin"][data-index="${index}"]`);

const stored = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), KEY);

const toText = (page) => page.evaluate(() => window.__PINPROMPT__.toText());

/** Type a note into the editor textarea and save with Enter. "\n" is entered as Shift+Enter. */
async function typeNote(page, note) {
  const input = hook(page, "editor-input");
  const lines = note.split("\n");
  await input.fill(lines[0]);
  for (const line of lines.slice(1)) {
    await input.press("Shift+Enter");
    await input.pressSequentially(line);
  }
  await input.press("Enter");
  await expect(input).not.toBeVisible();
}

/** Press +, click the element, then save the note. */
async function addNote(page, selector, note) {
  await hook(page, "add").click();
  await page.locator(selector).click();
  await typeNote(page, note);
}

test.beforeEach(async ({ page }) => {
  // Clear localStorage once per test (guarded per tab via sessionStorage).
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
  await page.goto("index.html");
  await expect(hook(page, "toggle-list")).toBeVisible();
});

// ---------- launcher / API ----------

test("launcher is visible, shows Notes 0, copy disabled when empty", async ({ page }) => {
  await expect(page.locator("#pinprompt-host")).toHaveCount(1);
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  await expect(hook(page, "add")).toBeVisible();
  await expect(hook(page, "add")).toHaveText("+");
  await expect(hook(page, "copy")).toHaveText("Copy");
  await expect(hook(page, "copy")).toBeDisabled();
});

test("global API shape", async ({ page }) => {
  const shape = await page.evaluate(() => {
    const api = window.__PINPROMPT__;
    return {
      version: api.version,
      fns: ["startPick", "stopPick", "list", "toText", "copyAll", "clear", "relativize"].map(
        (k) => typeof api[k],
      ),
      list: api.list(),
      text: api.toText(),
    };
  });
  expect(shape.version).toBe("0.3.0");
  expect(shape.fns).toEqual(Array(7).fill("function"));
  expect(shape.list).toEqual([]);
  expect(shape.text).toBe("");
});

test("double load guard keeps exactly one host", async ({ page }) => {
  await page.addScriptTag({ url: "/src/pinprompt.js" });
  await page.waitForTimeout(200);
  await expect(page.locator("#pinprompt-host")).toHaveCount(1);
  await expect(hook(page, "toggle-list")).toHaveCount(1);
  await expect(hook(page, "add")).toHaveCount(1);
});

// ---------- add flow ----------

test("add flow: pick blocks page handler, editor, save, pin and storage", async ({ page }) => {
  await hook(page, "add").click();
  await expect(hook(page, "add")).toHaveAttribute("aria-pressed", "true");

  await page.locator("#buy").click();
  // The app's own click handler must not run.
  await expect(page.locator("#count")).toHaveText("0");

  const input = hook(page, "editor-input");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "What should change?");
  // Picking an element ends pick mode.
  await expect(hook(page, "add")).not.toHaveAttribute("aria-pressed", "true");

  await input.fill("Change button color");
  await input.press("Enter");

  await expect(input).not.toBeVisible();
  await expect(pin(page)).toHaveCount(1);
  await expect(pin(page, 1)).toBeVisible();
  await expect(pin(page, 1)).toHaveAttribute("data-index", "1");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");
  await expect(hook(page, "copy")).toBeEnabled();
  await expect(page.locator("#count")).toHaveText("0");

  await expect.poll(async () => (await stored(page)).length).toBe(1);
  const [item] = await stored(page);
  expect(item.path).toBe("/demo/index.html");
  expect(item.selector).toBe("#buy");
  expect(item.tag).toBe("button");
  expect(item.text).toBe("Buy");
  expect(item.memo).toBe("Change button color");
  expect(item.source).toBeNull();
  expect(typeof item.id).toBe("string");
  expect(typeof item.createdAt).toBe("number");
});

test("Alt+Shift+P toggles pick mode", async ({ page }) => {
  await page.keyboard.press("Alt+Shift+KeyP");
  await expect(hook(page, "add")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Shift+KeyP");
  await expect(hook(page, "add")).not.toHaveAttribute("aria-pressed", "true");
});

test("Esc in pick mode exits without a note and restores page events", async ({ page }) => {
  await hook(page, "add").click();
  await expect(hook(page, "add")).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  await expect(hook(page, "add")).not.toHaveAttribute("aria-pressed", "true");
  await expect(hook(page, "editor-input")).not.toBeVisible();
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  expect(await stored(page)).toEqual([]);

  // Event blocking is lifted, so the page's own handler works again.
  await page.locator("#buy").click();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(hook(page, "editor-input")).not.toBeVisible();
});

test("pick mode blocks link navigation", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator('a[href="about.html"]').click();
  await expect(hook(page, "editor-input")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/demo/index.html");
  const input = hook(page, "editor-input");
  await input.fill("Link note");
  await input.press("Enter");
  await expect(pin(page, 1)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/demo/index.html");
});

// ---------- editor ----------

test("editor: IME composing Enter does not save", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator("#buy").click();
  const input = hook(page, "editor-input");
  await input.fill("composing input");

  const fire = (init) =>
    input.evaluate((el, init) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
          composed: true,
          ...init,
        }),
      );
    }, init);

  await fire({ isComposing: true, keyCode: 13 });
  await fire({ isComposing: false, keyCode: 229 });
  await page.waitForTimeout(300);

  await expect(input).toBeVisible();
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  expect(await stored(page)).toEqual([]);

  // A real Enter after composition ends saves.
  await input.press("Enter");
  await expect(input).not.toBeVisible();
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  expect((await stored(page))[0].memo).toBe("composing input");
});

test("editor: Shift+Enter inserts a newline instead of saving", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator("#buy").click();
  const input = hook(page, "editor-input");
  await input.fill("line one");
  await input.press("Shift+Enter");
  await input.pressSequentially("line two");
  await expect(input).toHaveValue("line one\nline two");
  await expect(input).toBeVisible();
  await page.waitForTimeout(200);
  expect(await stored(page)).toEqual([]);

  await input.press("Enter");
  await expect(input).not.toBeVisible();
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  expect((await stored(page))[0].memo).toBe("line one\nline two");
});

test("editor: empty or whitespace-only note is not saved", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator("#buy").click();
  const input = hook(page, "editor-input");

  await input.press("Enter");
  await page.waitForTimeout(300);
  expect(await stored(page)).toEqual([]);

  await input.fill("   ");
  await input.press("Enter");
  await page.waitForTimeout(300);
  expect(await stored(page)).toEqual([]);

  await hook(page, "editor-save").click();
  await page.waitForTimeout(300);
  expect(await stored(page)).toEqual([]);
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  await expect(pin(page)).toHaveCount(0);
});

test("editor: cancel button and Esc discard the draft", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator("#buy").click();
  await hook(page, "editor-input").fill("Note to cancel");
  await hook(page, "editor-cancel").click();
  await expect(hook(page, "editor-input")).not.toBeVisible();

  await hook(page, "add").click();
  await page.locator("h1").click();
  await hook(page, "editor-input").fill("Cancel with Esc");
  await hook(page, "editor-input").press("Escape");
  await expect(hook(page, "editor-input")).not.toBeVisible();

  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  expect(await stored(page)).toEqual([]);
  await expect(pin(page)).toHaveCount(0);
});

// ---------- pins ----------

test("pin click opens editor with existing note; edit saves, delete removes", async ({ page }) => {
  await addNote(page, "#buy", "Original note");
  await expect(pin(page, 1)).toBeVisible();

  // edit
  await pin(page, 1).click();
  const input = hook(page, "editor-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("Original note");
  await expect(hook(page, "editor-delete")).toBeVisible();
  await input.fill("Edited note");
  await input.press("Enter");
  await expect(input).not.toBeVisible();
  await expect(pin(page)).toHaveCount(1);
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");
  await expect.poll(async () => (await stored(page))[0]?.memo).toBe("Edited note");

  // delete
  await pin(page, 1).click();
  await expect(input).toHaveValue("Edited note");
  await hook(page, "editor-delete").click();
  await expect(pin(page)).toHaveCount(0);
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  await expect.poll(async () => (await stored(page)).length).toBe(0);
});

test("new note editor has no delete button", async ({ page }) => {
  await hook(page, "add").click();
  await page.locator("#buy").click();
  await expect(hook(page, "editor-input")).toBeVisible();
  await expect(hook(page, "editor-delete")).toHaveCount(0);
});

// ---------- persistence / navigation ----------

test("persists across reload", async ({ page }) => {
  await addNote(page, "#buy", "Survives reload");
  await expect(pin(page, 1)).toBeVisible();
  await page.reload();
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");
  await expect(pin(page, 1)).toBeVisible();
});

test("persists across navigation and pins are per-path", async ({ page }) => {
  await addNote(page, "#buy", "index note");
  await expect(pin(page, 1)).toBeVisible();

  await page.goto("about.html");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");
  await expect(pin(page)).toHaveCount(0);

  await addNote(page, "#intro", "about note");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 2");
  await expect(pin(page, 2)).toBeVisible();
  await expect(pin(page, 1)).not.toBeVisible();

  await page.click('a[href="index.html"]');
  await page.waitForURL("**/demo/index.html");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 2");
  await expect(pin(page, 1)).toBeVisible();
  await expect(pin(page, 2)).not.toBeVisible();
});

test("SPA route change (pushState) hides pins of the old path", async ({ page }) => {
  await addNote(page, "#buy", "SPA test");
  await expect(pin(page, 1)).toBeVisible();

  await page.click("#spa");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/demo/spa-route");
  // #buy is still in the DOM, so the pin can only disappear via the path check.
  await expect(page.locator("#buy")).toBeVisible();
  await expect(pin(page, 1)).not.toBeVisible({ timeout: 1500 });
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");

  // Going back (popstate) brings the pin back.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/demo/index.html");
  await expect(pin(page, 1)).toBeVisible({ timeout: 1500 });
});

test("storage event syncs notes across tabs", async ({ page, context }) => {
  const other = await context.newPage();
  await other.goto("index.html");
  await expect(hook(other, "toggle-list")).toHaveText("Notes 0");

  await addNote(page, "#buy", "Tab sync");
  await expect(hook(other, "toggle-list")).toHaveText("Notes 1");
  await expect(pin(other, 1)).toBeVisible();
});

// ---------- selector ----------

test("selector without id starts at body and ends with nth-of-type", async ({ page }) => {
  await addNote(page, "ul > li:nth-child(2)", "Second item");
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  const [item] = await stored(page);

  expect(item.tag).toBe("li");
  expect(item.text).toBe("Two");
  expect(item.selector).toMatch(/^body( > |$)/);
  expect(item.selector).toMatch(/li:nth-of-type\(2\)$/);
  // Classes are never used.
  expect(item.selector).not.toContain(".");

  const ok = await page.evaluate((sel) => {
    const found = document.querySelectorAll(sel);
    return found.length === 1 && found[0] === document.querySelectorAll("ul > li")[1];
  }, item.selector);
  expect(ok).toBe(true);
});

test("selector uses the element's own unique id", async ({ page }) => {
  await addNote(page, "#count", "Counter");
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  expect((await stored(page))[0].selector).toBe("#count");
});

// ---------- copy format ----------

test("toText without React Grab: path + selector", async ({ page }) => {
  await addNote(page, "#buy", "Overflows on mobile");
  await expect(pin(page, 1)).toBeVisible();
  expect(await toText(page)).toBe('1. /demo/index.html #buy (button "Buy") — Overflows on mobile');
});

test("toText: newline in note becomes ' / ', multiple lines joined with \\n, no trailing newline", async ({
  page,
}) => {
  await addNote(page, "#buy", "line one\nline two");
  await expect(pin(page, 1)).toBeVisible();
  await addNote(page, "#count", "Second note");
  await expect(pin(page, 2)).toBeVisible();

  const text = await toText(page);
  expect(text).toBe(
    [
      '1. /demo/index.html #buy (button "Buy") — line one / line two',
      '2. /demo/index.html #count (span "0") — Second note',
    ].join("\n"),
  );
  expect(text.endsWith("\n")).toBe(false);
});

test("toText with fake React Grab uses source location", async ({ page }) => {
  await page.goto("grab.html");
  await expect(hook(page, "toggle-list")).toBeVisible();
  await addNote(page, "#login", "Overflows the header on mobile");
  await expect(pin(page, 1)).toBeVisible();

  expect(await toText(page)).toBe('1. app/page.tsx:21:11 (a "Log in") — Overflows the header on mobile');

  await expect.poll(async () => (await stored(page)).length).toBe(1);
  const [item] = await stored(page);
  expect(item.source).toEqual({
    filePath: "app/page.tsx",
    line: 21,
    column: 11,
    component: "LandingPage",
  });
});

// ---------- copy button ----------

test("copy button puts exactly toText() on the clipboard and shows a toast", async ({ page }) => {
  await addNote(page, "#buy", "Copy test");
  await addNote(page, "h1", "Bigger title");
  await expect(pin(page, 2)).toBeVisible();

  const expected = await toText(page);
  expect(expected.split("\n")).toHaveLength(2);

  await hook(page, "copy").click();
  await expect(hook(page, "toast")).toHaveText("Copied 2 notes");

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(expected);

  // Copying does not delete notes.
  await expect(hook(page, "toggle-list")).toHaveText("Notes 2");
});

test("toast uses singular for one note", async ({ page }) => {
  await addNote(page, "#buy", "Single note");
  await expect(pin(page, 1)).toBeVisible();
  await hook(page, "copy").click();
  await expect(hook(page, "toast")).toHaveText("Copied 1 note");
});

// ---------- list panel ----------

test("list panel: shows items, empty state, item-delete removes one", async ({ page }) => {
  await hook(page, "toggle-list").click();
  await expect(page.getByText("No notes yet")).toBeVisible();
  await hook(page, "toggle-list").click();

  await addNote(page, "#buy", "First note");
  await addNote(page, "h1", "Second note");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 2");

  await hook(page, "toggle-list").click();
  await expect(hook(page, "item")).toHaveCount(2);
  await expect(hook(page, "item").nth(0)).toContainText("First note");
  await expect(hook(page, "item").nth(0)).toContainText("/demo/index.html");
  await expect(hook(page, "item").nth(1)).toContainText("Second note");

  await hook(page, "item-delete").first().click();
  await expect(hook(page, "item")).toHaveCount(1);
  await expect(hook(page, "item").first()).toContainText("Second note");
  await expect(hook(page, "toggle-list")).toHaveText("Notes 1");
  await expect.poll(async () => (await stored(page)).length).toBe(1);
  // Numbers are reassigned across the whole array.
  await expect(pin(page, 1)).toBeVisible();
  await expect(pin(page)).toHaveCount(1);
});

test("list panel: clear asks confirm; dismiss keeps, accept empties everything", async ({ page }) => {
  await addNote(page, "#buy", "One");
  await addNote(page, "h1", "Two");
  await hook(page, "toggle-list").click();
  await expect(hook(page, "item")).toHaveCount(2);

  // Dismissing keeps everything
  const dialogs = [];
  const onDismiss = (d) => {
    dialogs.push(d.type());
    d.dismiss();
  };
  page.once("dialog", onDismiss);
  await hook(page, "clear").click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toBe("confirm");
  await expect(hook(page, "item")).toHaveCount(2);
  await expect(hook(page, "toggle-list")).toHaveText("Notes 2");

  // Accepting deletes everything
  page.once("dialog", (d) => d.accept());
  await hook(page, "clear").click();
  await expect(hook(page, "toggle-list")).toHaveText("Notes 0");
  await expect(hook(page, "item")).toHaveCount(0);
  await expect(pin(page)).toHaveCount(0);
  await expect(hook(page, "copy")).toBeDisabled();
  await expect(page.getByText("No notes yet")).toBeVisible();
  expect(await stored(page)).toEqual([]);
});
