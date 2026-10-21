# Rao DeepSeek Translate Safari Build

This directory is the Safari WebExtension source. The Xcode project is generated on demand and is not checked in.

## Install

```sh
scripts/install.sh
```

The script:

1. copies only the extension files (manifest, scripts, popup, icons) into `.build/extension`;
2. runs `xcrun safari-web-extension-packager` to generate a macOS Swift app project;
3. fixes the app bundle id to `com.rao.localhostlingo.safari` (the extension id `com.rao.localhostlingo.safari.Extension` must start with it);
4. builds Release with automatic signing for the first team signed in to Xcode (override with `TEAM_ID=...`) and the version from `manifest.json`;
5. replaces `/Applications/Rao DeepSeek Translate.app`, unregisters and deletes the build copy so Safari lists the extension only once, and opens the app.

After installing, quit Safari (⌘Q) and reopen it so the new version loads. The first time, enable the extension in Safari Settings > Extensions, then enter your DeepSeek API key in the extension popup. The key lives only in Safari's extension storage; it is never bundled into the app.
