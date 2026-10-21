// Loads background.js in a sandbox with a fake DeepSeek endpoint and in-memory extension storage.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");

export function upperCaseWords(text) {
    return text.replace(/[A-Za-z]{2,}/g, word => word.toUpperCase());
}

export function chatResponse(translations, status = 200) {
    const body = status === 200
        ? { choices: [{ message: { content: JSON.stringify({ translations }) } }] }
        : { error: { message: `HTTP ${status}` } };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// `respond(items, target, callIndex)` returns a translations array or a Response.
export function loadBackground(respond = items => items.map(upperCaseWords), { apiKey = "test-key" } = {}) {
    const store = apiKey ? { deepseekApiKey: apiKey } : {};
    const requests = [];
    let handler = null;

    async function fakeFetch(url, options = {}) {
        if (String(url).endsWith("/v1/models")) {
            return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
        }
        const body = JSON.parse(options.body);
        const { target, items } = JSON.parse(body.messages[1].content);
        requests.push({ body, target, items, authorization: options.headers?.Authorization });
        const result = await respond(items, target, requests.length - 1);
        return result instanceof Response ? result : chatResponse(result);
    }

    const storage = {
        local: {
            get: async keys => {
                if (keys === null) return { ...store };
                const list = Array.isArray(keys) ? keys : [keys];
                return Object.fromEntries(list.filter(key => key in store).map(key => [key, store[key]]));
            },
            set: async values => Object.assign(store, values),
            remove: async keys => [].concat(keys).forEach(key => delete store[key])
        }
    };

    const context = {
        fetch: fakeFetch,
        console,
        setTimeout,
        clearTimeout,
        AbortController,
        URL,
        browser: {
            runtime: { onMessage: { addListener: listener => { handler = listener; } } },
            commands: {},
            storage
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);

    return {
        handle: message => handler(message),
        requests,
        store
    };
}

export const contentScriptSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
