// Background service worker for the Safari WebExtension build.
// It talks only to the local oMLX OpenAI-compatible completions endpoint.
const OMLX_BASE_URL = "http://127.0.0.1:9510";
const OMLX_API_KEY = "raoz";
const OMLX_MODEL = "MiLMMT-mlx-8bit";
const DEFAULT_SOURCE_LANGUAGE = "English";
const DEFAULT_TARGET_LANGUAGE = "Simplified Chinese";

const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
const extensionApi = usingBrowserApi ? browser : chrome;

function withAuthorization(extraHeaders = {}) {
    return {
        ...extraHeaders,
        "Authorization": `Bearer ${OMLX_API_KEY}`
    };
}

function normalizeLanguageName(languageName, fallback) {
    const language = (languageName || "").trim();
    if (!language || language.toLowerCase() === "auto") {
        return fallback;
    }
    return language;
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
    return `Translate this from ${sourceLang} to ${targetLang}:\n${sourceLang}: ${sentence}\n${targetLang}:\n`;
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

    const stopMarkers = [
        `\nTranslate this from `,
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

function estimateItemMaxTokens(text) {
    const length = String(text || "").trim().length;
    if (length <= 12) return 8;
    if (length <= 32) return 10;
    if (length <= 48) return 16;
    if (length <= 80) return 32;
    return Math.min(320, Math.max(96, Math.ceil(length * 0.9)));
}

function groupItemsByTokenBudget(items) {
    const groupsByBudget = new Map();

    items.forEach((item, index) => {
        const maxTokens = estimateItemMaxTokens(item.text);
        if (!groupsByBudget.has(maxTokens)) {
            groupsByBudget.set(maxTokens, []);
        }
        groupsByBudget.get(maxTokens).push({ item, index });
    });

    return [...groupsByBudget.entries()].map(([maxTokens, entries]) => ({ maxTokens, entries }));
}

async function checkOmlxHealth() {
    try {
        const response = await fetch(`${OMLX_BASE_URL}/v1/models`, {
            method: "GET",
            headers: withAuthorization()
        });

        if (!response.ok) {
            return { ok: false, error: `oMLX responded with HTTP ${response.status}` };
        }

        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        const hasModel = models.some(model => model.id === OMLX_MODEL);

        if (!hasModel) {
            return { ok: false, error: `oMLX is running, but ${OMLX_MODEL} is not available` };
        }

        return { ok: true, model: OMLX_MODEL };
    } catch (error) {
        return { ok: false, error: error.message || "Unable to connect to oMLX" };
    }
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

    const groups = groupItemsByTokenBudget(uniqueItems.map(uniqueItem => uniqueItem.item));

    for (const group of groups) {
        const prompts = group.entries.map(entry => {
            return buildTranslationPrompt(entry.item.sourceLang, targetLang, entry.item.text);
        });

        const response = await fetch(`${OMLX_BASE_URL}/v1/completions`, {
            method: "POST",
            headers: withAuthorization({ "Content-Type": "application/json" }),
            body: JSON.stringify({
                model: OMLX_MODEL,
                prompt: prompts,
                temperature: 0,
                max_tokens: group.maxTokens
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const message = data?.error?.message || `oMLX request failed with HTTP ${response.status}`;
            return { error: `❌ [oMLX 请求失败: ${message}]` };
        }

        if (!Array.isArray(data?.choices)) {
            return { error: "❌ [oMLX 响应异常: 缺少 choices]" };
        }

        data.choices.forEach((choice, fallbackIndex) => {
            const groupIndex = Number.isInteger(choice?.index) ? choice.index : fallbackIndex;
            const entry = group.entries[groupIndex];
            if (!entry) return;

            const translation = cleanTranslationText(
                choice?.text,
                entry.item.sourceLang,
                targetLang,
                entry.item.text
            );
            uniqueItems[entry.index].sourceIndexes.forEach(sourceIndex => {
                translatedArray[sourceIndex] = translation;
            });
        });
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

async function toggleTranslationForActiveTab() {
    const tab = await queryActiveTab();
    if (!tab?.id) return;

    const result = await storageGet(["sourceLang", "targetLang"]);
    const sourceLang = result.sourceLang || "auto";
    const targetLang = result.targetLang || DEFAULT_TARGET_LANGUAGE;

    await executeScript({
        target: { tabId: tab.id },
        func: (source, target) => {
            const currentDisplay = window.__currentDisplay || "original";
            window.__translationAction = currentDisplay === "original" ? "translate" : "revert";
            window.__translationConfig = {
                sourceLang: source,
                targetLang: target
            };
        },
        args: [sourceLang, targetLang]
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
            toggleTranslationForActiveTab().catch(error => {
                console.error("Failed to toggle translation:", error);
            });
        }
    });
}
