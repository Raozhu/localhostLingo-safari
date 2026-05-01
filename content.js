(async function() {
    const DEFAULT_CONFIG = {
        sourceLang: "auto",
        targetLang: "Simplified Chinese"
    };

    const config = {
        ...DEFAULT_CONFIG,
        ...(window.__translationConfig || {})
    };
    const action = window.__translationAction || "translate";
    const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
    const extensionApi = usingBrowserApi ? browser : chrome;

    window.__translatedNodesMap = window.__translatedNodesMap || new Map();
    window.__hasTranslated = window.__hasTranslated || false;
    window.__currentDisplay = window.__currentDisplay || "original";

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

    function mapLanguageCode(languageCode) {
        const code = String(languageCode || "").toLowerCase();
        if (code.startsWith("zh-hant") || code === "zh-tw" || code === "zh-hk") return "Traditional Chinese";
        if (code.startsWith("zh")) return "Simplified Chinese";
        if (code.startsWith("en")) return "English";
        if (code.startsWith("ja")) return "Japanese";
        if (code.startsWith("ko")) return "Korean";
        if (code.startsWith("fr")) return "French";
        if (code.startsWith("de")) return "German";
        if (code.startsWith("es")) return "Spanish";
        if (code.startsWith("it")) return "Italian";
        if (code.startsWith("pt")) return "Portuguese";
        if (code.startsWith("ru")) return "Russian";
        if (code.startsWith("ar")) return "Arabic";
        return null;
    }

    async function detectLanguageWithApi(text) {
        if (usingBrowserApi && extensionApi.i18n?.detectLanguage) {
            try {
                return await extensionApi.i18n.detectLanguage(text);
            } catch (error) {
                return null;
            }
        }

        if (typeof chrome !== "undefined" && chrome.i18n?.detectLanguage) {
            return new Promise(resolve => {
                chrome.i18n.detectLanguage(text, result => resolve(result || null));
            });
        }

        return null;
    }

    function detectLanguageByText(text) {
        if (/[\u3040-\u30ff]/.test(text)) return "Japanese";
        if (/[\uac00-\ud7af]/.test(text)) return "Korean";
        if (/[\u4e00-\u9fff]/.test(text)) return "Simplified Chinese";
        if (/[a-zA-Z]/.test(text)) return "English";
        return "English";
    }

    async function detectSourceLanguage(text) {
        const detected = await detectLanguageWithApi(text);
        const language = detected?.languages?.find(item => item.percentage >= 30);
        const mappedLanguage = mapLanguageCode(language?.language);
        return mappedLanguage || detectLanguageByText(text);
    }

    function languageFamily(languageName) {
        const language = String(languageName || "").toLowerCase();
        if (language.includes("chinese")) return "zh";
        if (language === "english") return "en";
        if (language === "japanese") return "ja";
        if (language === "korean") return "ko";
        return language;
    }

    function isSameLanguage(sourceLang, targetLang) {
        return languageFamily(sourceLang) === languageFamily(targetLang);
    }

    function defaultReverseTarget(languageName) {
        const family = languageFamily(languageName);
        if (family === "zh") return "English";
        return "Simplified Chinese";
    }

    function resolveSelectionTarget(sourceLang, selectionConfig) {
        const configuredSource = selectionConfig.sourceLang || "auto";
        const configuredTarget = selectionConfig.targetLang || "Simplified Chinese";
        let targetLang = configuredTarget;

        if (configuredSource === "auto") {
            if (isSameLanguage(sourceLang, configuredTarget)) {
                targetLang = defaultReverseTarget(sourceLang);
            }
        } else if (isSameLanguage(sourceLang, configuredTarget)) {
            targetLang = configuredSource;
        } else if (isSameLanguage(sourceLang, configuredSource)) {
            targetLang = configuredTarget;
        }

        if (isSameLanguage(sourceLang, targetLang)) {
            targetLang = defaultReverseTarget(sourceLang);
        }

        return targetLang;
    }

    function isTextEditableElement(element) {
        if (!element) return false;
        if (element instanceof HTMLTextAreaElement) return true;
        if (!(element instanceof HTMLInputElement)) return false;

        const textTypes = new Set([
            "",
            "email",
            "number",
            "password",
            "search",
            "tel",
            "text",
            "url"
        ]);
        return textTypes.has((element.type || "").toLowerCase());
    }

    function dispatchInputEvent(element, data) {
        try {
            element.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                inputType: "insertReplacementText",
                data
            }));
        } catch (error) {
            element.dispatchEvent(new Event("input", { bubbles: true }));
        }
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function getEditableSelection() {
        const element = document.activeElement;
        if (!isTextEditableElement(element)) return null;

        const start = element.selectionStart;
        const end = element.selectionEnd;
        if (typeof start !== "number" || typeof end !== "number" || start === end) return null;

        const text = element.value.slice(start, end);
        if (!text.trim()) return null;

        return {
            text,
            replace: translatedText => {
                element.setRangeText(translatedText, start, end, "select");
                dispatchInputEvent(element, translatedText);
            }
        };
    }

    function getDocumentSelection() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

        const text = selection.toString();
        if (!text.trim()) return null;

        const ranges = [];
        for (let index = 0; index < selection.rangeCount; index++) {
            ranges.push(selection.getRangeAt(index).cloneRange());
        }

        return {
            text,
            replace: translatedText => {
                selection.removeAllRanges();
                const firstInsertedNode = document.createTextNode(translatedText);

                ranges.forEach((range, index) => {
                    range.deleteContents();
                    const node = index === 0 ? firstInsertedNode : document.createTextNode(translatedText);
                    range.insertNode(node);
                });

                const replacementRange = document.createRange();
                replacementRange.selectNodeContents(firstInsertedNode);
                selection.removeAllRanges();
                selection.addRange(replacementRange);
            }
        };
    }

    async function translateSelectedText() {
        const selectionInfo = getEditableSelection() || getDocumentSelection();
        if (!selectionInfo) return;

        const originalText = selectionInfo.text;
        const sourceLang = config.sourceLang === "auto"
            ? await detectSourceLanguage(originalText)
            : await detectSourceLanguage(originalText);
        const targetLang = resolveSelectionTarget(sourceLang, config);

        try {
            const response = await sendRuntimeMessage({
                action: "translate",
                payload: [
                    {
                        text: originalText.trim(),
                        sourceLang
                    }
                ],
                targetLang
            });

            const translatedText = response?.translatedArray?.[0];
            if (translatedText) {
                const leadingSpace = originalText.match(/^\s*/)?.[0] || "";
                const trailingSpace = originalText.match(/\s*$/)?.[0] || "";
                selectionInfo.replace(leadingSpace + translatedText + trailingSpace);
            } else {
                console.error("Selection translation failed:", response?.error || "Unknown response");
            }
        } catch (error) {
            console.error("Selection translation failed:", error);
        }
    }

    function shouldTranslate(element, text) {
        if (!element) return false;

        if (element.offsetWidth === 0 && element.offsetHeight === 0) return false;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;

        const blacklistedTags = "pre, code, kbd, samp, var, tt, script, style, noscript, math, input, textarea, select, canvas, svg, audio, video";
        if (element.closest(blacklistedTags)) return false;

        if (element.closest(".notranslate, [translate=\"no\"]")) return false;
        if (element.closest(".katex, .MathJax, .mjx-chtml")) return false;
        if (element.closest(".material-icons, [class^=\"fa-\"], [class*=\" fa-\"], [class^=\"icon-\"], [class*=\" icon-\"]")) return false;

        const trimmedText = text.trim();
        const cleanText = trimmedText.replace(/\s+/g, "");

        if (cleanText.length <= 2) return false;
        if (/^(https?:\/\/|ftp:\/\/|www\.)\S+$/i.test(trimmedText)) return false;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedText)) return false;
        if (/^[\d.,\-+$€£¥₹\s:\/]+(AM|PM|am|pm)?$/.test(trimmedText)) return false;
        if (!/[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(trimmedText)) return false;

        return true;
    }

    function applyTextPreservingOuterWhitespace(node, text) {
        const leadingSpace = node.nodeValue.match(/^\s*/)?.[0] || "";
        const trailingSpace = node.nodeValue.match(/\s*$/)?.[0] || "";
        node.nodeValue = leadingSpace + text + trailingSpace;
    }

    async function translatePage() {
        if (!document.body) return;

        if (action === "revert") {
            for (const [node, texts] of window.__translatedNodesMap.entries()) {
                if (document.body.contains(node)) {
                    applyTextPreservingOuterWhitespace(node, texts.original);
                }
            }
            window.__currentDisplay = "original";
            return;
        }

        window.__currentDisplay = "translated";
        window.__hasTranslated = true;

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: node => {
                return shouldTranslate(node.parentElement, node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });

        const textNodes = [];
        let currentNode;
        while ((currentNode = walker.nextNode())) {
            textNodes.push(currentNode);
        }

        const MAX_BATCH_ITEMS = 10;
        const MAX_BATCH_CHARS = 500;
        const batches = [];
        let currentBatch = [];
        let currentBatchChars = 0;

        for (const node of textNodes) {
            const currentText = node.nodeValue.trim();

            if (window.__translatedNodesMap.has(node)) {
                const cache = window.__translatedNodesMap.get(node);
                if (cache.translated) {
                    if (window.__currentDisplay === "translated") {
                        applyTextPreservingOuterWhitespace(node, cache.translated);
                    }
                    continue;
                }
                if (cache.status === "processing") {
                    continue;
                }
            } else {
                window.__translatedNodesMap.set(node, {
                    original: currentText,
                    translated: null,
                    sourceLang: null,
                    status: "processing"
                });
            }

            const cache = window.__translatedNodesMap.get(node);
            const sourceLang = config.sourceLang === "auto"
                ? await detectSourceLanguage(cache.original)
                : config.sourceLang;

            cache.sourceLang = sourceLang;

            if (isSameLanguage(sourceLang, config.targetLang)) {
                cache.status = "skipped";
                continue;
            }

            currentBatch.push(node);
            currentBatchChars += cache.original.length;

            if (currentBatch.length >= MAX_BATCH_ITEMS || currentBatchChars >= MAX_BATCH_CHARS) {
                batches.push(currentBatch);
                currentBatch = [];
                currentBatchChars = 0;
            }
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        const spinnerChars = ["|", "/", "-", "\\"];
        const MAX_CONCURRENT = 2;
        const activePromises = [];

        for (const batch of batches) {
            const promise = processBatch(batch, config, spinnerChars).finally(() => {
                activePromises.splice(activePromises.indexOf(promise), 1);
            });

            activePromises.push(promise);

            if (activePromises.length >= MAX_CONCURRENT) {
                await Promise.race(activePromises);
            }
        }

        await Promise.all(activePromises);
    }

    async function processBatch(batchNodes, batchConfig, spinnerChars) {
        const payload = batchNodes.map(node => {
            const cache = window.__translatedNodesMap.get(node);
            return {
                text: cache.original,
                sourceLang: cache.sourceLang || "English"
            };
        });
        const spinners = [];

        batchNodes.forEach(node => {
            if (window.__currentDisplay === "translated" && node.parentElement) {
                const spinnerSpan = document.createElement("span");
                spinnerSpan.style.marginLeft = "5px";
                spinnerSpan.style.fontFamily = "monospace";
                spinnerSpan.style.color = "#ff5722";
                spinnerSpan.style.fontWeight = "bold";
                node.parentElement.appendChild(spinnerSpan);
                spinners.push(spinnerSpan);
            }
        });

        let spinnerIdx = 0;
        let spinnerInterval = null;
        if (spinners.length > 0) {
            spinnerInterval = setInterval(() => {
                const char = spinnerChars[spinnerIdx % spinnerChars.length];
                spinners.forEach(span => {
                    span.innerText = char;
                });
                spinnerIdx++;
            }, 100);
        }

        try {
            const response = await sendRuntimeMessage({
                action: "translate",
                payload,
                targetLang: batchConfig.targetLang
            });

            if (spinnerInterval) clearInterval(spinnerInterval);
            spinners.forEach(span => span.remove());

            if (response?.translatedArray) {
                const translatedArray = response.translatedArray;
                for (let i = 0; i < batchNodes.length; i++) {
                    const node = batchNodes[i];
                    const cache = window.__translatedNodesMap.get(node);
                    const translatedText = translatedArray[i] || cache.original;

                    cache.translated = translatedText;
                    cache.status = "done";

                    if (window.__currentDisplay === "translated") {
                        applyTextPreservingOuterWhitespace(node, translatedText);
                    }
                }
                return;
            }

            console.error("Translation failed:", response?.error || "Unknown response");
            batchNodes.forEach(node => {
                window.__translatedNodesMap.get(node).status = "error";
            });
        } catch (error) {
            if (spinnerInterval) clearInterval(spinnerInterval);
            spinners.forEach(span => span.remove());
            batchNodes.forEach(node => {
                window.__translatedNodesMap.get(node).status = "error";
            });
            console.error("Batch translation failed:", error);
        }
    }

    if (action === "translate-selection") {
        await translateSelectedText();
    } else {
        await translatePage();
    }
})();
