(async function() {
    const DEFAULT_CONFIG = {
        sourceLang: "auto",
        targetLang: "Simplified Chinese",
        displayMode: "replace"
    };

    const config = {
        ...DEFAULT_CONFIG,
        ...(window.__translationConfig || {})
    };
    const action = window.__translationAction || "translate";

    // The script is injected again for every action; page state lives in one translator per page.
    if (!window.__raoTranslator) {
        window.__raoTranslator = createTranslator();
    }
    await window.__raoTranslator.run(action, config);

    function createTranslator() {
        const usingBrowserApi = typeof browser !== "undefined" && browser.runtime;
        const extensionApi = usingBrowserApi ? browser : chrome;

        const OWN_CLASS = "rao-tr-own";
        const BATCH_MAX_ITEMS = 12;
        const BATCH_MAX_CHARS = 2500;
        const MAX_CONCURRENT_BATCHES = 4;
        // Larger paragraphs are translated text node by text node instead of as one tagged item.
        const MAX_UNIT_CHARS = 3000;
        const MAX_UNIT_TAGS = 40;
        const VIEWPORT_MARGIN = "600px 0px";
        const SCAN_DELAY_MS = 150;
        const FLUSH_DELAY_MS = 30;
        const TOAST_DURATION_MS = 6000;
        // Shimmer while waiting, then a left-to-right reveal of the translation.
        const SHIMMER_MS = 1800;
        const SHIMMER_SPREAD_MS = 1200;
        const WIPE_MS = 560;
        const HEIGHT_MS = 280;
        const SHIMMER_MASK = "linear-gradient(100deg, rgba(0,0,0,.38) 0%, rgba(0,0,0,.38) 42%, #000 50%, rgba(0,0,0,.38) 58%, rgba(0,0,0,.38) 100%)";
        const WIPE_MASK = "linear-gradient(100deg, #000 0%, #000 44%, transparent 56%, transparent 100%)";
        const BILINGUAL_RULE_COLOR = "rgba(77, 107, 254, 0.45)";

        const EXCLUDED_SELECTOR = [
            "pre, code, kbd, samp, var, tt, script, style, noscript, template, math, input, textarea, select, canvas, svg, audio, video, iframe",
            ".notranslate, [translate=\"no\"]",
            ".katex, .MathJax, .mjx-chtml",
            ".material-icons, [class^=\"fa-\"], [class*=\" fa-\"], [class^=\"icon-\"], [class*=\" icon-\"]",
            "[contenteditable=\"\"], [contenteditable=\"true\"], [contenteditable=\"plaintext-only\"]",
            `.${OWN_CLASS}`
        ].join(", ");

        let activeConfig = null;
        // Unit = one block element whose inline content is translated as a single item.
        const units = new Map();
        // Text node -> { original, translated } so the page can switch back and forth.
        const textRecords = new WeakMap();
        const queue = [];
        let flushTimer = null;
        let activeBatches = 0;
        const waitingBatches = [];
        const pendingScanRoots = new Set();
        let scanTimer = null;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let toastTimer = null;
        let lastToast = { message: "", at: 0 };

        const intersectionObserver = new IntersectionObserver(onIntersection, { rootMargin: VIEWPORT_MARGIN });
        const mutationObserver = new MutationObserver(onMutations);

        window.__hasTranslated = window.__hasTranslated || false;
        window.__currentDisplay = window.__currentDisplay || "original";

        // ---------- Messaging ----------

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

        // ---------- Language detection ----------

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
            if (code.startsWith("vi")) return "Vietnamese";
            if (code.startsWith("th")) return "Thai";
            if (code.startsWith("id")) return "Indonesian";
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
            if (/[\u0e00-\u0e7f]/.test(text)) return "Thai";
            if (/[\u0600-\u06ff]/.test(text)) return "Arabic";
            if (/[\u0400-\u04ff]/.test(text)) return "Russian";
            if (/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return "Vietnamese";
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

        // ---------- Toast ----------

        function showToast(message) {
            const now = Date.now();
            if (lastToast.message === message && now - lastToast.at < TOAST_DURATION_MS) return;
            lastToast = { message, at: now };

            let host = document.getElementById("rao-tr-toast-host");
            if (!host) {
                host = document.createElement("div");
                host.id = "rao-tr-toast-host";
                host.className = OWN_CLASS;
                host.setAttribute("translate", "no");
                host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
                const shadow = host.attachShadow({ mode: "open" });
                // Built without innerHTML so pages that enforce Trusted Types still show it.
                const style = document.createElement("style");
                style.textContent = `div { font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; background: rgba(185, 28, 28, 0.95);
                    padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: 320px; transition: opacity .2s; }`;
                shadow.append(style, document.createElement("div"));
                (document.body || document.documentElement).appendChild(host);
            }

            const box = host.shadowRoot.querySelector("div");
            box.textContent = `翻译失败：${message}`;
            box.style.opacity = "1";
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                box.style.opacity = "0";
            }, TOAST_DURATION_MS);
        }

        // ---------- Input field translation ----------

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

        function findContentEditableRoot(element) {
            if (!element?.closest) return null;
            return element.closest("[contenteditable]:not([contenteditable=\"false\"])");
        }

        function placeCaretAtEnd(element) {
            const selection = window.getSelection();
            if (!selection) return;

            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        function getFocusedEditableText() {
            const element = document.activeElement;
            if (isTextEditableElement(element)) {
                const text = element.value;
                if (!text.trim()) return null;

                return {
                    text,
                    element,
                    replace: translatedText => {
                        element.value = translatedText;
                        element.focus();
                        if (typeof element.setSelectionRange === "function") {
                            element.setSelectionRange(translatedText.length, translatedText.length);
                        }
                        dispatchInputEvent(element, translatedText);
                    }
                };
            }

            const editableRoot = findContentEditableRoot(element);
            if (!editableRoot) return null;

            const text = editableRoot.innerText || editableRoot.textContent || "";
            if (!text.trim()) return null;

            return {
                text,
                element: editableRoot,
                replace: translatedText => {
                    editableRoot.textContent = translatedText;
                    editableRoot.focus();
                    placeCaretAtEnd(editableRoot);
                    dispatchInputEvent(editableRoot, translatedText);
                }
            };
        }

        async function translateFocusedInputText(selectionConfig) {
            const editableInfo = getFocusedEditableText();
            if (!editableInfo) return;

            const originalText = editableInfo.text;
            const sourceLang = await detectSourceLanguage(originalText);
            const targetLang = resolveSelectionTarget(sourceLang, selectionConfig);
            const waiting = reduceMotion.matches
                ? null
                : editableInfo.element.animate([{ opacity: 1 }, { opacity: 0.45 }], { duration: 250, fill: "forwards" });

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

                waiting?.cancel();
                const translatedText = response?.translatedArray?.[0];
                if (translatedText) {
                    const leadingSpace = originalText.match(/^\s*/)?.[0] || "";
                    const trailingSpace = originalText.match(/\s*$/)?.[0] || "";
                    editableInfo.replace(leadingSpace + translatedText + trailingSpace);
                    wipeIn(editableInfo.element);
                } else {
                    showToast(response?.error || "没有拿到译文");
                }
            } catch (error) {
                waiting?.cancel();
                showToast(error.message || "扩展通信失败");
            }
        }

        // ---------- Text selection rules ----------

        function isCodeLikeStandaloneText(text) {
            const value = text.trim();
            if (!value || /\s/.test(value)) return false;

            if (/^@[A-Za-z0-9][A-Za-z0-9_-]{1,38}$/.test(value)) return true;
            if (/^--[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) return true;
            if (/^[A-Z][A-Z0-9_]{1,12}$/.test(value)) return true;
            if (/[\\/@]/.test(value)) return true;
            if (/\.[A-Za-z0-9]{1,8}(?:[#?].*)?$/.test(value)) return true;
            if (/[a-z][A-Z]/.test(value)) return true;
            if (/[._]/.test(value) && /[A-Za-z]/.test(value)) return true;
            if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(value) && /[A-Z0-9]/.test(value)) return true;

            return false;
        }

        function isGitHubPage() {
            return location.hostname === "github.com" || location.hostname.endsWith(".github.com");
        }

        function isGitHubNonContentElement(element) {
            if (!isGitHubPage() || !element?.closest) return false;

            const githubChromeSelectors = [
                "header",
                "#repository-container-header",
                "#repos-sticky-header",
                "[data-testid=\"breadcrumbs\"]",
                "[data-testid=\"breadcrumbs-filename\"]",
                "[data-testid=\"blob-size\"]",
                "[aria-label=\"File view\"]",
                "[data-testid=\"raw-button\"]",
                "[data-testid=\"copy-raw-button\"]",
                "[data-testid=\"download-raw-button\"]",
                "[data-testid^=\"more-file-actions-button\"]",
                "[data-testid=\"latest-commit-details\"]",
                "[data-testid=\"screen-reader-heading\"]",
                ".js-file-line",
                ".blob-code",
                ".react-code-lines",
                ".react-directory",
                ".PRIVATE_TreeView",
                "[aria-label=\"File Tree\"]",
                "[data-testid=\"tree-browser\"]",
                "[data-testid=\"file-tree\"]"
            ].join(",");

            if (element.closest(githubChromeSelectors)) return true;

            const link = element.closest("a[href]");
            if (!link) return false;

            const href = link.getAttribute("href") || "";
            // File and folder names in repository listings, even plain words like "examples".
            const linkText = (element.textContent || "").trim();
            const lastPathSegment = href.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
            let decodedSegment = lastPathSegment;
            try {
                decodedSegment = decodeURIComponent(lastPathSegment);
            } catch (error) {
                // Keep the raw segment when the URL is not valid percent-encoding.
            }
            if (/\/(?:blob|tree)\//.test(href) && linkText && linkText === decodedSegment) return true;

            return isCodeLikeStandaloneText(element.textContent || "")
                && /(?:\/blob\/|\/tree\/|\/raw\/|\/commits\/|github\.com\/[^/]+\/[^/]+|\/[^/?#]+\.[A-Za-z0-9]{1,8}(?:[?#]|$))/i.test(href);
        }

        function isExcludedElement(element) {
            return !element || element.closest(EXCLUDED_SELECTOR) !== null || isGitHubNonContentElement(element);
        }

        function isTranslatableText(text) {
            const trimmedText = text.trim();
            const cleanText = trimmedText.replace(/\s+/g, "");

            if (cleanText.length <= 2) return false;
            if (isCodeLikeStandaloneText(trimmedText)) return false;
            if (/^(https?:\/\/|ftp:\/\/|www\.)\S+$/i.test(trimmedText)) return false;
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedText)) return false;
            if (/^[\d.,\-+$€£¥₹\s:\/]+(AM|PM|am|pm)?$/.test(trimmedText)) return false;
            if (!/[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff\u0e00-\u0e7f\u0600-\u06ff]/.test(trimmedText)) return false;

            return true;
        }

        function originalValueOf(node) {
            const record = textRecords.get(node);
            if (record && node.nodeValue === record.translated) return record.original;
            return node.nodeValue;
        }

        function isCandidateText(node) {
            if (isExcludedElement(node.parentElement)) return false;
            return isTranslatableText(originalValueOf(node));
        }

        function isOwnNode(node) {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            return !!element?.closest?.(`.${OWN_CLASS}`);
        }

        function displayOf(element) {
            return window.getComputedStyle(element).display;
        }

        function isInlineDisplay(display) {
            return display === "inline" || display === "contents";
        }

        function findUnitRoot(element) {
            let current = element;
            while (current && current !== document.body && current !== document.documentElement) {
                if (!isInlineDisplay(displayOf(current))) return current;
                current = current.parentElement;
            }
            return document.body;
        }

        // ---------- Unit serialization ----------

        // Inline markup becomes <gN>...</gN>; anything kept as-is (code, icons, nested blocks) becomes <xN/>.
        function hasCandidateTextInline(element) {
            for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if (isCandidateText(child)) return true;
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.matches(EXCLUDED_SELECTOR) || isGitHubNonContentElement(child)) continue;
                    const display = displayOf(child);
                    if (display === "none" || !isInlineDisplay(display)) continue;
                    if (hasCandidateTextInline(child)) return true;
                }
            }
            return false;
        }

        function serializeUnit(root) {
            const containers = new Map();
            const parentOf = new Map();
            const atomicText = new Map();
            const snapshot = new Map();
            let nextId = 1;

            function walk(element, containerId) {
                const container = { element, runs: [[]] };
                containers.set(containerId, container);
                let out = "";

                for (const child of element.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const value = originalValueOf(child);
                        container.runs[container.runs.length - 1].push(child);
                        snapshot.set(child, value);
                        out += value;
                        continue;
                    }

                    if (child.nodeType !== Node.ELEMENT_NODE || child.classList.contains(OWN_CLASS)) continue;

                    const display = displayOf(child);
                    if (display === "none") continue;

                    const id = nextId++;
                    container.runs.push([]);

                    const keepAsIs = child.matches(EXCLUDED_SELECTOR)
                        || isGitHubNonContentElement(child)
                        || !isInlineDisplay(display)
                        || !hasCandidateTextInline(child);

                    if (keepAsIs) {
                        atomicText.set(id, child.tagName === "BR" ? " " : (child.textContent || ""));
                        out += `<x${id}/>`;
                    } else {
                        parentOf.set(id, containerId);
                        out += `<g${id}>${walk(child, id)}</g${id}>`;
                    }
                }

                return out;
            }

            const text = walk(root, 0).replace(/\s+/g, " ").trim();
            return {
                text,
                containers,
                parentOf,
                atomicText,
                snapshot,
                tagCount: nextId - 1
            };
        }

        function plainTextOf(taggedText, atomicText) {
            return taggedText
                .replace(/<x(\d+)\/>/g, (match, id) => atomicText.get(Number(id)) || "")
                .replace(/<\/?g\d+>/g, "")
                .replace(/\s+/g, " ")
                .trim();
        }

        function parseTaggedTranslation(translation, model) {
            const root = { id: 0, segments: [""] };
            const parsed = new Map([[0, root]]);
            const parentOf = new Map();
            const stack = [root];
            const tokenPattern = /<(\/?)([gx])(\d+)(\/?)>/g;
            let cursor = 0;
            let match;

            while ((match = tokenPattern.exec(translation))) {
                const top = stack[stack.length - 1];
                top.segments[top.segments.length - 1] += translation.slice(cursor, match.index);
                cursor = tokenPattern.lastIndex;

                const [, closing, kind, rawId, selfClosing] = match;
                const id = Number(rawId);

                if (kind === "x") {
                    if (closing) continue;
                    top.segments.push("");
                    continue;
                }

                if (selfClosing) return null;

                if (!closing) {
                    if (parsed.has(id)) return null;
                    const node = { id, segments: [""] };
                    parsed.set(id, node);
                    parentOf.set(id, top.id);
                    top.segments.push("");
                    stack.push(node);
                } else {
                    if (top.id !== id || stack.length === 1) return null;
                    stack.pop();
                }
            }

            if (stack.length !== 1) return null;
            stack[0].segments[stack[0].segments.length - 1] += translation.slice(cursor);

            if (parentOf.size !== model.parentOf.size) return null;
            for (const [id, parentId] of model.parentOf) {
                if (parentOf.get(id) !== parentId) return null;
            }

            return parsed;
        }

        // Maps translated text back onto the existing text nodes; elements stay where they are.
        function assignTaggedTranslation(translation, model) {
            const parsed = parseTaggedTranslation(translation, model);
            if (!parsed) return null;

            const assignments = new Map();

            for (const [id, container] of model.containers) {
                const segments = parsed.get(id).segments;
                const runs = container.runs;
                const values = runs.map(() => "");
                const hasNodes = runs.map(run => run.length > 0);

                if (segments.length === runs.length) {
                    let carry = "";
                    let lastWithNodes = -1;
                    segments.forEach((segment, index) => {
                        if (hasNodes[index]) {
                            values[index] = carry + segment;
                            carry = "";
                            lastWithNodes = index;
                        } else if (lastWithNodes >= 0) {
                            values[lastWithNodes] += segment;
                        } else {
                            carry += segment;
                        }
                    });
                    if (carry.trim()) return null;
                } else {
                    const firstWithNodes = hasNodes.indexOf(true);
                    const joined = segments.join("");
                    if (firstWithNodes === -1) {
                        if (joined.trim()) return null;
                    } else {
                        values[firstWithNodes] = joined;
                    }
                }

                runs.forEach((run, index) => {
                    run.forEach((node, nodeIndex) => {
                        assignments.set(node, nodeIndex === 0 ? values[index] : "");
                    });
                });
            }

            // Keep the paragraph's outer whitespace so it still sits correctly next to its siblings.
            const ordered = [...model.snapshot.keys()];
            const firstNode = ordered.find(node => assignments.get(node));
            const lastNode = [...ordered].reverse().find(node => assignments.get(node));
            if (firstNode) {
                const leading = model.snapshot.get(firstNode).match(/^\s*/)[0];
                assignments.set(firstNode, leading + assignments.get(firstNode).trimStart());
            }
            if (lastNode) {
                const trailing = model.snapshot.get(lastNode).match(/\s*$/)[0];
                assignments.set(lastNode, assignments.get(lastNode).trimEnd() + trailing);
            }

            return assignments;
        }

        function withOuterWhitespace(original, text) {
            const leadingSpace = original.match(/^\s*/)?.[0] || "";
            const trailingSpace = original.match(/\s*$/)?.[0] || "";
            return leadingSpace + text + trailingSpace;
        }

        // ---------- Units ----------

        function getOrCreateUnit(root) {
            let unit = units.get(root);
            if (!unit) {
                unit = {
                    root,
                    status: "idle",
                    mode: "tagged",
                    model: null,
                    items: [],
                    result: null,
                    bilingualElement: null,
                    shimmer: null,
                    shimmering: false,
                    changedWhileProcessing: false
                };
                units.set(root, unit);
                watchUnit(unit);
            }
            return unit;
        }

        function watchUnit(unit) {
            intersectionObserver.unobserve(unit.root);
            intersectionObserver.observe(unit.root);
        }

        function markUnitChanged(unit) {
            if (unit.status === "processing" || unit.status === "queued") {
                unit.changedWhileProcessing = true;
                return;
            }
            if (unit.status === "idle") return;

            unit.status = "idle";
            watchUnit(unit);
        }

        function unitHasChanged(unit, node) {
            if (!unit.model) return false;
            if (!unit.model.snapshot.has(node)) return true;
            return unit.model.snapshot.get(node) !== originalValueOf(node);
        }

        function scan(rootNode) {
            const root = rootNode.nodeType === Node.TEXT_NODE ? rootNode.parentElement : rootNode;
            if (!root || !root.isConnected || isOwnNode(root)) return;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: node => (isCandidateText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
            });

            let node;
            while ((node = walker.nextNode())) {
                const unit = getOrCreateUnit(findUnitRoot(node.parentElement));
                if (unitHasChanged(unit, node)) markUnitChanged(unit);
            }
        }

        function prepareUnit(unit) {
            const model = serializeUnit(unit.root);
            unit.model = model;

            if (model.text.length <= MAX_UNIT_CHARS && model.tagCount <= MAX_UNIT_TAGS && unit.mode === "tagged") {
                unit.items = [model.text];
                return plainTextOf(model.text, model.atomicText);
            }

            unit.mode = "nodes";
            unit.nodeTargets = [...model.snapshot.keys()].filter(node => isCandidateText(node));
            unit.items = unit.nodeTargets.map(node => model.snapshot.get(node).replace(/\s+/g, " ").trim());
            return unit.items.join(" ");
        }

        function buildResult(unit, translations) {
            const model = unit.model;

            if (unit.mode === "tagged") {
                const assignments = assignTaggedTranslation(translations[0], model);
                if (!assignments) return null;
                return {
                    assignments,
                    bilingualText: plainTextOf(translations[0], model.atomicText),
                    originalText: plainTextOf(model.text, model.atomicText)
                };
            }

            const assignments = new Map();
            unit.nodeTargets.forEach((node, index) => {
                assignments.set(node, withOuterWhitespace(model.snapshot.get(node), translations[index]));
            });
            return {
                assignments,
                bilingualText: translations.join(" "),
                originalText: unit.items.join(" ")
            };
        }

        function isUnitStale(unit) {
            for (const [node, value] of unit.model.snapshot) {
                if (!node.isConnected || originalValueOf(node) !== value) return true;
            }
            return false;
        }

        // ---------- Display ----------

        // Masks keep the site's own colors: the whole paragraph dims and an opaque band drifts across it.
        const MASK_PROPERTIES = [
            "maskImage", "maskSize", "maskRepeat", "maskPosition",
            "webkitMaskImage", "webkitMaskSize", "webkitMaskRepeat", "webkitMaskPosition"
        ];
        const savedMasks = new WeakMap();
        const maskOwners = new WeakMap();
        const runningWipes = new WeakMap();

        function setMask(element, image, owner) {
            if (!savedMasks.has(element)) {
                savedMasks.set(element, {
                    hadStyleAttribute: element.hasAttribute("style"),
                    values: MASK_PROPERTIES.map(property => [property, element.style[property]])
                });
            }
            maskOwners.set(element, owner);
            for (const prefix of ["mask", "webkitMask"]) {
                element.style[`${prefix}Image`] = image;
                element.style[`${prefix}Size`] = "300% 100%";
                element.style[`${prefix}Repeat`] = "no-repeat";
                element.style[`${prefix}Position`] = "100% 0";
            }
        }

        function clearMask(element, owner) {
            if (maskOwners.get(element) !== owner) return;
            const saved = savedMasks.get(element);
            saved?.values.forEach(([property, value]) => {
                element.style[property] = value;
            });
            // Leave no empty style="" behind on elements that had none.
            if (saved && !saved.hadStyleAttribute && !(element.getAttribute("style") || "").trim()) {
                element.removeAttribute("style");
            }
            savedMasks.delete(element);
            maskOwners.delete(element);
        }

        function maskSweepFrames() {
            return [
                { maskPosition: "100% 0", webkitMaskPosition: "100% 0" },
                { maskPosition: "0 0", webkitMaskPosition: "0 0" }
            ];
        }

        function isOnScreen(element) {
            const rect = element.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
        }

        function canAnimate(element) {
            return !reduceMotion.matches && element !== document.body && element.isConnected;
        }

        function startShimmer(unit) {
            const root = unit.root;
            if (unit.shimmering || root === document.body || window.__currentDisplay !== "translated") return;
            unit.shimmering = true;
            setMask(root, SHIMMER_MASK, unit);
            if (reduceMotion.matches) return;

            // Paragraphs are out of step like a wave running down the screen: higher ones lead.
            const top = Math.max(0, Math.min(window.innerHeight, root.getBoundingClientRect().top));
            const delay = -(SHIMMER_SPREAD_MS - (top / window.innerHeight) * SHIMMER_SPREAD_MS);
            unit.shimmer = root.animate(maskSweepFrames(), {
                duration: SHIMMER_MS,
                iterations: Infinity,
                delay,
                easing: "cubic-bezier(.45, 0, .55, 1)"
            });
        }

        function stopShimmer(unit) {
            if (!unit.shimmering) return;
            unit.shimmering = false;
            unit.shimmer?.cancel();
            unit.shimmer = null;
            clearMask(unit.root, unit);
        }

        // The new text is uncovered from left to right, the way the shimmer was moving.
        function wipeIn(element) {
            if (!canAnimate(element)) return;
            cancelWipe(element);
            const owner = {};
            setMask(element, WIPE_MASK, owner);
            const animation = element.animate([
                { maskPosition: "100% 0", webkitMaskPosition: "100% 0", filter: "blur(1.5px)" },
                { maskPosition: "0 0", webkitMaskPosition: "0 0", filter: "blur(0)" }
            ], { duration: WIPE_MS, easing: "cubic-bezier(.4, 0, .2, 1)" });
            runningWipes.set(element, { animation, owner });
            animation.finished
                .catch(() => {})
                .then(() => {
                    clearMask(element, owner);
                    if (runningWipes.get(element)?.owner === owner) runningWipes.delete(element);
                });
        }

        function cancelWipe(element) {
            const wipe = element && runningWipes.get(element);
            if (!wipe) return;
            runningWipes.delete(element);
            wipe.animation.cancel();
            clearMask(element, wipe.owner);
        }

        // Keeps the content below from jumping when the translation is shorter or longer.
        function changeWithHeightTransition(element, change) {
            const display = canAnimate(element) ? window.getComputedStyle(element).display : "";
            const animate = display === "block" || display === "list-item";
            const before = animate ? element.getBoundingClientRect().height : 0;
            change();
            if (!animate) return;

            const after = element.getBoundingClientRect().height;
            if (Math.abs(after - before) < 2) return;
            element.animate(
                [{ height: `${before}px`, overflow: "hidden" }, { height: `${after}px`, overflow: "hidden" }],
                { duration: HEIGHT_MS, easing: "cubic-bezier(.4, 0, .2, 1)" }
            );
        }

        function showTranslated(unit, animated = false) {
            if (!unit.result) return;
            const animate = animated && canAnimate(unit.root) && isOnScreen(unit.root);

            if (activeConfig.displayMode === "bilingual") {
                showBilingual(unit, animate);
                return;
            }

            const apply = () => {
                for (const [node, value] of unit.result.assignments) {
                    let record = textRecords.get(node);
                    if (!record || node.nodeValue !== record.translated) {
                        record = { original: node.nodeValue, translated: value };
                        textRecords.set(node, record);
                    } else {
                        record.translated = value;
                    }
                    if (node.nodeValue !== value) node.nodeValue = value;
                }
            };

            if (!animate) {
                apply();
                return;
            }
            changeWithHeightTransition(unit.root, apply);
            wipeIn(unit.root);
        }

        function showBilingual(unit, animate) {
            const { bilingualText, originalText } = unit.result;
            if (!bilingualText || bilingualText === originalText) return;

            let element = unit.bilingualElement;
            if (!element) {
                element = document.createElement("font");
                element.className = `${OWN_CLASS} rao-tr-bilingual`;
                element.setAttribute("translate", "no");
                const isBlock = originalText.length > 40 || /[.!?。！？]\s*$/.test(originalText);
                element.style.cssText = isBlock
                    ? `display:block;margin-top:0.25em;padding-left:0.6em;border-left:1px solid ${BILINGUAL_RULE_COLOR};opacity:0.78;`
                    : "margin-left:0.4em;opacity:0.78;";
                unit.bilingualElement = element;
            }
            element.textContent = bilingualText;
            if (element.parentNode === unit.root) return;

            if (!animate) {
                unit.root.appendChild(element);
                return;
            }
            changeWithHeightTransition(unit.root, () => unit.root.appendChild(element));
            wipeIn(element);
        }

        function showOriginal(unit, animated = false) {
            const animate = animated && canAnimate(unit.root) && isOnScreen(unit.root);
            const bilingualElement = unit.bilingualElement;
            cancelWipe(unit.root);
            cancelWipe(bilingualElement);

            if (bilingualElement?.isConnected) {
                if (!animate) {
                    bilingualElement.remove();
                } else {
                    bilingualElement.animate([{ opacity: 0.78 }, { opacity: 0 }], { duration: 160 })
                        .finished
                        .catch(() => {})
                        .then(() => {
                            if (window.__currentDisplay === "translated") return;
                            changeWithHeightTransition(unit.root, () => bilingualElement.remove());
                        });
                }
            }
            if (!unit.result) return;

            const restore = () => {
                for (const node of unit.result.assignments.keys()) {
                    const record = textRecords.get(node);
                    if (record && node.nodeValue === record.translated) {
                        node.nodeValue = record.original;
                    }
                }
            };

            if (!animate || activeConfig?.displayMode === "bilingual") {
                restore();
                return;
            }
            changeWithHeightTransition(unit.root, restore);
            unit.root.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
        }

        // ---------- Scheduling ----------

        function onIntersection(entries) {
            if (window.__currentDisplay !== "translated") return;

            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const unit = units.get(entry.target);
                if (!unit || unit.status !== "idle") continue;
                intersectionObserver.unobserve(entry.target);
                enqueue(unit);
            }
        }

        function onMutations(mutations) {
            for (const mutation of mutations) {
                if (mutation.type === "characterData") {
                    const node = mutation.target;
                    if (isOwnNode(node)) continue;
                    const record = textRecords.get(node);
                    if (record && (node.nodeValue === record.translated || node.nodeValue === record.original)) continue;
                    pendingScanRoots.add(node);
                    continue;
                }

                mutation.addedNodes.forEach(node => {
                    if (!isOwnNode(node)) pendingScanRoots.add(node);
                });
            }

            if (pendingScanRoots.size > 0 && !scanTimer) {
                scanTimer = setTimeout(() => {
                    scanTimer = null;
                    const roots = [...pendingScanRoots];
                    pendingScanRoots.clear();
                    if (window.__currentDisplay !== "translated") return;
                    roots.forEach(scan);
                }, SCAN_DELAY_MS);
            }
        }

        function enqueue(unit) {
            unit.status = "queued";
            queue.push(unit);
            if (!flushTimer) {
                flushTimer = setTimeout(flushQueue, FLUSH_DELAY_MS);
            }
        }

        async function flushQueue() {
            flushTimer = null;
            const pending = queue.splice(0);
            const ready = [];

            for (const unit of pending) {
                if (!unit.root.isConnected) {
                    units.delete(unit.root);
                    continue;
                }

                unit.changedWhileProcessing = false;
                const plainText = prepareUnit(unit);
                const sourceLang = activeConfig.sourceLang === "auto"
                    ? await detectSourceLanguage(plainText)
                    : activeConfig.sourceLang;

                if (unit.items.length === 0 || !isTranslatableText(plainText) || isSameLanguage(sourceLang, activeConfig.targetLang)) {
                    unit.status = "skipped";
                    continue;
                }
                ready.push(unit);
            }

            let batch = [];
            let batchItems = 0;
            let batchChars = 0;
            for (const unit of ready) {
                const unitChars = unit.items.reduce((sum, item) => sum + item.length, 0);
                if (batch.length > 0 && (batchItems + unit.items.length > BATCH_MAX_ITEMS || batchChars + unitChars > BATCH_MAX_CHARS)) {
                    runBatch(batch);
                    batch = [];
                    batchItems = 0;
                    batchChars = 0;
                }
                batch.push(unit);
                batchItems += unit.items.length;
                batchChars += unitChars;
            }
            if (batch.length > 0) runBatch(batch);
        }

        async function runBatch(batchUnits) {
            if (activeBatches >= MAX_CONCURRENT_BATCHES) {
                await new Promise(resolve => waitingBatches.push(resolve));
            }
            activeBatches++;

            const targetLang = activeConfig.targetLang;
            batchUnits.forEach(unit => {
                unit.status = "processing";
                startShimmer(unit);
            });

            try {
                const response = await sendRuntimeMessage({
                    action: "translate",
                    payload: batchUnits.flatMap(unit => unit.items),
                    targetLang
                });

                if (!response?.translatedArray) {
                    throw new Error(response?.error || "没有拿到译文");
                }

                batchUnits.forEach(stopShimmer);

                // The user switched language while this batch was running.
                if (targetLang !== activeConfig.targetLang) {
                    batchUnits.forEach(unit => {
                        unit.status = "idle";
                        watchUnit(unit);
                    });
                    return;
                }

                let offset = 0;
                for (const unit of batchUnits) {
                    const translations = response.translatedArray.slice(offset, offset + unit.items.length);
                    offset += unit.items.length;
                    finishUnit(unit, translations);
                }
            } catch (error) {
                batchUnits.forEach(unit => {
                    stopShimmer(unit);
                    unit.status = "error";
                });
                showToast(error.message || "扩展通信失败");
            } finally {
                batchUnits.forEach(stopShimmer);
                activeBatches--;
                const next = waitingBatches.shift();
                if (next) next();
            }
        }

        function finishUnit(unit, translations) {
            if (unit.changedWhileProcessing || isUnitStale(unit)) {
                unit.changedWhileProcessing = false;
                unit.status = "idle";
                watchUnit(unit);
                return;
            }

            const result = buildResult(unit, translations);
            if (!result) {
                // The model broke the inline tags; translate this paragraph node by node instead.
                unit.mode = "nodes";
                unit.status = "idle";
                enqueue(unit);
                return;
            }

            unit.result = result;
            unit.status = "done";
            if (window.__currentDisplay === "translated") {
                showTranslated(unit, true);
            }
        }

        // ---------- Actions ----------

        function revertPage() {
            window.__currentDisplay = "original";
            mutationObserver.disconnect();
            clearTimeout(scanTimer);
            scanTimer = null;
            pendingScanRoots.clear();
            units.forEach(unit => {
                stopShimmer(unit);
                showOriginal(unit, true);
            });
        }

        function translatePage(nextConfig) {
            if (!document.body) return;

            const languageChanged = activeConfig
                && (activeConfig.targetLang !== nextConfig.targetLang || activeConfig.sourceLang !== nextConfig.sourceLang);
            const modeChanged = activeConfig && activeConfig.displayMode !== nextConfig.displayMode;

            if (languageChanged || modeChanged) {
                units.forEach(unit => showOriginal(unit));
            }
            if (languageChanged) {
                units.forEach(unit => {
                    unit.result = null;
                    unit.mode = "tagged";
                    unit.status = "idle";
                });
            }

            activeConfig = nextConfig;
            window.__currentDisplay = "translated";
            window.__hasTranslated = true;

            units.forEach(unit => {
                if (!unit.root.isConnected) {
                    units.delete(unit.root);
                    return;
                }
                if (unit.status === "done") showTranslated(unit, true);
                if (unit.status === "error") unit.status = "idle";
                if (unit.status === "idle") watchUnit(unit);
            });

            scan(document.body);
            mutationObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        }

        async function run(nextAction, nextConfig) {
            if (nextAction === "translate-selection") {
                await translateFocusedInputText(nextConfig);
                return;
            }

            if (nextAction === "revert") {
                revertPage();
                return;
            }

            translatePage(nextConfig);
        }

        return { run };
    }
})();
