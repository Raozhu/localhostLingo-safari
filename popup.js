const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
const extensionApi = usingBrowserApi ? browser : chrome;
const elementsToSave = ["sourceLang", "targetLang", "displayMode"];
const API_KEY_STORAGE_KEY = "deepseekApiKey";

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

function storageGet(keys) {
    if (usingBrowserApi) {
        return extensionApi.storage.local.get(keys);
    }

    return new Promise(resolve => {
        extensionApi.storage.local.get(keys, resolve);
    });
}

function storageSet(value) {
    if (usingBrowserApi) {
        return extensionApi.storage.local.set(value);
    }

    return new Promise(resolve => {
        extensionApi.storage.local.set(value, resolve);
    });
}

function sendRuntimeMessage(message) {
    if (usingBrowserApi) {
        return extensionApi.runtime.sendMessage(message);
    }

    return new Promise((resolve, reject) => {
        extensionApi.runtime.sendMessage(message, response => {
            const error = extensionApi.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve(response);
        });
    });
}

function isInjectableTab(tab) {
    if (!tab?.url) return false;
    return !/^(chrome|edge|about|safari-web-extension):/i.test(tab.url);
}

async function executeAction(action) {
    const sourceLang = document.getElementById("sourceLang").value;
    const targetLang = document.getElementById("targetLang").value;
    const displayMode = document.getElementById("displayMode").value;
    const tab = await queryActiveTab();

    if (!tab?.id || !isInjectableTab(tab)) return;

    await executeScript({
        target: { tabId: tab.id },
        func: (nextAction, nextConfig) => {
            window.__translationAction = nextAction;
            window.__translationConfig = nextConfig;
        },
        args: [action, { sourceLang, targetLang, displayMode }]
    });

    await executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
    });
}

function setServiceStatus({ connected, message }) {
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const translateBtn = document.getElementById("translateBtn");

    statusDot.className = connected ? "status-dot connected" : "status-dot disconnected";
    statusText.innerText = message;
    statusText.style.color = connected ? "#9CA3AF" : "#EF4444";
    translateBtn.disabled = !connected;
    translateBtn.innerText = connected ? "翻译本页" : "服务不可用";
}

function describeSavedKey(apiKey) {
    if (!apiKey) return "sk-...";
    return apiKey.length > 8 ? `已保存（…${apiKey.slice(-4)}）` : "已保存";
}

async function refreshKeyField() {
    const result = await storageGet([API_KEY_STORAGE_KEY]);
    const input = document.getElementById("apiKey");
    input.value = "";
    input.placeholder = describeSavedKey(result[API_KEY_STORAGE_KEY]);
}

async function refreshServiceStatus() {
    setServiceStatus({ connected: false, message: "检测 DeepSeek 状态..." });
    try {
        const health = await sendRuntimeMessage({ action: "health" });
        if (health?.ok) {
            setServiceStatus({
                connected: true,
                message: "DeepSeek 已连接"
            });
        } else {
            setServiceStatus({
                connected: false,
                message: health?.error || "无法连接 DeepSeek"
            });
            if (health?.missingKey) document.getElementById("apiKey").focus();
        }
    } catch (error) {
        setServiceStatus({
            connected: false,
            message: error.message || "无法连接 DeepSeek"
        });
    }
}

async function saveApiKey() {
    const apiKey = document.getElementById("apiKey").value.trim();
    if (!apiKey) return;

    await storageSet({ [API_KEY_STORAGE_KEY]: apiKey });
    await refreshKeyField();
    await refreshServiceStatus();
}

document.getElementById("saveKeyBtn").addEventListener("click", () => {
    saveApiKey().catch(error => console.error("Failed to save API key:", error));
});

document.getElementById("apiKey").addEventListener("keydown", event => {
    if (event.key === "Enter") {
        saveApiKey().catch(error => console.error("Failed to save API key:", error));
    }
});

document.getElementById("translateBtn").addEventListener("click", () => {
    executeAction("translate").catch(error => console.error("Translate action failed:", error));
});

document.getElementById("revertBtn").addEventListener("click", () => {
    executeAction("revert").catch(error => console.error("Revert action failed:", error));
});

elementsToSave.forEach(id => {
    document.getElementById(id).addEventListener("change", event => {
        storageSet({ [id]: event.target.value }).catch(error => {
            console.error("Failed to save option:", error);
        });
    });
});

document.addEventListener("DOMContentLoaded", async () => {
    const result = await storageGet(elementsToSave);
    if (result.sourceLang) document.getElementById("sourceLang").value = result.sourceLang;
    if (result.targetLang) document.getElementById("targetLang").value = result.targetLang;
    if (result.displayMode) document.getElementById("displayMode").value = result.displayMode;
    await refreshKeyField();

    const tab = await queryActiveTab();
    if (isInjectableTab(tab)) {
        try {
            const results = await executeScript({
                target: { tabId: tab.id },
                func: () => !!window.__hasTranslated
            });

            if (results?.[0]?.result) {
                document.getElementById("revertBtn").disabled = false;
            }
        } catch (error) {
            console.error("Failed to inspect page state:", error);
        }
    }

    await refreshServiceStatus();
});
