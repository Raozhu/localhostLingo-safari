// Background service worker for the Safari WebExtension build.
// It talks to the DeepSeek OpenAI-compatible chat completions endpoint.
importScripts("config.js");
const OMLX_BASE_URL = "https://api.deepseek.com";
const OMLX_API_KEY = DEEPSEEK_API_KEY;
const OMLX_MODEL = "deepseek-flash";
const OMLX_MODEL_ALIASES = ["deepseek-flash", "deepseek-v4-pro"];
const OMLX_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_SOURCE_LANGUAGE = "English";
const DEFAULT_TARGET_LANGUAGE = "Simplified Chinese";
const TRANSLATION_SYSTEM_PROMPT = "You are a translation engine, not a chat assistant. Output only the translated text. Never explain, comment, apologize, ask for context, or add notes. If the text cannot be meaningfully translated (gibberish, made-up words, names, codes, unknown slang), output it exactly unchanged.";
// Replies that explain why the text cannot be translated instead of translating it.
const REFUSAL_PATTERN = /无法(?:翻译|确定|识别|进行|给出|提供)|不是(?:一个)?(?:可识别|常见|标准|有效)?的?(?:英文|英语|中文)?(?:单词|词汇)|没有(?:实际|标准|直接|明确)的?(?:含义|意思|译名|对应)|(?:虚构|自创)的?(?:词|单词)|请(?:提供|确认)|更多(?:的)?上下文|音译为|cannot be translated|can't translate|unable to translate|not a (?:recognized|valid|standard|real|common)|please provide|more context|no (?:direct|standard) translation/i;
let resolvedOmlxModel = null;
let activeOmlxRequests = 0;
const pendingOmlxRequests = [];

const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
const extensionApi = usingBrowserApi ? browser : chrome;

function withAuthorization(extraHeaders = {}) {
    return {
        ...extraHeaders,
        "Authorization": `Bearer ${OMLX_API_KEY}`
    };
}

async function runWithOmlxConcurrency(task) {
    if (activeOmlxRequests >= OMLX_MAX_CONCURRENT_REQUESTS) {
        await new Promise(resolve => pendingOmlxRequests.push(resolve));
    }

    activeOmlxRequests++;
    try {
        return await task();
    } finally {
        activeOmlxRequests--;
        const next = pendingOmlxRequests.shift();
        if (next) next();
    }
}

function normalizeLanguageName(languageName, fallback) {
    const language = (languageName || "").trim();
    if (!language || language.toLowerCase() === "auto") {
        return fallback;
    }
    return language;
}

function normalizeEnglishPromptLanguageName(languageName) {
    const language = normalizeLanguageName(languageName, DEFAULT_TARGET_LANGUAGE);
    if (language === "Simplified Chinese") return "Chinese";
    return language;
}

function normalizeChinesePromptLanguageName(languageName) {
    const language = normalizeLanguageName(languageName, DEFAULT_TARGET_LANGUAGE);
    if (language === "Simplified Chinese" || language === "Chinese") return "中文";
    if (language === "Traditional Chinese") return "繁体中文";
    if (language === "English") return "英语";
    if (language === "Japanese") return "日语";
    if (language === "Korean") return "韩语";
    if (language === "French") return "法语";
    if (language === "German") return "德语";
    if (language === "Spanish") return "西班牙语";
    if (language === "Portuguese") return "葡萄牙语";
    if (language === "Russian") return "俄语";
    if (language === "Arabic") return "阿拉伯语";
    return language;
}

function isChineseLanguage(languageName) {
    return normalizeLanguageName(languageName, "").includes("Chinese");
}

function findAvailableModelId(models) {
    return OMLX_MODEL_ALIASES.find(alias => models.some(model => model.id === alias)) || null;
}

async function resolveOmlxModelId() {
    if (resolvedOmlxModel) return resolvedOmlxModel;

    try {
        const response = await fetch(`${OMLX_BASE_URL}/v1/models`, {
            method: "GET",
            headers: withAuthorization()
        });

        if (!response.ok) return OMLX_MODEL;

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        resolvedOmlxModel = findAvailableModelId(models) || OMLX_MODEL;
        return resolvedOmlxModel;
    } catch (error) {
        return OMLX_MODEL;
    }
}

function normalizeTextKey(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeDedupeKey(item, targetLang) {
    return [
        normalizeLanguageName(item.sourceLang, DEFAULT_SOURCE_LANGUAGE).toLowerCase(),
        normalizeLanguageName(targetLang, DEFAULT_TARGET_LANGUAGE).toLowerCase(),
        normalizeTextKey(item.text).toLowerCase()
    ].join("\u0001");
}

function buildTranslationPrompt(sourceLang, targetLang, sentence) {
    if (isChineseLanguage(sourceLang)) {
        const promptTargetLang = normalizeChinesePromptLanguageName(targetLang);
        if (sentence.includes("__NT")) {
            return `将以下文本翻译为${promptTargetLang}，注意只需要输出翻译后的结果，不要额外解释，并保持 __NTA__ 这类占位符不变：\n\n${sentence}`;
        }
        return `将以下文本翻译为${promptTargetLang}，注意只需要输出翻译后的结果，不要额外解释：\n\n${sentence}`;
    }

    const promptTargetLang = normalizeEnglishPromptLanguageName(targetLang);
    if (sentence.includes("__NT")) {
        return `Translate the following segment into ${promptTargetLang}, without additional explanation. Keep placeholders like __NTA__ unchanged.\n\n${sentence}`;
    }
    return `Translate the following segment into ${promptTargetLang}, without additional explanation.\n\n${sentence}`;
}

function looksLikeRefusal(translation, sourceText) {
    const source = normalizeTextKey(sourceText).toLowerCase();
    const output = normalizeTextKey(translation).toLowerCase();
    if (!REFUSAL_PATTERN.test(output)) return false;
    return output.includes(source) || output.length > Math.max(40, source.length * 3);
}

function protectNonTranslatableSegments(text) {
    const segments = [];
    let protectedText = String(text || "");

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

    for (const pattern of patterns) {
        protectedText = protectedText.replace(pattern, match => {
            if (/^__NT[A-Z]+__$/.test(match)) return match;
            return addPlaceholder(match);
        });
    }

    return {
        text: protectedText,
        segments
    };
}

function restoreNonTranslatableSegments(text, segments) {
    let restored = String(text || "");
    for (const { placeholder, value } of segments) {
        restored = restored.replaceAll(placeholder, value);
        const relaxedPlaceholder = placeholder
            .replace("__", "__\\s*")
            .replace("NT", "N\\s*T\\s*")
            .replace(/([A-Z]+)__$/, "$1\\s*__");
        restored = restored.replace(new RegExp(relaxedPlaceholder, "g"), value);
    }
    return restored;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseRepeatedPrefix(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return normalized;

    const words = normalized.split(" ");
    for (let size = 1; size <= Math.min(10, Math.floor(words.length / 3)); size++) {
        const phrase = words.slice(0, size).join(" ");
        let count = 0;

        for (let index = 0; index + size <= words.length; index += size) {
            if (words.slice(index, index + size).join(" ") !== phrase) break;
            count++;
        }

        if (count >= 3) return phrase;
    }

    const compact = normalized.replace(/\s/g, "");
    for (let size = 1; size <= Math.min(24, Math.floor(compact.length / 3)); size++) {
        const phrase = compact.slice(0, size);
        let cursor = 0;
        let count = 0;

        while (compact.slice(cursor, cursor + size) === phrase) {
            count++;
            cursor += size;
        }

        if (count >= 3) return phrase;
    }

    return normalized;
}

function firstUsefulLine(text) {
    const lines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) return "";
    return lines[0];
}

function cleanTranslationText(text, sourceLang, targetLang, sourceText) {
    let cleaned = String(text || "").trim();

    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:text)?/i, "").replace(/```$/i, "").trim();
    }

    const targetLabel = new RegExp(`^${escapeRegExp(targetLang)}\\s*:\\s*`, "i");
    cleaned = cleaned.replace(targetLabel, "").trim();
    for (const promptLanguageName of [
        normalizeEnglishPromptLanguageName(targetLang),
        normalizeChinesePromptLanguageName(targetLang)
    ]) {
        const promptTargetLabel = new RegExp(`^${escapeRegExp(promptLanguageName)}\\s*[:：]\\s*`, "i");
        cleaned = cleaned.replace(promptTargetLabel, "").trim();
    }

    const stopMarkers = [
        `\nTranslate this from `,
        `\nTranslate the following segment into `,
        `\n将以下文本翻译为`,
        `\n${sourceLang}:`,
        `\n${targetLang}:`
    ];

    for (const marker of stopMarkers) {
        const markerIndex = cleaned.indexOf(marker);
        if (markerIndex !== -1) {
            cleaned = cleaned.slice(0, markerIndex).trim();
        }
    }

    cleaned = collapseRepeatedPrefix(firstUsefulLine(cleaned));

    const sourceLength = String(sourceText || "").trim().length;
    const runawayLimit = Math.max(24, sourceLength * 3);
    if (cleaned.length > runawayLimit) {
        const firstSentence = cleaned.match(/^.*?[。！？.!?](?:\s|$)/)?.[0]?.trim();
        cleaned = firstSentence || cleaned.slice(0, runawayLimit).trim();
    }

    return cleaned;
}

function normalizePayload(payload, fallbackSourceLang) {
    if (!Array.isArray(payload)) return [];

    return payload
        .map(item => {
            if (typeof item === "string") {
                return {
                    text: item,
                    sourceLang: normalizeLanguageName(fallbackSourceLang, DEFAULT_SOURCE_LANGUAGE)
                };
            }

            return {
                text: String(item?.text || ""),
                sourceLang: normalizeLanguageName(item?.sourceLang || fallbackSourceLang, DEFAULT_SOURCE_LANGUAGE)
            };
        })
        .filter(item => item.text.trim().length > 0);
}

function estimateItemMaxTokens(text, protectedSegmentCount = 0, targetLang = DEFAULT_TARGET_LANGUAGE) {
    return Math.max(64, estimateHyMtMaxTokens(text, protectedSegmentCount, targetLang) * 2);
}

function estimateHyMtMaxTokens(text, protectedSegmentCount, targetLang) {
    const length = String(text || "").trim().length;
    const placeholderBudget = protectedSegmentCount > 0 ? 16 : 0;
    if (normalizeLanguageName(targetLang, DEFAULT_TARGET_LANGUAGE) === "English") {
        if (length <= 12) return 24 + placeholderBudget;
        if (length <= 32) return 48 + placeholderBudget;
        if (length <= 48) return 64 + placeholderBudget;
        if (length <= 80) return 96;
    }
    if (length <= 12) return 8 + placeholderBudget;
    if (length <= 32) return 12 + placeholderBudget;
    if (length <= 48) return 24 + placeholderBudget;
    if (length <= 80) return 32;
    return Math.min(320, Math.max(96, Math.ceil(length * 0.9)));
}

async function checkOmlxHealth() {
    try {
        const response = await fetch(`${OMLX_BASE_URL}/v1/models`, {
            method: "GET",
            headers: withAuthorization()
        });

        if (!response.ok) {
            return { ok: false, error: `DeepSeek responded with HTTP ${response.status}` };
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        const availableModel = findAvailableModelId(models);

        if (!availableModel) {
            return { ok: false, error: `DeepSeek is reachable, but ${OMLX_MODEL_ALIASES.join(" or ")} is not available` };
        }

        resolvedOmlxModel = availableModel;
        return { ok: true, model: availableModel };
    } catch (error) {
        return { ok: false, error: error.message || "Unable to connect to DeepSeek" };
    }
}

async function translateSingleItem(item, targetLang, modelId) {
    const protectedInput = protectNonTranslatableSegments(item.text);
    const prompt = buildTranslationPrompt(item.sourceLang, targetLang, protectedInput.text);
    const response = await runWithOmlxConcurrency(() => fetch(`${OMLX_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: withAuthorization({ "Content-Type": "application/json" }),
        body: JSON.stringify({
            model: modelId,
            messages: [
                {
                    role: "system",
                    content: TRANSLATION_SYSTEM_PROMPT
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            thinking: { type: "disabled" },
            temperature: 0,
            max_tokens: estimateItemMaxTokens(item.text, protectedInput.segments.length, targetLang)
        })
    }));

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = data?.error?.message || `DeepSeek request failed with HTTP ${response.status}`;
        throw new Error(message);
    }

    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    if (typeof content !== "string") {
        throw new Error("DeepSeek response missing translation content");
    }

    if (looksLikeRefusal(content, item.text)) return item.text;
    const cleaned = cleanTranslationText(content, item.sourceLang, targetLang, item.text);
    const restored = restoreNonTranslatableSegments(cleaned, protectedInput.segments);
    return looksLikeRefusal(restored, item.text) ? item.text : restored;
}

async function translateWithOmlx(request) {
    const targetLang = normalizeLanguageName(request.targetLang, DEFAULT_TARGET_LANGUAGE);
    const items = normalizePayload(request.payload, request.sourceLang);

    if (items.length === 0) {
        return { translatedArray: [] };
    }

    const translatedArray = new Array(items.length).fill(null);
    const uniqueItems = [];
    const seenUniqueKeys = new Map();
    const modelId = await resolveOmlxModelId();

    items.forEach((item, index) => {
        const dedupeKey = normalizeDedupeKey(item, targetLang);
        const existingUniqueIndex = seenUniqueKeys.get(dedupeKey);
        if (existingUniqueIndex !== undefined) {
            uniqueItems[existingUniqueIndex].sourceIndexes.push(index);
            return;
        }

        seenUniqueKeys.set(dedupeKey, uniqueItems.length);
        uniqueItems.push({
            item,
            sourceIndexes: [index]
        });
    });

    if (uniqueItems.length === 0) {
        return { translatedArray };
    }

    try {
        await Promise.all(uniqueItems.map(async uniqueItem => {
            const translation = await translateSingleItem(uniqueItem.item, targetLang, modelId);
            uniqueItem.sourceIndexes.forEach(sourceIndex => {
                translatedArray[sourceIndex] = translation;
            });
        }));
    } catch (error) {
        return { error: `❌ [DeepSeek 请求失败: ${error.message}]` };
    }

    return {
        translatedArray: translatedArray.map((translation, index) => {
            return translation && translation.length > 0 ? translation : items[index].text;
        })
    };
}

async function handleMessage(request) {
    if (request?.action === "health") {
        return checkOmlxHealth();
    }

    if (request?.action === "translate") {
        return translateWithOmlx(request);
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
            .catch(error => sendResponse({ error: `❌ [扩展后台异常: ${error.message}]` }));
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

function storageGet(keys) {
    if (usingBrowserApi) {
        return extensionApi.storage.local.get(keys);
    }

    return new Promise(resolve => {
        extensionApi.storage.local.get(keys, resolve);
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

    const result = await storageGet(["sourceLang", "targetLang"]);
    const sourceLang = result.sourceLang || "auto";
    const targetLang = result.targetLang || DEFAULT_TARGET_LANGUAGE;

    await executeScript({
        target: { tabId: tab.id },
        func: (nextAction, source, target) => {
            const currentDisplay = window.__currentDisplay || "original";
            window.__translationAction = nextAction === "toggle-translation"
                ? (currentDisplay === "original" ? "translate" : "revert")
                : nextAction;
            window.__translationConfig = {
                sourceLang: source,
                targetLang: target
            };
        },
        args: [action, sourceLang, targetLang]
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
