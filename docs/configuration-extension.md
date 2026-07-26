# Project Layout & Configuration Guide

The **LanguageHelper** extension requires a per-project configuration file (`language-helper.json`) in the root directory of your workspace. This file informs the Rust core adapter how translation files are structured, located, and formatted across your project.

---

## 1. Configuration File Location

Place `language-helper.json` at the root of your workspace:

```text
my-project/
├── .vscode/
├── locales/
│   ├── en/
│   │   └── main.ftl
│   └── fr/
│       └── main.ftl
├── language-helper.json   <-- Project Configuration File
└── package.json
```

---

## 2. Configuration Options

### Schema Definition

```json
{
  "format": "fluent",
  "file_layout": "locales/{locale}/{file}.ftl"
}
```

### Property Reference

| Property | Type | Allowed Values | Description |
| :--- | :--- | :--- | :--- |
| `format` | `string` | `"fluent"` (more formats planned) | The translation file format adapter to use for parsing and serialization. |
| `file_layout` | `string` | Path pattern string | Glob/Path template defining how locale codes and files are mapped on disk. |

---

## 3. Supported File Layout Strategies

### Strategy A: Directory per Locale (`locales/{locale}/{file}.ftl`)

In this layout, each locale has its own dedicated directory containing translation files.

**Example Directory Tree:**
```text
locales/
├── en/
│   ├── messages.ftl
│   └── errors.ftl
└── de/
    ├── messages.ftl
    └── errors.ftl
```

**Configuration (`language-helper.json`):**
```json
{
  "format": "fluent",
  "file_layout": "locales/{locale}/{file}.ftl"
}
```

---

### Strategy B: Single Directory with Locale Suffix (`locales/{file}.{locale}.ftl`)

In this layout, all translation files reside in a single directory, with the locale specified as part of the filename.

**Example Directory Tree:**
```text
locales/
├── app.en.ftl
├── app.fr.ftl
├── app.es.ftl
```

**Configuration (`language-helper.json`):**
```json
{
  "format": "fluent",
  "file_layout": "locales/{file}.{locale}.ftl"
}
```

---

## 4. How the Rust Core Processes Configuration

1. When the VS Code command **"Open Translation Grid"** (`languageHelper.openGrid`) is run, the extension locates `language-helper.json` in the workspace root.
2. The JSON payload is passed to the WebAssembly module function [`parse_config`](file:///projects/workspaces/antigravity/LanguageHelper/crates/core/src/lib.rs#L17).
3. The Rust core deserializes the payload into `ProjectConfig` ([`crates/core/src/config.rs`](file:///projects/workspaces/antigravity/LanguageHelper/crates/core/src/config.rs)) to map out files and populate the grid editor UI.
