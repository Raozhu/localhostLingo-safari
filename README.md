# Rao DeepSeek Translate

Safari WebExtension that translates web pages and text fields through the DeepSeek API.

## Setup

1. Copy `config.example.js` to `config.js` (git-ignored) and fill in `DEEPSEEK_API_KEY`.
2. Run `scripts/install.sh` (needs Xcode). It builds, signs and installs `/Applications/Rao DeepSeek Translate.app`.
3. Quit Safari (⌘Q), reopen it, and enable the extension in Safari Settings > Extensions.

## How it works

- Model: `deepseek-flash` with thinking disabled, OpenAI-compatible `/v1/chat/completions`, JSON in and JSON out.
- A paragraph is translated as one item. Inline markup (links, bold) is sent as `<g1>…</g1>` and kept on the same elements; code, icons and nested blocks are sent as `<x2/>` and left untouched. If the model breaks the tags, that paragraph falls back to text-node-by-text-node translation.
- Only paragraphs near the viewport are translated; the rest follow as you scroll. Content added later (infinite scroll, SPA navigation, edited text) is translated automatically while the page is in translated mode.
- While a paragraph waits for its translation it dims and a band of full-strength text drifts across it (a mask, so the site's own colors stay), out of step from the top of the screen down. The translation is then uncovered from left to right, the paragraph's height eases to its new size, and switching back to the original is a short fade. With Reduce Motion on, paragraphs only dim while waiting and nothing else animates.
- Up to 12 paragraphs share one request; requests are retried on timeouts, 429 and 5xx. Failures show a short message in the page corner.
- Translations are cached in `storage.local` (up to 8000 entries, oldest pruned first).
- Text the model cannot translate (made-up words, names) stays as the original instead of an explanation.

## Display modes

- 替换原文: replace the page text in place.
- 双语对照: keep the original and show the translation below it (or beside short labels).

## Translation Guards

- GitHub repository chrome, breadcrumbs, file metadata, file trees and file/folder names, standalone filenames, repository paths, usernames, code flags, acronyms, and CamelCase identifiers are skipped or protected before model calls.
- `pre`/`code`, form fields, editable areas (`contenteditable`), `translate="no"` and `.notranslate` are never changed.

## Shortcuts

- `Option+A`: toggle the current page between translated text and original text.
- `Control+S`: translate and replace the full text in the currently focused input field. If the text is already in the configured target language, the extension translates it back to the configured source language. With source set to Auto and target set to Chinese, English text becomes Chinese and Chinese text becomes English.

## Tests

```sh
npm install
npx playwright install webkit
npm test
```

Tests use a fake DeepSeek endpoint: no API key or paid calls. `tests/background.test.mjs` covers batching, caching, retries and output checks; `tests/content.test.mjs` runs the content script in WebKit.
