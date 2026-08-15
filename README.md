# Language Helper 🌐

> **A high-performance, grid-based localization and translation editor for Visual Studio Code, powered by Rust and WebAssembly.**

[![VS Code](https://img.shields.io/badge/VS%20Code-v1.80+-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Rust](https://img.shields.io/badge/Rust-WASM%20Core-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fluent](https://img.shields.io/badge/Format-Project%20Fluent%20%7C%20JSON-orange)](https://projectfluent.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📖 Overview & Purpose

Managing internationalization (i18n) across multi-language projects is often cumbersome. Translation keys are scattered across dozens of individual files and locale directories, making it easy to introduce inconsistencies, lose track of missing translations, or break file syntax when editing by hand.

**Language Helper** solves this problem by providing a centralized, interactive split-view grid editor directly inside VS Code:

- **Unified Interface**: View and edit translations across all supported locales side-by-side without switching between files.
- **Blazing Fast**: Powered by a Rust core compiled to WebAssembly (`wasm-pack`), ensuring instant parsing, glob matching, and serialization even with thousands of translation keys.
- **Safe & Syntax-Aware**: Uses native AST parsing and preservation (such as `fluent-syntax`) so your comments, parameters, and message structures remain intact upon saving.
- **Disk-Synchronized**: Actively watches translation files for external changes and provides interactive conflict resolution when changes collide with unsaved local edits.

---

## ✨ Key Features

- **⚡ Rust + WebAssembly Core**: High-performance layout compilation, glob expansion, path matching, and format serialization handled entirely in Rust WASM.
- **🌐 Multi-Format Support**:
  - **Project Fluent (`.ftl`)**: Full AST parsing, placeable extraction (`{ $variable }`, terms, references), and syntax-preserving updates.
  - **JSON (`.json`)**: Structured key-value localization support.
  - *Extensible architecture for additional formats via modular Rust adapters.*
- **📁 Flexible File Layout Strategies**: Supports directory-per-locale (`locales/{locale}/{file}.ftl`), locale-in-filename (`locales/{file}.{locale}.ftl`), or any custom pattern defined via path templates.
- **📊 Split-View Grid Editor**:
  - **Left Table**: Quick overview of all keys grouped by module (file), with pagination, status badges, and search.
  - **Right Panel**: Detailed translation inputs for all configured locales for the selected key, with locale-level search.
  - **Draggable Splitter**: Easily adjust pane widths according to your workflow.
- **🔍 Live Search & Filter**:
  - Instant search across translation keys and translated text values.
  - Filter by status (`All`, `All Unsaved Changes`, `Modified Items`, `New Items`).
  - Filter by module/file.
- **📦 Module & Translation Management**:
  - **+ Add Translation**: Add new keys across all active locales in a single modal.
  - **+ Add Module**: Scaffold new translation files across all locale directories simultaneously.
  - **Bulk Move**: Reorganize translation keys between modules in bulk.
  - **Delete & Confirmation**: Delete individual or selected keys with safe confirmation prompts.
- **🔄 Real-Time File Watcher & Conflict Resolution**:
  - Automatically reloads changes made to translation files on disk.
  - Visual unsaved status indicators (`Unsaved Changes` banner, item state tracking).
  - Interactive **Conflict Resolution Modal** enabling granular control (`Keep Local`, `Accept Disk`, or per-key selection) when disk edits collide with unsaved modifications.

---

## 🛠️ Configuration (`language-helper.json`)

To enable Language Helper in your project, create a `language-helper.json` configuration file in the root directory of your workspace.

### Schema

```json
{
  "format": "fluent",
  "file_layout": "locales/{locale}/{file}.ftl",
  "locales": ["en", "de", "fr", "es"]
}
```

### Configuration Options

| Option | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `format` | `string` | **Yes** | Translation adapter format. Supported values: `"fluent"` (or `"ftl"`), `"json"`. |
| `file_layout` | `string` | **Yes** | Path pattern with `{locale}` and `{file}` placeholders mapping translation files on disk. |
| `locales` | `string[]` | *Optional* | Explicit list of locale codes to manage and display in the editor. If omitted, locales are discovered dynamically from existing files. |

---

### Supported File Layout Patterns

#### Strategy A: Directory per Locale (`locales/{locale}/{file}.ftl`)

```text
my-project/
├── language-helper.json
└── locales/
    ├── en/
    │   ├── main.ftl
    │   └── auth.ftl
    └── de/
        ├── main.ftl
        └── auth.ftl
```

```json
{
  "format": "fluent",
  "file_layout": "locales/{locale}/{file}.ftl"
}
```

---

#### Strategy B: Locale Suffix per File (`locales/{file}.{locale}.ftl`)

```text
my-project/
├── language-helper.json
└── locales/
    ├── main.en.ftl
    ├── main.de.ftl
    ├── auth.en.ftl
    └── auth.de.ftl
```

```json
{
  "format": "fluent",
  "file_layout": "locales/{file}.{locale}.ftl"
}
```

---

## 🚀 How to Use

### 1. Open the Translation Grid
1. Open your workspace containing `language-helper.json` in VS Code / Antigravity IDE.
2. Open the Command Palette (`Ctrl+Shift+P` on Linux/Windows, `Cmd+Shift+P` on macOS).
3. Type and select **`Developer: Open Translation Grid`**.

### 2. Navigating and Editing
- **Select a Key**: Click any row in the left table to open its locale values in the right panel.
- **Edit Translations**: Type new or updated text in any locale text area. Modified fields are automatically tracked.
- **Search & Filter**: Use the top search bar to filter by key name or translated content. Use the status dropdown to quickly find untranslated or modified items.

### 3. Adding Keys and Modules
- **Add a Translation**: Click the **`+ Add Translation`** button in the header toolbar, specify the module and key name, fill in locale values, and submit.
- **Add a Module**: Click **`+ Add Module`** at the bottom of the table to create a new translation file across all locale targets.

### 4. Bulk Operations
- Use the table checkboxes to select multiple rows.
- Click **`Move to Module`** to move selected keys to another translation file.
- Click **`Delete Selected`** to remove keys across all locales.

### 5. Saving and Resolving Conflicts
- Click **`Save Changes`** in the toolbar to write all modifications back to their respective files on disk.
- If a file is modified externally while you have unsaved changes in the editor, a **Conflict Resolution Dialog** will appear, allowing you to choose whether to keep your local edits or accept the disk version for each conflicting key.

---

## 🏗️ Architecture & Project Structure

```text
LanguageHelper/
├── crates/
│   ├── core/               # Rust Core (compiled to WASM for Node.js host)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs      # WASM export boundaries
│   │       ├── config.rs   # Configuration parsing & validation
│   │       ├── layout.rs   # Path template compiler, regex matching & globbing
│   │       └── format/     # Format adapters (fluent.rs, json.rs, mod.rs)
│   └── webview/            # Rust Webview experimental crate (Dioxus web target)
├── src/
│   └── extension.ts        # VS Code Extension host (TypeScript)
├── media/
│   ├── index.html          # Webview UI layout and modals
│   ├── main.js             # Client-side state management, virtual table & event handlers
│   └── style.css           # UI theme styling matched to VS Code theme tokens
├── docs/                   # Additional documentation guides
│   ├── configuration-extension.md
│   ├── pre-requisite.md
│   └── testing.md
├── package.json            # Extension manifest and build scripts
└── Cargo.toml              # Rust workspace definition
```

---

## 🔧 Building & Development

### Prerequisites

Ensure the following tools are installed on your machine:

- **Node.js**: `>= 20.0.0`
- **npm**: `>= 9.0.0`
- **Rust toolchain**: `>= 1.70.0` with `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **wasm-pack**: `>= 0.12.0`
  ```bash
  cargo install wasm-pack
  ```

### Build Commands

```bash
# 1. Install Node.js dependencies
npm install

# 2. Build Rust WASM crates and bundle extension
npm run build

# 3. Watch mode for extension TypeScript development
npm run watch
```

### Running the Extension Locally

1. Open the project folder in VS Code / Antigravity IDE.
2. Press **`F5`** (or go to **Run and Debug** and select **Run Extension**).
3. In the new Extension Development Host window, open a workspace containing `language-helper.json`.
4. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and execute **`Developer: Open Translation Grid`**.

### Running Tests

Run unit tests for the Rust core logic (layout compilation, path matching, format parsing):

```bash
cd crates/core
cargo test
```

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

## 👤 Author

Developed by **Aleksandar Kolev** (@ 2026). Powered by **LogiMech**.
