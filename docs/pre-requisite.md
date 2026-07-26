# Prerequisites and Dependencies

This document details all system toolchains, CLI utilities, Node.js packages, and Rust dependencies required to build and develop the **LanguageHelper** VS Code extension.

---

## 1. System Requirements & CLI Tools

| Tool | Recommended / Installed Version | Installation Command / Link | Purpose |
| :--- | :--- | :--- | :--- |
| **Rust Toolchain** (`rustc`, `cargo`) | `>= 1.70.0` (installed `1.96.0`) | [rustup.rs](https://rustup.rs/) | Rust compiler & package manager for `core` and `webview` crates |
| **Node.js** | `>= 20.0.0` (installed `v24.13.1`) | [nodejs.org](https://nodejs.org/) | JavaScript runtime for VS Code extension development |
| **npm** | `>= 9.0.0` (installed `11.8.0`) | Included with Node.js | Package manager for Node dependencies & build scripts |
| **wasm-pack** | `>= 0.12.0` (installed `0.12.1`) | `cargo install wasm-pack` | Compiles Rust crates (`core` and `webview`) into WebAssembly target bindings |
| **wasm32 Target** | Target `wasm32-unknown-unknown` | `rustup target add wasm32-unknown-unknown` | Rust target triple required for WASM compilation |

---

## 2. Node.js Dependencies (`package.json`)

Install all Node dependencies locally by running `npm install` in the project root.

### Development Dependencies (`devDependencies`)

| Package | Version | Purpose |
| :--- | :--- | :--- |
| [`esbuild`](https://www.npmjs.com/package/esbuild) | `^0.18.0` | Fast bundler used to compile TypeScript extension code (`src/extension.ts`) to `dist/extension.js` |
| [`typescript`](https://www.npmjs.com/package/typescript) | `^5.1.0` | TypeScript language support & type checking |
| [`@types/vscode`](https://www.npmjs.com/package/@types/vscode) | `^1.80.0` | Type definitions for the VS Code extension API |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | `^20.0.0` | Type definitions for Node.js runtime environment |

---

## 3. Core Rust Crate Dependencies (`crates/core/Cargo.toml`)

The `core` crate compiles to WASM (`--target nodejs`) to provide translation parsing, adapter interfaces, and project configuration handling to the extension background process.

| Crate | Version | Purpose |
| :--- | :--- | :--- |
| [`wasm-bindgen`](https://crates.io/crates/wasm-bindgen) | `0.2.87` | Facilitates high-level bindings between Rust and JavaScript/Node.js |
| [`fluent-syntax`](https://crates.io/crates/fluent-syntax) | `0.11` | Parser and AST generator for Project Fluent (`.ftl`) translation files |
| [`fluent-bundle`](https://crates.io/crates/fluent-bundle) | `0.15` | Runtime localization and message resolution for Fluent |
| [`serde`](https://crates.io/crates/serde) | `1.0` (`features = ["derive"]`) | Serialization/deserialization framework for Rust data structures |
| [`serde_json`](https://crates.io/crates/serde_json) | `1.0` | JSON support for exchange of translation datasets between WASM and extension host |

---

## 4. Webview Rust Crate Dependencies (`crates/webview/Cargo.toml`)

The `webview` crate compiles to WASM (`--target web`) to render the grid interface inside the VS Code Webview container.

| Crate | Version | Purpose |
| :--- | :--- | :--- |
| [`dioxus`](https://crates.io/crates/dioxus) | `0.5.1` | React-like UI framework for Rust web targets and webviews |
| [`serde`](https://crates.io/crates/serde) | `1.0` (`features = ["derive"]`) | Data serialization for state synchronization with webview |
| [`serde_json`](https://crates.io/crates/serde_json) | `1.0` | JSON parsing for webview messaging |

---

## 5. Build Commands

Run the full project build with:

```bash
# 1. Install Node dependencies
npm install

# 2. Add WASM compilation target to Rust (if not already added)
rustup target add wasm32-unknown-unknown

# 3. Build all components (core WASM, webview WASM, extension bundle)
npm run build
```
