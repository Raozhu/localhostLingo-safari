# Rao oMLX Translate

Safari WebExtension source for translating web pages through a local oMLX service.

## Local Service

- URL: `http://127.0.0.1:9510`
- Model: `MiLMMT-mlx-8bit`
- API: OpenAI-compatible `/v1/completions`

## Test Page

Open `translation-quality-test.html` in Safari, enable the temporary extension, and run page translation from the toolbar popup.

## Safari Packaging

See `SAFARI.md` for generating the Safari Web Extension Xcode project after full Xcode is installed.
