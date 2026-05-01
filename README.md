# Rao oMLX Translate

Safari WebExtension source for translating web pages through a local oMLX service.

## Local Service

- URL: `http://127.0.0.1:9510`
- Model: `HY-MT1.5-1.8B-8bit`
- API: OpenAI-compatible `/v1/chat/completions`
- Browser translation concurrency: `2`

## Test Page

Open `translation-quality-test.html` in Safari, enable the temporary extension, and run page translation from the toolbar popup.

## Shortcuts

- `Option+A`: toggle the current page between translated text and original text.
- `Control+A`: translate and replace the currently selected text. If the selected text is already in the configured target language, the extension translates it back to the configured source language. With source set to Auto and target set to Chinese, English text becomes Chinese and Chinese text becomes English.

## Safari Packaging

See `SAFARI.md` for generating the Safari Web Extension Xcode project after full Xcode is installed.
