import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { webkit } from "playwright";
import { chatResponse, contentScriptSource, loadBackground, upperCaseWords } from "./harness.mjs";

const SPECIAL_REPLIES = {
    // Word order changes around the inline tag.
    "Click <g1>Save</g1> now": "<g1>SAVE</g1> CLICK NOW",
    // The model drops the inline tag, so the paragraph must fall back to node-by-node translation.
    "Broken <g1>tag</g1> case": "BROKEN TAG CASE"
};

let browser;
let page;
let background;
let replyDelayMs = 0;

async function fakeModel(items) {
    if (replyDelayMs) await new Promise(resolve => setTimeout(resolve, replyDelayMs));
    if (items.some(item => item.includes("failme"))) return chatResponse(null, 402);
    return items.map(item => SPECIAL_REPLIES[item] ?? upperCaseWords(item));
}

const PAGE = `<!doctype html><html><body style="font:16px sans-serif">
  <p id="link">Read the <a id="docs" href="/docs">documentation</a> for more details.</p>
  <p id="order">Click <b>Save</b> now</p>
  <p id="broken">Broken <i>tag</i> case</p>
  <p id="code">Run <code>npm install</code> before starting</p>
  <div id="editor" contenteditable="true">Draft text stays untouched</div>
  <textarea id="input">Hello there
Second line here</textarea>
  <div style="height:4000px"></div>
  <p id="far">Far away paragraph text</p>
</body></html>`;

async function runContent(action, config = {}) {
    await page.evaluate(({ action, config }) => {
        window.browser = window.browser || { runtime: { sendMessage: message => window.__backgroundHandle(message) } };
        window.__translationAction = action;
        window.__translationConfig = { sourceLang: "auto", targetLang: "Simplified Chinese", displayMode: "replace", ...config };
    }, { action, config });
    await page.addScriptTag({ content: contentScriptSource });
}

const text = selector => page.locator(selector).evaluate(element => element.textContent);
const waitForText = (selector, expected) => page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.textContent === expected,
    [selector, expected],
    { timeout: 5000 }
);

before(async () => {
    browser = await webkit.launch();
});

after(async () => {
    await browser?.close();
});

beforeEach(async () => {
    replyDelayMs = 0;
    background = loadBackground(fakeModel);
    page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.exposeFunction("__backgroundHandle", message => background.handle(message));
    await page.setContent(PAGE);
});

test("translates a paragraph as one item and keeps its link element", async () => {
    const link = await page.locator("#docs").elementHandle();
    await runContent("translate");
    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");

    assert.ok(background.requests[0].items.includes("Read the <g1>documentation</g1> for more details."));
    assert.equal(await link.evaluate(element => element.isConnected && element.getAttribute("href")), "/docs");
    assert.equal(await text("#docs"), "DOCUMENTATION");
});

test("lets the translation move words around inline tags", async () => {
    await runContent("translate");
    await waitForText("#order", "SAVE CLICK NOW");
    assert.equal(await text("#order b"), "SAVE");
});

test("falls back to node-by-node translation when tags are lost", async () => {
    await runContent("translate");
    await waitForText("#broken", "BROKEN TAG CASE");
    assert.equal(await text("#broken i"), "TAG");
});

test("leaves code and editable areas alone", async () => {
    await runContent("translate");
    await waitForText("#code", "RUN npm install BEFORE STARTING");
    assert.equal(await text("#editor"), "Draft text stays untouched");
});

test("switches back to the exact original markup", async () => {
    const before = await page.locator("body").innerHTML();
    await runContent("translate");
    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");
    await runContent("revert");
    assert.equal(await page.locator("body").innerHTML(), before);

    await runContent("translate");
    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");
});

test("translates far content only when it scrolls into view", async () => {
    await runContent("translate");
    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");
    await page.waitForTimeout(300);
    assert.equal(await text("#far"), "Far away paragraph text");

    await page.locator("#far").scrollIntoViewIfNeeded();
    await waitForText("#far", "FAR AWAY PARAGRAPH TEXT");
});

test("translates content added after the page was translated", async () => {
    await runContent("translate");
    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");
    await page.evaluate(() => {
        const paragraph = document.createElement("p");
        paragraph.id = "late";
        paragraph.textContent = "Freshly loaded comment";
        document.body.prepend(paragraph);
    });
    await waitForText("#late", "FRESHLY LOADED COMMENT");

    await page.evaluate(() => {
        document.querySelector("#late").firstChild.nodeValue = "Edited comment text";
    });
    await waitForText("#late", "EDITED COMMENT TEXT");
});

test("shows the translation under the original in bilingual mode", async () => {
    await runContent("translate", { displayMode: "bilingual" });
    await waitForText("#link .rao-tr-bilingual", "READ THE DOCUMENTATION FOR MORE DETAILS.");
    assert.equal(await text("#docs"), "documentation");

    await runContent("revert");
    // The translation fades out before it is removed.
    await page.waitForFunction(() => document.querySelectorAll(".rao-tr-bilingual").length === 0, null, { timeout: 2000 });
});

test("translates every line of the focused text field", async () => {
    await page.locator("#input").focus();
    await runContent("translate-selection");
    await page.waitForFunction(() => document.querySelector("#input").value === "HELLO THERE\nSECOND LINE HERE", null, { timeout: 5000 });
});

test("tells the user when translation fails", async () => {
    await page.evaluate(() => {
        document.body.innerHTML = "<p>Please failme now</p>";
    });
    await runContent("translate");
    await page.waitForFunction(() => {
        const host = document.querySelector("#rao-tr-toast-host");
        return host?.shadowRoot?.textContent.includes("DeepSeek 账户余额不足");
    }, null, { timeout: 5000 });
});

test("keeps plain-word folder names in GitHub file listings", async () => {
    await page.route("https://github.com/acme/tool", route => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body><table><tr>
            <td><a id="folder" href="/acme/tool/tree/main/examples">examples</a></td>
            <td><a id="commit" href="/acme/tool/commit/1">Update the examples folder</a></td>
        </tr></table></body>`
    }));
    await page.goto("https://github.com/acme/tool");
    await runContent("translate");
    await waitForText("#commit", "UPDATE THE EXAMPLES FOLDER");
    assert.equal(await text("#folder"), "examples");
});

test("shimmers while waiting and leaves no inline styles behind", async () => {
    replyDelayMs = 600;
    await runContent("translate");
    await page.waitForFunction(() => /mask-image/.test(document.querySelector("#link").getAttribute("style") || ""), null, { timeout: 2000 });
    assert.equal(await text("#link"), "Read the documentation for more details.");

    await waitForText("#link", "READ THE DOCUMENTATION FOR MORE DETAILS.");
    await page.waitForFunction(() => !document.querySelector("#link").hasAttribute("style"), null, { timeout: 2000 });
});
