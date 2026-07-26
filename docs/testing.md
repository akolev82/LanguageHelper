# Testing Guide

This document explains how to test the Language Helper extension at both the Rust core level and the VS Code extension host level.

## 1. Test the Rust Core Logic (Unit Tests)

You can test the Rust translation parsing logic (such as the `FluentAdapter`) independently using standard Cargo commands:

```bash
cd crates/core
cargo test
```

## 2. Build the Extension

Before running the extension in VS Code / Antigravity IDE, compile the Rust Wasm modules and the TypeScript extension host:

```bash
npm run build
```

*Note: Building requires `wasm-pack` and `dioxus-cli` (`dx`) installed on your machine.*

## 3. Launch & Test in VS Code / Antigravity IDE

We have created `.vscode/launch.json` for quick debugging:

1. Open the project root in VS Code / Antigravity IDE.
2. Go to the **Run and Debug** panel (`Ctrl+Shift+D` or `Cmd+Shift+D`).
3. Select **Run Extension** and press **F5**.
4. A new Extension Development Host window will launch.
5. In the new window, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
   ```
   Open Translation Grid
   ```
6. The extension webview panel will open up displaying the grid editor interface.
