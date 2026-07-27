import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Import core wasm logic
const coreWasm = require('../dist/core/core.js');

interface ProjectConfig {
  format: string;
  file_layout: string;
}

interface TranslationItem {
  key: string;
  value: string;
}

interface GridRow {
  file: string;
  key: string;
  translations: { [locale: string]: string };
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Language Helper extension active');

  let disposable = vscode.commands.registerCommand('languageHelper.openGrid', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }
    console.log("Workspace: ", workspaceFolders);

    const rootUri = workspaceFolders[0].uri;
    const configUri = vscode.Uri.joinPath(rootUri, 'language-helper.json');

    let config: ProjectConfig;
    try {
      const configBytes = await vscode.workspace.fs.readFile(configUri);
      const configStr = Buffer.from(configBytes).toString('utf8');
      const parsedConfigJson = coreWasm.parse_config(configStr);
      config = JSON.parse(parsedConfigJson);
    } catch (e) {
      vscode.window.showErrorMessage('Failed to read or parse language-helper.json: ' + String(e));
      return;
    }
    console.log("config: ", config);

    const panel = vscode.window.createWebviewPanel(
      'languageHelperGrid',
      'Translation Grid',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const cleanLayout = config.file_layout.replace(/^\.\//, '').replace(/\\/g, '/');
    console.log("config.file_layout: ", config.file_layout, " cleanLayout: ", cleanLayout);
    // Convert file_layout to glob pattern (e.g. translations/locales/{locale}/{file}.ftl -> translations/locales/*/*.ftl)
    const globPattern = cleanLayout
      .replace('{locale}', '*')
      .replace('{file}', '*');

    const files = await vscode.workspace.findFiles(globPattern);
    console.log("Found files count: ", files.length);

    // Parse layout regex to extract locale and file basename
    // e.g. "translations/locales/{locale}/{file}.ftl" -> /^translations\/locales\/([^/]+)\/(.+)\.ftl$/
    const layoutRegexStr = '^' + cleanLayout
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace('\\{locale\\}', '([^/]+)')
      .replace('\\{file\\}', '(.+)') + '$';
    const layoutRegex = new RegExp(layoutRegexStr);

    const gridMap: Map<string, GridRow> = new Map();
    const localesSet: Set<string> = new Set();
    const rawFileContents: Map<string, string> = new Map(); // relativePath -> content

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/\\/g, '/').replace(/^\.\//, '');
      console.log("relativePath: ", relativePath);
      const match = relativePath.match(layoutRegex);
      if (!match) {
        console.log("No match for relativePath:", relativePath, "with regex:", layoutRegexStr);
        continue;
      }

      const locale = match[1];
      const fileBasename = match[2];
      localesSet.add(locale);

      const fileBytes = await vscode.workspace.fs.readFile(fileUri);
      const fileContent = Buffer.from(fileBytes).toString('utf8');
      rawFileContents.set(relativePath, fileContent);

      const parsedJson = coreWasm.parse_format(config.format, fileContent);
      console.log(`parse_format result for ${relativePath}:`, parsedJson);
      const parsed: { items?: TranslationItem[], error?: string } = JSON.parse(parsedJson);

      if (parsed.error) {
        console.error(`Error parsing ${relativePath}: ${parsed.error}`);
        vscode.window.showWarningMessage(`Error parsing ${relativePath}: ${parsed.error}`);
      }

      if (parsed.items) {
        console.log(`Parsed ${parsed.items.length} items from ${relativePath}`);
        for (const item of parsed.items) {
          const rowKey = `${fileBasename}:::${item.key}`;
          let row = gridMap.get(rowKey);
          if (!row) {
            row = { file: fileBasename, key: item.key, translations: {} };
            gridMap.set(rowKey, row);
          }
          row.translations[locale] = item.value;
        }
      }
    }

    const locales = Array.from(localesSet).sort();
    let rows = Array.from(gridMap.values());
    console.log(`Loaded ${rows.length} rows across ${locales.length} locales:`, locales);

    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, {
      locales,
      rows
    });

    // Set to track modified relative file paths or rows being saved internally
    let isSavingInternal = false;

    // File watcher for external changes
    const relGlob = new vscode.RelativePattern(rootUri, globPattern);
    const watcher = vscode.workspace.createFileSystemWatcher(relGlob);

    const reloadExternalChanges = async (changedUri: vscode.Uri) => {
      if (isSavingInternal) return;

      const relativePath = vscode.workspace.asRelativePath(changedUri, false);
      const match = relativePath.match(layoutRegex);
      if (!match) return;

      const locale = match[1];
      const fileBasename = match[2];

      try {
        const fileBytes = await vscode.workspace.fs.readFile(changedUri);
        const fileContent = Buffer.from(fileBytes).toString('utf8');

        // Check if content actually changed
        const oldContent = rawFileContents.get(relativePath);
        if (oldContent === fileContent) return;

        const parsedJson = coreWasm.parse_format(config.format, fileContent);
        const parsed: { items?: TranslationItem[], error?: string } = JSON.parse(parsedJson);

        if (parsed.items) {
          panel.webview.postMessage({
            command: 'externalFileChanged',
            file: fileBasename,
            locale,
            relativePath,
            items: parsed.items,
            fileContent
          });
        }
      } catch (e) {
        console.error("Error reloading external changes:", e);
      }
    };

    watcher.onDidChange(reloadExternalChanges, undefined, context.subscriptions);
    watcher.onDidCreate(reloadExternalChanges, undefined, context.subscriptions);
    panel.onDidDispose(() => watcher.dispose(), null, context.subscriptions);

    // Handle messages from Webview (Save & Add Module & Update Raw Content)
    panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'createModule') {
        const moduleName = message.moduleName;
        if (!moduleName) return;

        isSavingInternal = true;
        try {
          for (const locale of locales) {
            const relPath = config.file_layout
              .replace('{locale}', locale)
              .replace('{file}', moduleName);
            const fileUri = vscode.Uri.joinPath(rootUri, relPath);

            try {
              await vscode.workspace.fs.stat(fileUri);
            } catch {
              // File doesn't exist, create empty file
              await vscode.workspace.fs.writeFile(fileUri, Buffer.from('', 'utf8'));
              rawFileContents.set(relPath, '');
            }
          }

          // Re-scan files to include newly created files in files array
          const newFiles = await vscode.workspace.findFiles(globPattern);
          files.length = 0;
          files.push(...newFiles);

          vscode.window.showInformationMessage(`Created module '${moduleName}' across all locales.`);
        } catch (e) {
          vscode.window.showErrorMessage(`Failed to create module '${moduleName}': ` + String(e));
        } finally {
          isSavingInternal = false;
        }
      } else if (message.command === 'updateRawFileContent') {
        if (message.relativePath && message.fileContent !== undefined) {
          rawFileContents.set(message.relativePath, message.fileContent);
        }
      } else if (message.command === 'save') {
        const updatedRows: GridRow[] = message.rows;
        isSavingInternal = true;
        try {
          for (const locale of locales) {
            // Gather set of all target basenames from rows & files
            const moduleNames = new Set<string>();
            for (const row of updatedRows) moduleNames.add(row.file);

            for (const moduleName of moduleNames) {
              const relPath = config.file_layout
                .replace('{locale}', locale)
                .replace('{file}', moduleName);
              const fileUri = vscode.Uri.joinPath(rootUri, relPath);

              const originalContent = rawFileContents.get(relPath) || '';
              const fileItems: TranslationItem[] = [];

              for (const row of updatedRows) {
                if (row.file === moduleName && row.translations[locale] !== undefined) {
                  fileItems.push({ key: row.key, value: row.translations[locale] });
                }
              }

              const updatedContent = coreWasm.serialize_format(
                config.format,
                JSON.stringify(fileItems),
                originalContent
              );

              await vscode.workspace.fs.writeFile(
                fileUri,
                Buffer.from(updatedContent, 'utf8')
              );
              rawFileContents.set(relPath, updatedContent);
            }
          }
          rows = updatedRows;
          vscode.window.showInformationMessage('Translations saved successfully!');
        } catch (err) {
          vscode.window.showErrorMessage('Error saving translations: ' + String(err));
        } finally {
          isSavingInternal = false;
        }
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(disposable);
}

function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialData: { locales: string[]; rows: GridRow[] }
) {
  const dataJson = JSON.stringify(initialData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Translation Grid</title>
    <style>
        body {
            font-family: var(--vscode-font-family, sans-serif);
            padding: 16px;
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        .title-container {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        h1 { margin: 0; font-size: 1.2rem; }
        .subtitle {
            font-size: 0.75rem;
            color: var(--vscode-descriptionForeground, #888);
            font-weight: 500;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        .btn {
            border: none;
            padding: 6px 14px;
            font-size: 0.9rem;
            cursor: pointer;
            border-radius: 2px;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground, #444);
            color: var(--vscode-button-secondaryForeground, #fff);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, #555);
        }
        .btn-danger {
            background-color: var(--vscode-errorForeground, #d9534f);
            color: #fff;
        }
        .btn-danger:hover {
            opacity: 0.9;
        }
        .btn-danger:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .search-box {
            width: 100%;
            margin-bottom: 12px;
            padding: 6px 10px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            box-sizing: border-box;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
        }
        th, td {
            border: 1px solid var(--vscode-widget-border, #444);
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: var(--vscode-editor-lineHighlightBackground, #2d2d2d);
            font-weight: 600;
        }
        tr {
            cursor: pointer;
        }
        tr.row-modified {
            background-color: rgba(234, 179, 8, 0.15) !important;
        }
        tr.row-added {
            background-color: rgba(34, 197, 94, 0.15) !important;
        }
        tr.selected {
            background-color: var(--vscode-list-activeSelectionBackground, #04395e) !important;
            color: var(--vscode-list-activeSelectionForeground, #ffffff) !important;
        }
        tr:hover:not(.selected) {
            background-color: var(--vscode-list-hoverBackground, #2a2d2e);
        }
        td input[type="text"] {
            width: 100%;
            background: transparent;
            color: inherit;
            border: none;
            outline: none;
            font-family: inherit;
            font-size: inherit;
        }
        td input[type="text"]:focus {
            background: var(--vscode-input-background);
        }
        .col-select { width: 35px; text-align: center; }
        .col-file { width: 15%; font-weight: 500; }
        .col-key { width: 20%; font-weight: 500; }
        .col-status { width: 90px; text-align: center; }
        .col-actions { width: 60px; text-align: center; }
        .badge {
            display: inline-block;
            padding: 2px 6px;
            font-size: 0.75rem;
            font-weight: 600;
            border-radius: 4px;
            text-transform: uppercase;
        }
        .badge-saved {
            background-color: rgba(100, 116, 139, 0.2);
            color: #94a3b8;
            border: 1px solid #64748b;
        }
        .badge-modified {
            background-color: rgba(234, 179, 8, 0.25);
            color: #fde047;
            border: 1px solid #eab308;
        }
        .badge-added {
            background-color: rgba(34, 197, 94, 0.25);
            color: #4ade80;
            border: 1px solid #22c55e;
        }
        .unsaved-banner {
            display: none;
            background-color: var(--vscode-statusBarItem-warningBackground, #b45309);
            color: var(--vscode-statusBarItem-warningForeground, #ffffff);
            padding: 8px 12px;
            border-radius: 4px;
            font-weight: 600;
            font-size: 0.85rem;
            margin-bottom: 12px;
            align-items: center;
            justify-content: space-between;
        }
        .unsaved-banner.show {
            display: flex;
        }
        .btn-row-action {
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 2px 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            border-radius: 3px;
            color: var(--vscode-icon-foreground, #cccccc);
            box-sizing: border-box;
            vertical-align: middle;
        }
        .btn-row-action:hover {
            background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        }
        .btn-row-action.edit {
            color: var(--vscode-button-background, #007acc);
            margin-right: 4px;
        }
        .btn-row-action.edit:hover {
            color: var(--vscode-button-hoverBackground, #005999);
        }
        .btn-row-action.delete {
            color: var(--vscode-errorForeground, #f48771);
        }
        .btn-row-action.delete:hover {
            color: #ff4d4d;
        }
        .btn-row-action svg {
            width: 15px;
            height: 15px;
            fill: currentColor;
            pointer-events: none;
        }
        /* Modal dialog styling */
        .modal-backdrop {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            justify-content: center;
            align-items: center;
            z-index: 1000;
        }
        .modal-backdrop.show {
            display: flex;
        }
        .modal {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border, #444);
            padding: 20px;
            border-radius: 4px;
            width: 420px;
            max-width: 90%;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        }
        .modal h2 { margin-top: 0; font-size: 1.1rem; }
        .form-group {
            margin-bottom: 12px;
        }
        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-size: 0.85rem;
            font-weight: 600;
        }
        .form-group input, .form-group select {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            box-sizing: border-box;
        }
        .select-box {
            padding: 6px 10px;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border));
            border-radius: 2px;
            font-size: 0.9rem;
            outline: none;
        }
        .pagination-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 12px;
            padding: 8px 0;
            border-top: 1px solid var(--vscode-widget-border, #444);
        }
        .pagination-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .pagination-info {
            font-size: 0.85rem;
            color: var(--vscode-descriptionForeground);
        }
        .modal-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 16px;
        }
    </style>
</head>
<body>
    <div id="unsavedBanner" class="unsaved-banner">
        <span>⚠️ Unsaved Changes (You have modifications or newly added translations)</span>
    </div>
    <div class="header">
        <div class="title-container">
            <h1>Translation Editor</h1>
            <span class="subtitle">made by Aleksandar Kolev @ 2026 v.1.0.0</span>
            <span class="powered-by" style="font-size: 0.7rem; color: var(--vscode-descriptionForeground);">powered by LogoMech</span>
        </div>
        <div class="toolbar">
            <select id="statusFilterSelect" class="select-box">
                <option value="">All Statuses</option>
                <option value="unsaved">All Unsaved Changes</option>
                <option value="modified">Modified Items</option>
                <option value="new">New Items</option>
            </select>
            <button class="btn btn-secondary" id="addRowBtn">+ Add Translation</button>
            <button class="btn btn-secondary" id="bulkMoveBtn" disabled>Move to Module</button>
            <button class="btn btn-danger" id="deleteSelectedBtn" disabled>Delete Selected</button>
            <button class="btn btn-primary" id="saveBtn">Save Changes</button>
        </div>
    </div>
    <input type="text" id="searchInput" class="search-box" placeholder="Filter by key or translation..." />

    <table>
        <thead>
            <tr id="headerRow">
                <th class="col-select"><input type="checkbox" id="selectAllCheckbox" title="Select All Visible" /></th>
                <th class="col-file">File</th>
                <th class="col-key">Key</th>
            </tr>
        </thead>
        <tbody id="tableBody"></tbody>
    </table>

    <div class="pagination-container">
        <div class="pagination-info" id="paginationInfo">Showing 0 of 0 items</div>
        <div class="pagination-controls">
            <label style="font-size: 0.85rem; font-weight: 600;">Module:</label>
            <select id="moduleFilterSelect" class="select-box">
                <option value="">All Modules (Files)</option>
            </select>
            <button class="btn btn-secondary" id="addModuleBtn" style="padding: 4px 8px; font-size: 0.85rem;">+ Add Module</button>

            <span style="margin: 0 4px; border-left: 1px solid var(--vscode-widget-border, #444); height: 16px;"></span>

            <label style="font-size: 0.85rem;">Items per page:</label>
            <select id="pageSizeSelect" class="select-box">
                <option value="25">25</option>
                <option value="50" selected>50</option>
                <option value="100">100</option>
                <option value="250">250</option>
                <option value="all">All</option>
            </select>
            <button class="btn btn-secondary" id="prevPageBtn" disabled>&laquo; Prev</button>
            <span id="pageIndicator" style="font-size: 0.85rem; font-weight: 600;">Page 1 of 1</span>
            <button class="btn btn-secondary" id="nextPageBtn" disabled>Next &raquo;</button>
        </div>
    </div>

    <!-- Add Translation Modal -->
    <div class="modal-backdrop" id="addModal">
        <div class="modal">
            <h2>Add New Translation</h2>
            <div class="form-group">
                <label for="newFile">Module (File Basename)</label>
                <select id="newFile" class="select-box" style="width: 100%;"></select>
            </div>
            <div class="form-group">
                <label for="newKey">Key</label>
                <input type="text" id="newKey" placeholder="e.g. welcome-message" />
            </div>
            <div id="localeInputsContainer"></div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelAddBtn">Cancel</button>
                <button class="btn btn-primary" id="confirmAddBtn">Add</button>
            </div>
        </div>
    </div>

    <!-- Edit Translation Modal -->
    <div class="modal-backdrop" id="editModal">
        <div class="modal">
            <h2>Edit Translation</h2>
            <div class="form-group">
                <label for="editModuleSelect">Module (File)</label>
                <select id="editModuleSelect" class="select-box" style="width: 100%;"></select>
            </div>
            <div class="form-group">
                <label for="editKey">Key</label>
                <input type="text" id="editKey" />
            </div>
            <div id="editLocaleInputsContainer"></div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelEditBtn">Cancel</button>
                <button class="btn btn-primary" id="confirmEditBtn">Update</button>
            </div>
        </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <div class="modal-backdrop" id="deleteConfirmModal">
        <div class="modal">
            <h2>Confirm Deletion</h2>
            <p id="deleteConfirmMessage" style="font-size: 0.9rem; margin: 14px 0; color: var(--vscode-editor-foreground); line-height: 1.4;"></p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelDeleteBtn">Cancel</button>
                <button class="btn btn-danger" id="confirmDeleteBtn">Delete</button>
            </div>
        </div>
    </div>

    <!-- Conflict Resolution Modal -->
    <div class="modal-backdrop" id="conflictModal">
        <div class="modal" style="width: 680px; max-width: 95%;">
            <h2>Conflict Detected in Translation File</h2>
            <p id="conflictModalDesc" style="font-size: 0.85rem; color: var(--vscode-descriptionForeground); margin-bottom: 12px; line-height: 1.4;"></p>
            <div style="max-height: 320px; overflow-y: auto; border: 1px solid var(--vscode-widget-border, #444); border-radius: 4px; margin-bottom: 12px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
                    <thead>
                        <tr style="background: var(--vscode-editor-lineHighlightBackground);">
                            <th style="padding: 6px;">Key</th>
                            <th style="padding: 6px;">Locale</th>
                            <th style="padding: 6px;">Local (Unsaved)</th>
                            <th style="padding: 6px;">Disk (Incoming)</th>
                            <th style="padding: 6px;">Resolution</th>
                        </tr>
                    </thead>
                    <tbody id="conflictTableBody"></tbody>
                </table>
            </div>
            <div style="display: flex; gap: 8px; justify-content: space-between; align-items: center;">
                <div>
                    <button class="btn btn-secondary" id="conflictKeepAllLocalBtn" style="padding: 4px 8px; font-size: 0.8rem;">Keep All Local</button>
                    <button class="btn btn-secondary" id="conflictAcceptAllDiskBtn" style="padding: 4px 8px; font-size: 0.8rem;">Accept All Disk</button>
                </div>
                <div class="modal-actions" style="margin-top: 0;">
                    <button class="btn btn-primary" id="confirmConflictResolutionBtn">Apply Resolution</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Bulk Move Modal -->
    <div class="modal-backdrop" id="bulkMoveModal">
        <div class="modal">
            <h2>Move Selected Items to Module</h2>
            <div class="form-group">
                <label for="bulkMoveModuleSelect">Target Module (File)</label>
                <select id="bulkMoveModuleSelect" class="select-box" style="width: 100%;"></select>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelBulkMoveBtn">Cancel</button>
                <button class="btn btn-primary" id="confirmBulkMoveBtn">Move Items</button>
            </div>
        </div>
    </div>

    <!-- Add Module Modal -->
    <div class="modal-backdrop" id="addModuleModal">
        <div class="modal">
            <h2>Add New Module (File)</h2>
            <div class="form-group">
                <label for="newModuleName">Module Name (e.g. auth, settings)</label>
                <input type="text" id="newModuleName" placeholder="e.g. auth" />
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="cancelAddModuleBtn">Cancel</button>
                <button class="btn btn-primary" id="confirmAddModuleBtn">Create Module</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const initialData = ${dataJson};
        let rows = initialData.rows;
        const locales = initialData.locales;

        const headerRow = document.getElementById('headerRow');
        const tableBody = document.getElementById('tableBody');
        const searchInput = document.getElementById('searchInput');
        const moduleFilterSelect = document.getElementById('moduleFilterSelect');
        const saveBtn = document.getElementById('saveBtn');
        const addRowBtn = document.getElementById('addRowBtn');
        const addModuleBtn = document.getElementById('addModuleBtn');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
        const bulkMoveBtn = document.getElementById('bulkMoveBtn');
        const selectAllCheckbox = document.getElementById('selectAllCheckbox');

        const addModal = document.getElementById('addModal');
        const newFile = document.getElementById('newFile');
        const newKey = document.getElementById('newKey');
        const localeInputsContainer = document.getElementById('localeInputsContainer');
        const cancelAddBtn = document.getElementById('cancelAddBtn');
        const confirmAddBtn = document.getElementById('confirmAddBtn');

        const addModuleModal = document.getElementById('addModuleModal');
        const newModuleName = document.getElementById('newModuleName');
        const cancelAddModuleBtn = document.getElementById('cancelAddModuleBtn');
        const confirmAddModuleBtn = document.getElementById('confirmAddModuleBtn');

        const bulkMoveModal = document.getElementById('bulkMoveModal');
        const bulkMoveModuleSelect = document.getElementById('bulkMoveModuleSelect');
        const cancelBulkMoveBtn = document.getElementById('cancelBulkMoveBtn');
        const confirmBulkMoveBtn = document.getElementById('confirmBulkMoveBtn');

        const deleteConfirmModal = document.getElementById('deleteConfirmModal');
        const deleteConfirmMessage = document.getElementById('deleteConfirmMessage');
        const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        let pendingDeleteIndices = [];

        const conflictModal = document.getElementById('conflictModal');
        const conflictModalDesc = document.getElementById('conflictModalDesc');
        const conflictTableBody = document.getElementById('conflictTableBody');
        const conflictKeepAllLocalBtn = document.getElementById('conflictKeepAllLocalBtn');
        const conflictAcceptAllDiskBtn = document.getElementById('conflictAcceptAllDiskBtn');
        const confirmConflictResolutionBtn = document.getElementById('confirmConflictResolutionBtn');
        let currentConflictsData = null;

        const selectedRowIndices = new Set();
        const unsavedEdits = new Map();

        const originalRowsMap = new Map();
        const deletedKeysSet = new Set();
        const newlyAddedKeysSet = new Set();

        rows.forEach(r => {
            originalRowsMap.set(r.file + ":::" + r.key, JSON.stringify(r.translations));
        });

        const unsavedBanner = document.getElementById('unsavedBanner');

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'externalFileChanged') {
                const { file: fileBasename, locale, relativePath, items: incomingItems, fileContent } = message;

                const diskItemsMap = new Map();
                incomingItems.forEach(it => diskItemsMap.set(it.key, it.value));

                let hasUnsaved = false;
                for (const [editKey] of unsavedEdits.entries()) {
                    if (editKey.startsWith(fileBasename + ":::")) {
                        hasUnsaved = true;
                        break;
                    }
                }
                if (!hasUnsaved) {
                    for (const key of newlyAddedKeysSet) {
                        if (key.startsWith(fileBasename + ":::")) {
                            hasUnsaved = true;
                            break;
                        }
                    }
                }
                if (!hasUnsaved) {
                    for (const key of deletedKeysSet) {
                        if (key.startsWith(fileBasename + ":::")) {
                            hasUnsaved = true;
                            break;
                        }
                    }
                }
                if (!hasUnsaved) {
                    for (const row of rows) {
                        if (row.file === fileBasename) {
                            const origJson = originalRowsMap.get(row.file + ":::" + row.key);
                            if (origJson === undefined || origJson !== JSON.stringify(row.translations)) {
                                hasUnsaved = true;
                                break;
                            }
                        }
                    }
                }

                if (!hasUnsaved) {
                    for (const row of rows) {
                        if (row.file === fileBasename) {
                            if (diskItemsMap.has(row.key)) {
                                row.translations[locale] = diskItemsMap.get(row.key);
                                diskItemsMap.delete(row.key);
                            }
                        }
                    }
                    for (const [key, val] of diskItemsMap.entries()) {
                        let row = rows.find(r => r.file === fileBasename && r.key === key);
                        if (!row) {
                            const trans = {};
                            locales.forEach(l => trans[l] = '');
                            trans[locale] = val;
                            row = { file: fileBasename, key, translations: trans };
                            rows.push(row);
                        } else {
                            row.translations[locale] = val;
                        }
                    }
                    rows.forEach(r => {
                        if (r.file === fileBasename) {
                            originalRowsMap.set(r.file + ":::" + r.key, JSON.stringify(r.translations));
                        }
                    });
                    vscode.postMessage({ command: 'updateRawFileContent', relativePath, fileContent });
                    renderTable();
                    return;
                }

                const conflicts = [];
                const processedKeys = new Set();

                rows.forEach(row => {
                    if (row.file === fileBasename) {
                        processedKeys.add(row.key);
                        const localVal = row.translations[locale] || '';
                        const diskVal = diskItemsMap.has(row.key) ? diskItemsMap.get(row.key) : '(Deleted on disk)';

                        if (localVal !== diskVal) {
                            conflicts.push({
                                file: fileBasename,
                                key: row.key,
                                locale,
                                localValue: localVal,
                                diskValue: diskVal,
                                type: diskItemsMap.has(row.key) ? 'modified' : 'deleted_on_disk'
                            });
                        }
                    }
                });

                deletedKeysSet.forEach(delKey => {
                    const parts = delKey.split(':::');
                    if (parts[0] === fileBasename && diskItemsMap.has(parts[1])) {
                        processedKeys.add(parts[1]);
                        conflicts.push({
                            file: fileBasename,
                            key: parts[1],
                            locale,
                            localValue: '(Deleted locally)',
                            diskValue: diskItemsMap.get(parts[1]),
                            type: 'deleted_locally'
                        });
                    }
                });

                for (const [diskKey, diskVal] of diskItemsMap.entries()) {
                    if (!processedKeys.has(diskKey)) {
                        conflicts.push({
                            file: fileBasename,
                            key: diskKey,
                            locale,
                            localValue: '(Not present locally)',
                            diskValue: diskVal,
                            type: 'added_on_disk'
                        });
                    }
                }

                if (conflicts.length > 0) {
                    openConflictModal(conflicts, { fileBasename, locale, relativePath, fileContent, incomingItems });
                } else {
                    vscode.postMessage({ command: 'updateRawFileContent', relativePath, fileContent });
                    renderTable();
                }
            }
        });

        function openConflictModal(conflicts, contextData) {
            currentConflictsData = { conflicts, contextData };
            conflictTableBody.innerHTML = '';
            conflictModalDesc.textContent = "External changes were detected in module \"" + contextData.fileBasename + "\" (" + contextData.locale.toUpperCase() + "), but you have unsaved local changes. Select how to resolve each conflict below:";
            conflicts.forEach((c, i) => {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid var(--vscode-widget-border, #444)';
                const tdKey = document.createElement('td');
                tdKey.style.padding = '6px'; tdKey.style.fontWeight = '600'; tdKey.textContent = c.key;
                const tdLoc = document.createElement('td');
                tdLoc.style.padding = '6px'; tdLoc.textContent = c.locale.toUpperCase();
                const tdLocal = document.createElement('td');
                tdLocal.style.padding = '6px'; tdLocal.style.color = '#fde047'; tdLocal.textContent = c.localValue;
                const tdDisk = document.createElement('td');
                tdDisk.style.padding = '6px'; tdDisk.style.color = '#4ade80'; tdDisk.textContent = c.diskValue;
                const tdRes = document.createElement('td');
                tdRes.style.padding = '6px';
                const select = document.createElement('select');
                select.className = 'select-box conflict-resolution-select';
                select.id = 'conflictSelect_' + i;
                select.style.padding = '4px 6px'; select.style.fontSize = '0.8rem';
                const optLocal = document.createElement('option'); optLocal.value = 'local'; optLocal.textContent = 'Keep Local';
                const optDisk = document.createElement('option'); optDisk.value = 'disk'; optDisk.textContent = 'Accept Disk';
                select.appendChild(optLocal); select.appendChild(optDisk);
                tdRes.appendChild(select);
                tr.appendChild(tdKey); tr.appendChild(tdLoc); tr.appendChild(tdLocal); tr.appendChild(tdDisk); tr.appendChild(tdRes);
                conflictTableBody.appendChild(tr);
            });
            conflictModal.classList.add('show');
        }

        conflictKeepAllLocalBtn.addEventListener('click', () => {
            document.querySelectorAll('.conflict-resolution-select').forEach(s => s.value = 'local');
        });
        conflictAcceptAllDiskBtn.addEventListener('click', () => {
            document.querySelectorAll('.conflict-resolution-select').forEach(s => s.value = 'disk');
        });
        confirmConflictResolutionBtn.addEventListener('click', () => {
            if (!currentConflictsData) return;
            const { conflicts, contextData } = currentConflictsData;
            conflicts.forEach((c, i) => {
                const select = document.getElementById('conflictSelect_' + i);
                const choice = select ? select.value : 'local';
                let row = rows.find(r => r.file === c.file && r.key === c.key);
                if (choice === 'disk') {
                    if (c.type === 'deleted_locally') {
                        deletedKeysSet.delete(c.file + ':::' + c.key);
                        const trans = {};
                        locales.forEach(l => trans[l] = '');
                        trans[c.locale] = c.diskValue;
                        rows.push({ file: c.file, key: c.key, translations: trans });
                    } else if (row) {
                        row.translations[c.locale] = c.diskValue;
                        unsavedEdits.delete(c.file + ':::' + c.key + ':::' + c.locale);
                    }
                } else if (choice === 'local') {
                    if (row && c.type !== 'deleted_locally') {
                        unsavedEdits.set(c.file + ':::' + c.key + ':::' + c.locale, row.translations[c.locale] || '');
                    }
                }
            });
            vscode.postMessage({ command: 'updateRawFileContent', relativePath: contextData.relativePath, fileContent: contextData.fileContent });
            conflictModal.classList.remove('show');
            currentConflictsData = null;
            renderTable();
        });

        function updateUnsavedStatus() {
            let hasUnsavedChanges = deletedKeysSet.size > 0 || newlyAddedKeysSet.size > 0;
            if (!hasUnsavedChanges) {
                for (const row of rows) {
                    const rowKey = row.file + ':::' + row.key;
                    if (newlyAddedKeysSet.has(rowKey)) { hasUnsavedChanges = true; break; }
                    const origJson = originalRowsMap.get(rowKey);
                    if (origJson === undefined || origJson !== JSON.stringify(row.translations)) { hasUnsavedChanges = true; break; }
                }
            }
            if (hasUnsavedChanges) unsavedBanner.classList.add('show');
            else unsavedBanner.classList.remove('show');
        }

        const thStatus = document.createElement('th');
        thStatus.className = 'col-status'; thStatus.textContent = 'Status'; headerRow.appendChild(thStatus);
        locales.forEach(loc => {
            const th = document.createElement('th');
            th.textContent = loc.toUpperCase();
            headerRow.appendChild(th);
        });
        const thActions = document.createElement('th');
        thActions.className = 'col-actions'; thActions.textContent = 'Action'; headerRow.appendChild(thActions);

        locales.forEach(loc => {
            const div = document.createElement('div');
            div.className = 'form-group';
            div.innerHTML = '<label for="newVal_' + loc + '">Translation (' + loc.toUpperCase() + ')</label>' +
                             '<input type="text" id="newVal_' + loc + '" placeholder="Value for ' + loc + '" />';
            localeInputsContainer.appendChild(div);
        });

        function updateModuleSelects() {
            const modules = Array.from(new Set(rows.map(r => r.file))).sort();
            const currentFilter = moduleFilterSelect.value;
            moduleFilterSelect.innerHTML = '<option value="">All Modules (Files)</option>';
            newFile.innerHTML = ''; editModuleSelect.innerHTML = ''; bulkMoveModuleSelect.innerHTML = '';
            modules.forEach(mod => {
                [moduleFilterSelect, newFile, editModuleSelect, bulkMoveModuleSelect].forEach(select => {
                    const opt = document.createElement('option');
                    opt.value = mod; opt.textContent = mod; select.appendChild(opt);
                });
            });
            if (modules.includes(currentFilter)) moduleFilterSelect.value = currentFilter;
        }

        function updateSelectionUI() {
            const count = selectedRowIndices.size;
            deleteSelectedBtn.disabled = count === 0;
            deleteSelectedBtn.textContent = count > 1 ? 'Delete Selected (' + count + ')' : 'Delete Selected';
            bulkMoveBtn.disabled = count === 0;
            bulkMoveBtn.textContent = count > 1 ? 'Move to Module (' + count + ')' : 'Move to Module';
        }

        const editModal = document.getElementById('editModal');
        const editModuleSelect = document.getElementById('editModuleSelect');
        const editKey = document.getElementById('editKey');
        const editLocaleInputsContainer = document.getElementById('editLocaleInputsContainer');
        const cancelEditBtn = document.getElementById('cancelEditBtn');
        const confirmEditBtn = document.getElementById('confirmEditBtn');
        let editingRowIndex = null;

        locales.forEach(loc => {
            const div = document.createElement('div');
            div.className = 'form-group';
            div.innerHTML = '<label for="editVal_' + loc + '">Translation (' + loc.toUpperCase() + ')</label>' +
                             '<input type="text" id="editVal_' + loc + '" placeholder="Value for ' + loc + '" />';
            editLocaleInputsContainer.appendChild(div);
        });

        let currentPage = 1;
        let pageSize = 50;
        const pageSizeSelect = document.getElementById('pageSizeSelect');
        const prevPageBtn = document.getElementById('prevPageBtn');
        const nextPageBtn = document.getElementById('nextPageBtn');
        const pageIndicator = document.getElementById('pageIndicator');
        const paginationInfo = document.getElementById('paginationInfo');

        pageSizeSelect.addEventListener('change', (e) => {
            pageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10);
            currentPage = 1; renderTable();
        });
        prevPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
        nextPageBtn.addEventListener('click', () => { currentPage++; renderTable(); });

        selectAllCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            rows.forEach((r, idx) => {
                if (isChecked) selectedRowIndices.add(idx); else selectedRowIndices.delete(idx);
            });
            renderTable();
        });

        function renderTable(filterText = searchInput.value) {
            tableBody.innerHTML = '';
            const lowerFilter = filterText.toLowerCase();
            const selectedModule = moduleFilterSelect.value;
            const selectedStatus = statusFilterSelect.value;
            updateModuleSelects();
            updateUnsavedStatus();
            const filteredRows = rows.filter(row => {
                if (selectedModule && row.file !== selectedModule) return false;
                const rowKey = row.file + ':::' + row.key;
                const isAdded = newlyAddedKeysSet.has(rowKey);
                const origJson = originalRowsMap.get(rowKey);
                const isModified = !isAdded && (origJson === undefined || origJson !== JSON.stringify(row.translations));
                if (selectedStatus === 'unsaved' && !isAdded && !isModified) return false;
                if (selectedStatus === 'modified' && !isModified) return false;
                if (selectedStatus === 'new' && !isAdded) return false;
                if (filterText) {
                    return row.file.toLowerCase().includes(lowerFilter) || row.key.toLowerCase().includes(lowerFilter) || Object.values(row.translations).some(v => v.toLowerCase().includes(lowerFilter));
                }
                return true;
            });
            const totalItems = filteredRows.length;
            const effectivePageSize = pageSize === 'all' ? totalItems : pageSize;
            const totalPages = effectivePageSize > 0 ? Math.ceil(totalItems / effectivePageSize) || 1 : 1;
            if (currentPage > totalPages) currentPage = totalPages;
            if (currentPage < 1) currentPage = 1;
            const startIndex = (currentPage - 1) * effectivePageSize;
            const endIndex = pageSize === 'all' ? totalItems : Math.min(startIndex + effectivePageSize, totalItems);
            const pageRows = filteredRows.slice(startIndex, endIndex);
            paginationInfo.textContent = 'Showing ' + (totalItems > 0 ? startIndex + 1 : 0) + '-' + endIndex + ' of ' + totalItems + ' items';
            pageIndicator.textContent = 'Page ' + currentPage + ' of ' + totalPages;
            prevPageBtn.disabled = currentPage <= 1; nextPageBtn.disabled = currentPage >= totalPages;
            pageRows.forEach((row) => {
                const globalIndex = rows.indexOf(row);
                const rowKey = row.file + ':::' + row.key;
                const isAdded = newlyAddedKeysSet.has(rowKey);
                const origJson = originalRowsMap.get(rowKey);
                const isModified = !isAdded && (origJson === undefined || origJson !== JSON.stringify(row.translations));
                const isSelected = selectedRowIndices.has(globalIndex);
                const tr = document.createElement('tr');
                if (isSelected) tr.classList.add('selected'); else if (isAdded) tr.classList.add('row-added'); else if (isModified) tr.classList.add('row-modified');
                tr.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.closest('button')) return;
                    if (isSelected) selectedRowIndices.delete(globalIndex); else selectedRowIndices.add(globalIndex);
                    renderTable(searchInput.value);
                });
                const tdSelect = document.createElement('td'); tdSelect.className = 'col-select';
                const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isSelected;
                cb.addEventListener('change', (e) => { e.stopPropagation(); if (e.target.checked) selectedRowIndices.add(globalIndex); else selectedRowIndices.delete(globalIndex); renderTable(searchInput.value); });
                tdSelect.appendChild(cb); tr.appendChild(tdSelect);
                const tdFile = document.createElement('td'); tdFile.textContent = row.file; tdFile.className = 'col-file'; tr.appendChild(tdFile);
                const tdKey = document.createElement('td'); tdKey.textContent = row.key; tdKey.className = 'col-key'; tr.appendChild(tdKey);
                const tdStatus = document.createElement('td'); tdStatus.className = 'col-status';
                const spanBadge = document.createElement('span');
                spanBadge.className = 'badge ' + (isAdded ? 'badge-added' : isModified ? 'badge-modified' : 'badge-saved');
                spanBadge.textContent = isAdded ? 'New' : isModified ? 'Modified' : 'Saved';
                tdStatus.appendChild(spanBadge); tr.appendChild(tdStatus);
                locales.forEach(loc => {
                    const td = document.createElement('td');
                    const input = document.createElement('input'); input.type = 'text'; input.value = row.translations[loc] || '';
                    input.addEventListener('input', (e) => {
                        const newVal = e.target.value; row.translations[loc] = newVal; unsavedEdits.set(row.file + ':::' + row.key + ':::' + loc, newVal);
                        renderTable(searchInput.value);
                    });
                    td.appendChild(input); tr.appendChild(td);
                });
                const tdActions = document.createElement('td'); tdActions.className = 'col-actions';
                const editBtn = document.createElement('button'); editBtn.className = 'btn-row-action edit'; editBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M12.854.146a.5.5 0 0 0-.707 0L10.5 1.793 14.207 5.5l1.647-1.646a.5.5 0 0 0 0-.708l-3-3zm.646 6.061L9.793 2.5 2 10.293V14h3.707l7.793-7.793zM1 15v-1h14v1H1z"/></svg>';
                editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(globalIndex); });
                tdActions.appendChild(editBtn);
                const delBtn = document.createElement('button'); delBtn.className = 'btn-row-action delete'; delBtn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>';
                delBtn.addEventListener('click', (e) => { e.stopPropagation(); promptDeleteRows([globalIndex]); });
                tdActions.appendChild(delBtn); tr.appendChild(tdActions); tableBody.appendChild(tr);
            });
            updateSelectionUI();
        }

        function openEditModal(index) {
            editingRowIndex = index; const row = rows[index];
            editModuleSelect.value = row.file; editKey.value = row.key;
            locales.forEach(loc => { document.getElementById('editVal_' + loc).value = row.translations[loc] || ''; });
            editModal.classList.add('show');
        }
        cancelEditBtn.addEventListener('click', () => { editModal.classList.remove('show'); });
        confirmEditBtn.addEventListener('click', () => {
            const row = rows[editingRowIndex]; row.file = editModuleSelect.value; row.key = editKey.value.trim();
            locales.forEach(loc => { row.translations[loc] = document.getElementById('editVal_' + loc).value; });
            editModal.classList.remove('show'); renderTable();
        });

        function promptDeleteRows(indices) {
            pendingDeleteIndices = indices;
            deleteConfirmMessage.textContent = indices.length === 1 ? 'Are you sure you want to delete translation key "' + rows[indices[0]].key + '"?' : 'Are you sure you want to delete ' + indices.length + ' items?';
            deleteConfirmModal.classList.add('show');
        }
        cancelDeleteBtn.addEventListener('click', () => { deleteConfirmModal.classList.remove('show'); });
        confirmDeleteBtn.addEventListener('click', () => { executeDeleteRows(pendingDeleteIndices); deleteConfirmModal.classList.remove('show'); });
        function executeDeleteRows(indices) {
            indices.sort((a,b) => b-a).forEach(idx => {
                const row = rows[idx]; deletedKeysSet.add(row.file + ':::' + row.key); newlyAddedKeysSet.delete(row.file + ':::' + row.key);
                rows.splice(idx, 1);
            });
            selectedRowIndices.clear(); renderTable();
        }
        deleteSelectedBtn.addEventListener('click', () => { if (selectedRowIndices.size > 0) promptDeleteRows(Array.from(selectedRowIndices)); });
        bulkMoveBtn.addEventListener('click', () => { bulkMoveModal.classList.add('show'); });
        cancelBulkMoveBtn.addEventListener('click', () => { bulkMoveModal.classList.remove('show'); });
        confirmBulkMoveBtn.addEventListener('click', () => {
            selectedRowIndices.forEach(idx => { rows[idx].file = bulkMoveModuleSelect.value; });
            bulkMoveModal.classList.remove('show'); selectedRowIndices.clear(); renderTable();
        });
        addModuleBtn.addEventListener('click', () => { addModuleModal.classList.add('show'); });
        cancelAddModuleBtn.addEventListener('click', () => { addModuleModal.classList.remove('show'); });
        confirmAddModuleBtn.addEventListener('click', () => {
            const mod = newModuleName.value.trim();
            if (mod) { vscode.postMessage({ command: 'createModule', moduleName: mod }); newlyAddedKeysSet.add(mod + ':::new_key'); rows.push({ file: mod, key: 'new_key', translations: Object.fromEntries(locales.map(l => [l, ''])) }); }
            addModuleModal.classList.remove('show'); renderTable();
        });
        addRowBtn.addEventListener('click', () => { addModal.classList.add('show'); });
        cancelAddBtn.addEventListener('click', () => { addModal.classList.remove('show'); });
        confirmAddBtn.addEventListener('click', () => {
            const trans = {}; locales.forEach(l => trans[l] = document.getElementById('newVal_' + l).value);
            rows.push({ file: newFile.value, key: newKey.value, translations: trans });
            newlyAddedKeysSet.add(newFile.value + ':::' + newKey.value);
            addModal.classList.remove('show'); renderTable();
        });
        [statusFilterSelect, moduleFilterSelect].forEach(s => s.addEventListener('change', () => { currentPage = 1; renderTable(); }));
        searchInput.addEventListener('input', (e) => { currentPage = 1; renderTable(e.target.value); });
        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'save', rows });
            deletedKeysSet.clear(); newlyAddedKeysSet.clear(); unsavedEdits.clear();
            rows.forEach(r => originalRowsMap.set(r.file + ':::' + r.key, JSON.stringify(r.translations)));
            renderTable();
        });
        renderTable();
    </script>
</body>
</html>`;
}

export function deactivate() { }
