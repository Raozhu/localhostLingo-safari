// Background service worker for the Safari WebExtension build.
// It talks to the DeepSeek OpenAI-compatible chat completions endpoint.
importScripts("config.js");
const API_BASE_URL = "https://api.deepseek.com";
const API_KEY = DEEPSEEK_API_KEY;
const MODEL = "deepseek-flash";
const MODEL_ALIASES = ["deepseek-flash", "deepseek-v4-pro"];
const MAX_CONCURRENT_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 45000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 800;
// Items are grouped into one chat request; larger groups are split.
const MAX_ITEMS_PER_REQUEST = 20;
const MAX_CHARS_PER_REQUEST = 4000;
const MAX_OUTPUT_TOKENS = 8192;
// Bump when the prompt changes so stale translations are not reused.
const CACHE_VERSION = "v2";
const CACHE_PREFIX = "tc:";
const CACHE_MAX_ENTRIES = 8000;
const CACHE_PRUNE_TO = 6000;
const DEFAULT_TARGET_LANGUAGE = "Simplified Chinese";

const TRANSLATION_SYSTEM_PROMPT = `You are a translation engine, not a chat assistant.
The user sends a JSON object {"target": <language>, "items": [<string>, ...]}. Translate every item into the target language and reply with a JSON object {"translations": [<string>, ...]} that has exactly the same number of items in the same order.
Rules:
- Output only the JSON object. Never explain, comment, apologize, ask for context, or add notes.
- Items are fragments of the same web page in reading order; use neighbouring items as context only.
- Items may contain markup tags such as <g1>...</g1> and <x2/>. Keep every tag exactly once, wrap the translated words that correspond to the original tagged words, and move tags as needed for natural word order. Never add, remove, rename, or nest tags differently.
- Keep placeholders such as __NTA__ unchanged.
- Preserve line breaks inside an item.
- If an item is already in the target language, or cannot be meaningfully translated (gibberish, made-up words, names, codes, unknown slang), return it exactly unchanged.`;

// Replies that explain why the text cannot be translated instead of translating it.
const REFUSAL_PATTERN = /无法(?:翻译|确定|识别|进行|给出|提供)|不是(?:一个)?(?:可识别|常见|标准|有效)?的?(?:英文|英语|中文)?(?:单词|词汇)|没有(?:实际|标准|直接|明确)的?(?:含义|意思|译名|对应)|(?:虚构|自创)的?(?:词|单词)|请(?:提供|确认)|更多(?:的)?上下文|音译为|cannot be translated|can't translate|unable to translate|not a (?:recognized|valid|standard|real|common)|please provide|more context|no (?:direct|standard) translation/i;

let resolvedModel = null;
let activeRequests = 0;
const pendingRequests = [];
const memoryCache = new Map();
let storedCacheEntryCount = null;

const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
const extensionApi = usingBrowserApi ? browser : chrome;

class TranslationError extends Error {
    constructor(message, { retryable = false, malformed = false } = {}) {
        super(message);
        this.retryable = retryable;
        this.malformed = malformed;
    }
}

function withAuthorization(extraHeaders = {}) {
    return {
        ...extraHeaders,
        "Authorization": `Bearer ${API_KEY}`
    };
}

async function runWithConcurrency(task) {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        await new Promise(resolve => pendingRequests.push(resolve));
    }

    activeRequests++;
    try {
        return await task();
    } finally {
        activeRequests--;
        const next = pendingRequests.shift();
        if (next) next();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLanguageName(languageName, fallback) {
    const language = (languageName || "").trim();
    if (!language || language.toLowerCase() === "auto") {
        return fallback;
    }
    return language;
}

function findAvailableModelId(models) {
    return MODEL_ALIASES.find(alias => models.some(model => model.id === alias)) || null;
}

function describeHttpError(status, detail) {
    if (status === 401) return "API key 无效，请检查 config.js";
    if (status === 402) return "DeepSeek 账户余额不足";
    if (status === 429) return "请求太频繁，稍后再试";
    if (status >= 500) return "DeepSeek 服务暂时不可用";
    return detail || `DeepSeek 请求失败（HTTP ${status}）`;
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") {
            throw new TranslationError("DeepSeek 请求超时", { retryable: true });
        }
        throw new TranslationError("网络连接失败，无法访问 DeepSeek", { retryable: true });
    } finally {
        clearTimeout(timer);
    }
}

async function checkHealth() {
    try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/v1/models`, {
            method: "GET",
            headers: withAuthorization()
        });

        if (!response.ok) {
            return { ok: false, error: describeHttpError(response.status) };
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        const availableModel = findAvailableModelId(models);

        if (!availableModel) {
            return { ok: false, error: `DeepSeek 可以连接，但没有 ${MODEL_ALIASES.join(" 或 ")} 模型` };
        }

        resolvedModel = availableModel;
        return { ok: true, model: availableModel };
    } catch (error) {
        return { ok: false, error: error.message || "无法连接 DeepSeek" };
    }
}

function resolveModelId() {
    return resolvedModel || MODEL;
}

// ---------- Non-translatable segment protection ----------

function protectNonTranslatableSegments(text) {
    const segments = [];

    function placeholderName(index) {
        let value = "";
        let current = index;
        do {
            value = String.fromCharCode(65 + (current % 26)) + value;
            current = Math.floor(current / 26) - 1;
        } while (current >= 0);
        return value;
    }

    function addPlaceholder(value) {
        const placeholder = `__NT${placeholderName(segments.length)}__`;
        segments.push({ placeholder, value });
        return placeholder;
    }

    const fileExtensionPattern = [
        "bash", "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css", "csv", "env",
        "fish", "flac", "gif", "go", "gz", "h", "hpp", "html?", "ini", "ipynb",
        "java", "jpe?g", "js", "json", "jsx", "kt", "lock", "lua", "m", "md",
        "mjs", "mm", "mp3", "mp4", "pdf", "php", "pl", "png", "py", "r", "rb",
        "rs", "scss", "sh", "sql", "svg", "swift", "tar", "toml", "ts", "tsx",
        "txt", "wav", "webp", "whl", "xml", "ya?ml", "zip", "zsh"
    ].join("|");

    const patterns = [
        /https?:\/\/[^\s<>"'）)]+/g,
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        /\b[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+(?::[A-Za-z0-9][A-Za-z0-9._.-]*)?\b/g,
        new RegExp(`\\b[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${fileExtensionPattern})\\b`, "gi"),
        /\b[A-Za-z]+[a-z][A-Z][A-Za-z0-9_-]*\b/g,
        /\b(?=[A-Za-z0-9_-]*[A-Z]{2,})(?=[A-Za-z0-9_-]*[-_0-9])[A-Za-z][A-Za-z0-9_-]{2,}\b/g,
        /\b[A-Z][A-Z0-9]{1,12}\b/g,
        /--[A-Za-z0-9][A-Za-z0-9_-]*/g,
        /@[A-Za-z0-9][A-Za-z0-9_-]{1,38}\b/g,
        /\b\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
        /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?/g,
        /\b\d+(?:\.\d+)?%/g,
        /\b\d[\d,]*(?:\.\d+)?\b/g
    ];

    // Markup tags (<g1>, </g1>, <x2/>) are split out so the patterns never touch them.
    const parts = String(text || "").split(/(<\/?[gx]\d+\/?>)/);
    for (const pattern of patterns) {
        for (let index = 0; index < parts.length; index += 2) {
            parts[index] = parts[index].replace(pattern, match => {
                if (/^__NT[A-Z]+__$/.test(match)) return match;
                return addPlaceholder(match);
            });
        }
    }

    return {
        text: parts.join(""),
        segments
    };
}

function restoreNonTranslatableSegments(text, segments) {
    let restored = String(text || "");
    // Restore longer placeholder names first so __NTAB__ is not hit by __NTA__.
    const ordered = [...segments].sort((a, b) => b.placeholder.length - a.placeholder.length);
    for (const { placeholder, value } of ordered) {
        restored = restored.replaceAll(placeholder, () => value);
        const relaxedPlaceholder = placeholder
            .replace("__", "__\\s*")
            .replace("NT", "N\\s*T\\s*")
            .replace(/([A-Z]+)__$/, "$1\\s*__");
        restored = restored.replace(new RegExp(relaxedPlaceholder, "g"), () => value);
    }
    return restored;
}

// ---------- Output checks ----------

function normalizeTextKey(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

function looksLikeRefusal(translation, sourceText) {
    const source = normalizeTextKey(sourceText).toLowerCase();
    const output = normalizeTextKey(translation).toLowerCase();
    if (!REFUSAL_PATTERN.test(output)) return false;
    return output.includes(source) || output.length > Math.max(40, source.length * 3);
}

function isRunaway(translation, sourceText) {
    return String(translation).length > String(sourceText).length * 8 + 200;
}

function finalizeTranslation(rawTranslation, sourceText, protectedSegments) {
    if (typeof rawTranslation !== "string") return sourceText;
    const restored = restoreNonTranslatableSegments(rawTranslation, protectedSegments).trim();
    if (!restored) return sourceText;
    if (looksLikeRefusal(restored, sourceText) || isRunaway(restored, sourceText)) return sourceText;
    return restored;
}

// ---------- Cache ----------

// cyrb53: a small, fast 53-bit string hash.
function hashString(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function cacheKey(text, targetLang) {
    return CACHE_PREFIX + hashString(`${CACHE_VERSION}\u0001${resolveModelId()}\u0001${targetLang}\u0001${text}`);
}

function storageLocal() {
    return extensionApi.storage?.local || null;
}

function storageGet(keys) {
    const storage = storageLocal();
    if (!storage) return Promise.resolve({});
    if (usingBrowserApi) return storage.get(keys);
    return new Promise(resolve => storage.get(keys, resolve));
}

function storageSet(value) {
    const storage = storageLocal();
    if (!storage) return Promise.resolve();
    if (usingBrowserApi) return storage.set(value);
    return new Promise(resolve => storage.set(value, resolve));
}

function storageRemove(keys) {
    const storage = storageLocal();
    if (!storage) return Promise.resolve();
    if (usingBrowserApi) return storage.remove(keys);
    return new Promise(resolve => storage.remove(keys, resolve));
}

async function readCache(texts, targetLang) {
    const found = new Map();
    const keysToRead = [];

    for (const text of texts) {
        const key = cacheKey(text, targetLang);
        const entry = memoryCache.get(key);
        if (entry && entry[0] === text) {
            found.set(text, entry[1]);
        } else {
            keysToRead.push(key);
        }
    }

    if (keysToRead.length === 0) return found;

    try {
        const stored = await storageGet(keysToRead);
        for (const text of texts) {
            const key = cacheKey(text, targetLang);
            const entry = stored?.[key];
            if (Array.isArray(entry) && entry[0] === text) {
                memoryCache.set(key, entry);
                found.set(text, entry[1]);
            }
        }
    } catch (error) {
        console.warn("Translation cache read failed:", error);
    }

    return found;
}

async function writeCache(pairs, targetLang) {
    if (pairs.length === 0) return;

    const now = Date.now();
    const entries = {};
    for (const [text, translation] of pairs) {
        const key = cacheKey(text, targetLang);
        const entry = [text, translation, now];
        memoryCache.set(key, entry);
        entries[key] = entry;
    }

    try {
        await storageSet(entries);
        await pruneCacheIfNeeded(pairs.length);
    } catch (error) {
        console.warn("Translation cache write failed:", error);
    }
}

async function pruneCacheIfNeeded(addedCount) {
    if (storedCacheEntryCount === null) {
        const all = await storageGet(null);
        storedCacheEntryCount = Object.keys(all || {}).filter(key => key.startsWith(CACHE_PREFIX)).length;
    } else {
        storedCacheEntryCount += addedCount;
    }

    if (storedCacheEntryCount <= CACHE_MAX_ENTRIES) return;

    const all = await storageGet(null);
    const cacheEntries = Object.entries(all || {})
        .filter(([key]) => key.startsWith(CACHE_PREFIX))
        .sort((a, b) => (a[1]?.[2] || 0) - (b[1]?.[2] || 0));
    const staleKeys = cacheEntries
        .slice(0, Math.max(0, cacheEntries.length - CACHE_PRUNE_TO))
        .map(([key]) => key);

    await storageRemove(staleKeys);
    staleKeys.forEach(key => memoryCache.delete(key));
    storedCacheEntryCount = cacheEntries.length - staleKeys.length;
}

// ---------- Requests ----------

function estimateMaxTokens(texts) {
    const total = texts.reduce((sum, text) => sum + Math.ceil(text.length * 2) + 24, 64);
    return Math.min(MAX_OUTPUT_TOKENS, total);
}

async function requestTranslations(protectedTexts, targetLang) {
    const body = JSON.stringify({
        model: resolveModelId(),
        messages: [
            {
                role: "system",
                content: TRANSLATION_SYSTEM_PROMPT
            },
            {
                role: "user",
                content: JSON.stringify({ target: targetLang, items: protectedTexts })
            }
        ],
        response_format: { type: "json_object" },
        // DeepSeek thinks by default; reasoning would only add latency and cost here.
        thinking: { type: "disabled" },
        temperature: 0,
        max_tokens: estimateMaxTokens(protectedTexts)
    });

    for (let attempt = 0; ; attempt++) {
        try {
            return await runWithConcurrency(() => sendTranslationRequest(body, protectedTexts.length));
        } catch (error) {
            if (!error.retryable || attempt >= MAX_RETRIES) throw error;
            await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 300);
        }
    }
}

async function sendTranslationRequest(body, expectedCount) {
    const response = await fetchWithTimeout(`${API_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: withAuthorization({ "Content-Type": "application/json" }),
        body
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new TranslationError(describeHttpError(response.status, data?.error?.message), {
            retryable: response.status === 429 || response.status >= 500
        });
    }

    let translations = null;
    try {
        translations = JSON.parse(data?.choices?.[0]?.message?.content)?.translations;
    } catch (error) {
        translations = null;
    }

    if (!Array.isArray(translations) || translations.length !== expectedCount) {
        throw new TranslationError("DeepSeek 返回的格式不对", { malformed: true });
    }

    return translations;
}

function chunkTexts(texts) {
    const chunks = [];
    let current = [];
    let currentChars = 0;

    for (const text of texts) {
        if (current.length > 0 && (current.length >= MAX_ITEMS_PER_REQUEST || currentChars + text.length > MAX_CHARS_PER_REQUEST)) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(text);
        currentChars += text.length;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

// When the model answers with the wrong shape, the group is split in half until single items remain.
async function translateChunk(texts, targetLang) {
    const protectedInputs = texts.map(protectNonTranslatableSegments);

    let translations;
    try {
        translations = await requestTranslations(protectedInputs.map(input => input.text), targetLang);
    } catch (error) {
        if (!error.malformed || texts.length === 1) throw error;
        const middle = Math.ceil(texts.length / 2);
        const [first, second] = await Promise.all([
            translateChunk(texts.slice(0, middle), targetLang),
            translateChunk(texts.slice(middle), targetLang)
        ]);
        return [...first, ...second];
    }

    return texts.map((text, index) => finalizeTranslation(translations[index], text, protectedInputs[index].segments));
}

function normalizePayload(payload) {
    if (!Array.isArray(payload)) return [];

    return payload.map(item => String(typeof item === "string" ? item : item?.text || ""));
}

async function translateTexts(request) {
    const targetLang = normalizeLanguageName(request.targetLang, DEFAULT_TARGET_LANGUAGE);
    const texts = normalizePayload(request.payload);
    const uniqueTexts = [...new Set(texts.filter(text => text.trim()))];

    if (uniqueTexts.length === 0) {
        return { translatedArray: texts };
    }

    const results = await readCache(uniqueTexts, targetLang);
    const missing = uniqueTexts.filter(text => !results.has(text));

    try {
        await Promise.all(chunkTexts(missing).map(async chunk => {
            const translations = await translateChunk(chunk, targetLang);
            const pairs = chunk.map((text, index) => [text, translations[index]]);
            pairs.forEach(([text, translation]) => results.set(text, translation));
            await writeCache(pairs, targetLang);
        }));
    } catch (error) {
        return { error: error.message || "DeepSeek 请求失败" };
    }

    return {
        translatedArray: texts.map(text => results.get(text) ?? text)
    };
}

async function handleMessage(request) {
    if (request?.action === "health") {
        return checkHealth();
    }

    if (request?.action === "translate") {
        return translateTexts(request);
    }

    return undefined;
}

function addRuntimeMessageListener() {
    if (usingBrowserApi) {
        extensionApi.runtime.onMessage.addListener((request) => handleMessage(request));
        return;
    }

    extensionApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
        handleMessage(request)
            .then(sendResponse)
            .catch(error => sendResponse({ error: `扩展后台异常: ${error.message}` }));
        return true;
    });
}

function queryActiveTab() {
    if (usingBrowserApi) {
        return extensionApi.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]);
    }

    return new Promise(resolve => {
        extensionApi.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]));
    });
}

function executeScript(details) {
    if (usingBrowserApi) {
        return extensionApi.scripting.executeScript(details);
    }

    return new Promise((resolve, reject) => {
        extensionApi.scripting.executeScript(details, result => {
            const error = extensionApi.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve(result);
        });
    });
}

async function executeContentActionForActiveTab(action) {
    const tab = await queryActiveTab();
    if (!tab?.id) return;

    const result = await storageGet(["sourceLang", "targetLang", "displayMode"]);
    const config = {
        sourceLang: result.sourceLang || "auto",
        targetLang: result.targetLang || DEFAULT_TARGET_LANGUAGE,
        displayMode: result.displayMode || "replace"
    };

    await executeScript({
        target: { tabId: tab.id },
        func: (nextAction, nextConfig) => {
            const currentDisplay = window.__currentDisplay || "original";
            window.__translationAction = nextAction === "toggle-translation"
                ? (currentDisplay === "original" ? "translate" : "revert")
                : nextAction;
            window.__translationConfig = nextConfig;
        },
        args: [action, config]
    });

    await executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
    });
}

addRuntimeMessageListener();

if (extensionApi.commands?.onCommand) {
    extensionApi.commands.onCommand.addListener(command => {
        if (command === "toggle-translation") {
            executeContentActionForActiveTab("toggle-translation").catch(error => {
                console.error("Failed to toggle translation:", error);
            });
        } else if (command === "translate-selection") {
            executeContentActionForActiveTab("translate-selection").catch(error => {
                console.error("Failed to translate selection:", error);
            });
        }
    });
}
