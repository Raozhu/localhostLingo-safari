import assert from "node:assert/strict";
import { test } from "node:test";
import { chatResponse, loadBackground, upperCaseWords } from "./harness.mjs";

const translate = (background, payload, targetLang = "Simplified Chinese") =>
    background.handle({ action: "translate", payload, targetLang });

test("sends a page's items in one request and reuses duplicates", async () => {
    const background = loadBackground();
    const result = await translate(background, ["Sign in", "Pull requests", "Sign in"]);

    assert.equal(background.requests.length, 1);
    assert.deepEqual(background.requests[0].items, ["Sign in", "Pull requests"]);
    assert.deepEqual(result.translatedArray, ["SIGN IN", "PULL REQUESTS", "SIGN IN"]);
    assert.deepEqual(background.requests[0].body.thinking, { type: "disabled" });
});

test("serves repeated text from the cache without calling the API", async () => {
    const background = loadBackground();
    await translate(background, ["Welcome back"]);
    const result = await translate(background, ["Welcome back"]);

    assert.equal(background.requests.length, 1);
    assert.deepEqual(result.translatedArray, ["WELCOME BACK"]);
});

test("keeps every line and does not cut short translations", async () => {
    const background = loadBackground(items => items.map(item => ({
        "你好，\n明天开会。\n记得带电脑。": "Hello,\nWe meet tomorrow.\nRemember your laptop.",
        "设置默认收货地址": "Set default shipping address"
    })[item]));
    const result = await translate(background, ["你好，\n明天开会。\n记得带电脑。", "设置默认收货地址"], "English");

    assert.deepEqual(result.translatedArray, ["Hello,\nWe meet tomorrow.\nRemember your laptop.", "Set default shipping address"]);
});

test("shows the original when the model explains instead of translating", async () => {
    const background = loadBackground(items => items.map(item => `${item} 不是一个可识别的英文单词，无法进行有意义的翻译。`));
    const result = await translate(background, ["blorptastic"]);

    assert.deepEqual(result.translatedArray, ["blorptastic"]);
});

test("protects code identifiers but leaves inline tags alone", async () => {
    const background = loadBackground();
    await translate(background, ["Open <g1>settings.json</g1> and set useCache<x2/> now"]);

    const [sent] = background.requests[0].items;
    assert.match(sent, /^Open <g1>__NTA__<\/g1> and set __NTB__<x2\/> now$/);
});

test("retries rate limits and reports a balance problem in Chinese", async () => {
    const retried = loadBackground((items, target, call) => (call === 0 ? chatResponse(null, 429) : items.map(upperCaseWords)));
    assert.deepEqual((await translate(retried, ["Retry me"])).translatedArray, ["RETRY ME"]);
    assert.equal(retried.requests.length, 2);

    const broke = loadBackground(() => chatResponse(null, 402));
    assert.equal((await translate(broke, ["No money"])).error, "DeepSeek 账户余额不足");
    assert.equal(broke.requests.length, 1);
});

test("splits a batch when the model returns the wrong number of items", async () => {
    const background = loadBackground(items => (items.length > 1 ? ["only one"] : items.map(upperCaseWords)));
    const result = await translate(background, ["First item", "Second item", "Third item"]);

    assert.deepEqual(result.translatedArray, ["FIRST ITEM", "SECOND ITEM", "THIRD ITEM"]);
});

test("uses the API key saved from the popup", async () => {
    const background = loadBackground(undefined, { apiKey: "sk-from-popup" });
    await translate(background, ["Hello there"]);
    assert.equal(background.requests[0].authorization, "Bearer sk-from-popup");

    background.store.deepseekApiKey = "sk-replaced";
    await translate(background, ["Another sentence"]);
    assert.equal(background.requests[1].authorization, "Bearer sk-replaced");
});

test("asks for an API key before calling DeepSeek", async () => {
    const background = loadBackground(undefined, { apiKey: "" });
    const health = await background.handle({ action: "health" });
    const result = await translate(background, ["Hello there"]);

    assert.equal(health.ok, false);
    assert.equal(health.missingKey, true);
    assert.match(result.error, /还没有设置 DeepSeek API key/);
    assert.equal(background.requests.length, 0);
});
