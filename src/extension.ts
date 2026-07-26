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

        console.log("config.file_layout: ", config.file_layout);
        // Convert file_layout to glob pattern (e.g. translations/locales/{locale}/{file}.ftl -> translations/locales/*/*.ftl)
        const globPattern = config.file_layout
            .replace('{locale}', '*')
            .replace('{file}', '*');

        const files = await vscode.workspace.findFiles(globPattern);

        // Parse layout regex to extract locale and file basename
        // e.g. "translations/locales/{locale}/{file}.ftl" -> /^translations\/locales\/([^/]+)\/(.+)\.ftl$/
        const layoutRegexStr = '^' + config.file_layout
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace('\\{locale\\}', '([^/]+)')
            .replace('\\{file\\}', '(.+)') + '$';
        const layoutRegex = new RegExp(layoutRegexStr);

        const gridMap: Map<string, GridRow> = new Map();
        const localesSet: Set<string> = new Set();
        const rawFileContents: Map<string, string> = new Map(); // relativePath -> content

        for (const fileUri of files) {
            const relativePath = vscode.workspace.asRelativePath(fileUri, false);
            console.log("relativePath: ", relativePath);
            const match = relativePath.match(layoutRegex);
            if (!match) continue;

            const locale = match[1];
            const fileBasename = match[2];
            localesSet.add(locale);

            const fileBytes = await vscode.workspace.fs.readFile(fileUri);
            const fileContent = Buffer.from(fileBytes).toString('utf8');
            rawFileContents.set(relativePath, fileContent);

            const parsedJson = coreWasm.parse_format(config.format, fileContent);
            const parsed: { items?: TranslationItem[], error?: string } = JSON.parse(parsedJson);

            if (parsed.items) {
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

                rawFileContents.set(relativePath, fileContent);

                const parsedJson = coreWasm.parse_format(config.format, fileContent);
                const parsed: { items?: TranslationItem[], error?: string } = JSON.parse(parsedJson);

                if (parsed.items) {
                    const newItemsMap = new Map<string, string>();
                    for (const item of parsed.items) {
                        newItemsMap.set(item.key, item.value);
                    }

                    // Update existing gridMap
                    for (const row of rows) {
                        if (row.file === fileBasename) {
                            if (newItemsMap.has(row.key)) {
                                row.translations[locale] = newItemsMap.get(row.key)!;
                                newItemsMap.delete(row.key);
                            }
                        }
                    }

                    // Add new items from external file
                    for (const [key, val] of newItemsMap.entries()) {
                        let row = rows.find(r => r.file === fileBasename && r.key === key);
                        if (!row) {
                            row = { file: fileBasename, key, translations: {} };
                            rows.push(row);
                        }
                        row.translations[locale] = val;
                    }
                }

                vscode.window.showInformationMessage(`Reloaded external changes in ${relativePath}`);

                // Send message to webview to reload grid data while preserving webview's unsaved map
                panel.webview.postMessage({
                    command: 'externalReload',
                    locales,
                    rows
                });
            } catch (e) {
                console.error("Error reloading external changes:", e);
            }
        };

        watcher.onDidChange(reloadExternalChanges, undefined, context.subscriptions);
        watcher.onDidCreate(reloadExternalChanges, undefined, context.subscriptions);
        panel.onDidDispose(() => watcher.dispose(), null, context.subscriptions);

        // Handle messages from Webview (Save & Add Module)
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
        .toolbar {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        h1 { margin: 0; font-size: 1.2rem; }
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
        td input {
            width: 100%;
            background: transparent;
            color: inherit;
            border: none;
            outline: none;
            font-family: inherit;
            font-size: inherit;
        }
        td input:focus {
            background: var(--vscode-input-background);
        }
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
        .btn-delete-row {
            background: transparent;
            border: none;
            color: var(--vscode-errorForeground, #f48771);
            cursor: pointer;
            font-weight: bold;
            font-size: 1.1rem;
        }
        .btn-delete-row:hover {
            color: #ff0000;
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
        <h1>Translation Editor</h1>
        <div class="toolbar">
            <select id="statusFilterSelect" class="select-box">
                <option value="">All Statuses</option>
                <option value="unsaved">All Unsaved Changes</option>
                <option value="modified">Modified Items</option>
                <option value="new">New Items</option>
            </select>
            <button class="btn btn-secondary" id="addRowBtn">+ Add Translation</button>
            <button class="btn btn-danger" id="deleteSelectedBtn" disabled>Delete Selected</button>
            <button class="btn btn-primary" id="saveBtn">Save Changes</button>
        </div>
    </div>
    <input type="text" id="searchInput" class="search-box" placeholder="Filter by key or translation..." />

    <table>
        <thead>
            <tr id="headerRow">
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

        let selectedRowIndex = null;

        // Map to track user's unsaved edits: key is \`\${row.file}:::\${row.key}:::\${loc}\` -> editedValue
        const unsavedEdits = new Map();

        // Listen for messages from extension host (e.g., external file reloads)
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'externalReload') {
                const freshRows = message.rows;

                // Merge reloaded rows with current unsaved edits map
                freshRows.forEach(freshRow => {
                    locales.forEach(loc => {
                        const editKey = \`\${freshRow.file}:::\${freshRow.key}:::\${loc}\`;
                        if (unsavedEdits.has(editKey)) {
                            freshRow.translations[loc] = unsavedEdits.get(editKey);
                        }
                    });
                });

                // Add any newly added unsaved rows that might not exist in external files yet
                rows.forEach(r => {
                    const existsInFresh = freshRows.some(fr => fr.file === r.file && fr.key === r.key);
                    if (!existsInFresh) {
                        freshRows.push(r);
                    }
                });

                rows = freshRows;
                renderTable();
            }
        });

        // Track original snapshot of initial rows for change tracking
        const originalRowsMap = new Map();
        const deletedKeysSet = new Set();
        const newlyAddedKeysSet = new Set();

        rows.forEach(r => {
            originalRowsMap.set(\`\${r.file}:::\${r.key}\`, JSON.stringify(r.translations));
        });

        const unsavedBanner = document.getElementById('unsavedBanner');

        function updateUnsavedStatus() {
            let hasUnsavedChanges = deletedKeysSet.size > 0 || newlyAddedKeysSet.size > 0;
            
            if (!hasUnsavedChanges) {
                for (const row of rows) {
                    const rowKey = \`\${row.file}:::\${row.key}\`;
                    if (newlyAddedKeysSet.has(rowKey)) {
                        hasUnsavedChanges = true;
                        break;
                    }
                    const origJson = originalRowsMap.get(rowKey);
                    if (origJson === undefined || origJson !== JSON.stringify(row.translations)) {
                        hasUnsavedChanges = true;
                        break;
                    }
                }
            }

            if (hasUnsavedChanges) {
                unsavedBanner.classList.add('show');
            } else {
                unsavedBanner.classList.remove('show');
            }
        }

        // Add Status header before Locales
        const thStatus = document.createElement('th');
        thStatus.className = 'col-status';
        thStatus.textContent = 'Status';
        headerRow.appendChild(thStatus);

        // Add locale headers
        locales.forEach(loc => {
            const th = document.createElement('th');
            th.textContent = loc.toUpperCase();
            headerRow.appendChild(th);
        });
        const thActions = document.createElement('th');
        thActions.className = 'col-actions';
        thActions.textContent = 'Action';
        headerRow.appendChild(thActions);

        // Build inputs in modal for all locales
        locales.forEach(loc => {
            const div = document.createElement('div');
            div.className = 'form-group';
            div.innerHTML = \`<label for="newVal_\${loc}">Translation (\${loc.toUpperCase()})</label>
                             <input type="text" id="newVal_\${loc}" placeholder="Value for \${loc}" />\`;
            localeInputsContainer.appendChild(div);
        });

        function updateModuleSelects() {
            const modules = Array.from(new Set(rows.map(r => r.file))).sort();
            const currentFilter = moduleFilterSelect.value;
            
            moduleFilterSelect.innerHTML = '<option value="">All Modules (Files)</option>';
            newFile.innerHTML = '';

            modules.forEach(mod => {
                const opt1 = document.createElement('option');
                opt1.value = mod;
                opt1.textContent = mod;
                moduleFilterSelect.appendChild(opt1);

                const opt2 = document.createElement('option');
                opt2.value = mod;
                opt2.textContent = mod;
                newFile.appendChild(opt2);
            });

            if (modules.includes(currentFilter)) {
                moduleFilterSelect.value = currentFilter;
            }
        }

        function updateSelectionUI() {
            deleteSelectedBtn.disabled = selectedRowIndex === null;
        }

        const statusFilterSelect = document.getElementById('statusFilterSelect');
        const editModal = document.getElementById('editModal');
        const editModuleSelect = document.getElementById('editModuleSelect');
        const editKey = document.getElementById('editKey');
        const editLocaleInputsContainer = document.getElementById('editLocaleInputsContainer');
        const cancelEditBtn = document.getElementById('cancelEditBtn');
        const confirmEditBtn = document.getElementById('confirmEditBtn');

        let editingRowIndex = null;

        // Build inputs in edit modal for all locales
        locales.forEach(loc => {
            const div = document.createElement('div');
            div.className = 'form-group';
            div.innerHTML = \`<label for="editVal_\${loc}">Translation (\${loc.toUpperCase()})</label>
                             <input type="text" id="editVal_\${loc}" placeholder="Value for \${loc}" />\`;
            editLocaleInputsContainer.appendChild(div);
        });

        function updateModuleSelects() {
            const modules = Array.from(new Set(rows.map(r => r.file))).sort();
            const currentFilter = moduleFilterSelect.value;
            
            moduleFilterSelect.innerHTML = '<option value="">All Modules (Files)</option>';
            newFile.innerHTML = '';
            editModuleSelect.innerHTML = '';

            modules.forEach(mod => {
                const opt1 = document.createElement('option');
                opt1.value = mod;
                opt1.textContent = mod;
                moduleFilterSelect.appendChild(opt1);

                const opt2 = document.createElement('option');
                opt2.value = mod;
                opt2.textContent = mod;
                newFile.appendChild(opt2);

                const opt3 = document.createElement('option');
                opt3.value = mod;
                opt3.textContent = mod;
                editModuleSelect.appendChild(opt3);
            });

            if (modules.includes(currentFilter)) {
                moduleFilterSelect.value = currentFilter;
            }
        }

        function updateSelectionUI() {
            deleteSelectedBtn.disabled = selectedRowIndex === null;
        }

        let currentPage = 1;
        let pageSize = 50;

        const pageSizeSelect = document.getElementById('pageSizeSelect');
        const prevPageBtn = document.getElementById('prevPageBtn');
        const nextPageBtn = document.getElementById('nextPageBtn');
        const pageIndicator = document.getElementById('pageIndicator');
        const paginationInfo = document.getElementById('paginationInfo');

        pageSizeSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            pageSize = val === 'all' ? 'all' : parseInt(val, 10);
            currentPage = 1;
            renderTable();
        });

        prevPageBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        });

        nextPageBtn.addEventListener('click', () => {
            currentPage++;
            renderTable();
        });

        function renderTable(filterText = searchInput.value) {
            tableBody.innerHTML = '';
            const lowerFilter = filterText.toLowerCase();
            const selectedModule = moduleFilterSelect.value;
            const selectedStatus = statusFilterSelect.value;

            updateModuleSelects();
            updateUnsavedStatus();

            // Filter rows based on search, module, and status
            const filteredRows = rows.filter(row => {
                if (selectedModule && row.file !== selectedModule) return false;
                
                const rowKey = \`\${row.file}:::\${row.key}\`;
                const isAdded = newlyAddedKeysSet.has(rowKey);
                const origJson = originalRowsMap.get(rowKey);
                const isModified = !isAdded && (origJson === undefined || origJson !== JSON.stringify(row.translations));

                if (selectedStatus === 'unsaved' && !isAdded && !isModified) return false;
                if (selectedStatus === 'modified' && !isModified) return false;
                if (selectedStatus === 'new' && !isAdded) return false;

                if (filterText) {
                    const matchesFile = row.file.toLowerCase().includes(lowerFilter);
                    const matchesKey = row.key.toLowerCase().includes(lowerFilter);
                    const matchesTrans = Object.values(row.translations).some(v => v.toLowerCase().includes(lowerFilter));
                    if (!matchesFile && !matchesKey && !matchesTrans) return false;
                }
                return true;
            });

            // Calculate pagination bounds
            const totalItems = filteredRows.length;
            const effectivePageSize = pageSize === 'all' ? totalItems : pageSize;
            const totalPages = effectivePageSize > 0 ? Math.ceil(totalItems / effectivePageSize) || 1 : 1;

            if (currentPage > totalPages) currentPage = totalPages;
            if (currentPage < 1) currentPage = 1;

            const startIndex = (currentPage - 1) * effectivePageSize;
            const endIndex = pageSize === 'all' ? totalItems : Math.min(startIndex + effectivePageSize, totalItems);
            const pageRows = filteredRows.slice(startIndex, endIndex);

            // Update pagination UI text & buttons
            paginationInfo.textContent = \`Showing \${totalItems > 0 ? startIndex + 1 : 0}-\${endIndex} of \${totalItems} items\`;
            pageIndicator.textContent = \`Page \${currentPage} of \${totalPages}\`;
            prevPageBtn.disabled = currentPage <= 1;
            nextPageBtn.disabled = currentPage >= totalPages;

            pageRows.forEach((row) => {
                const globalIndex = rows.indexOf(row);
                const rowKey = \`\${row.file}:::\${row.key}\`;
                const isAdded = newlyAddedKeysSet.has(rowKey);
                const origJson = originalRowsMap.get(rowKey);
                const isModified = !isAdded && (origJson === undefined || origJson !== JSON.stringify(row.translations));

                const tr = document.createElement('tr');
                if (selectedRowIndex === globalIndex) {
                    tr.classList.add('selected');
                } else if (isAdded) {
                    tr.classList.add('row-added');
                } else if (isModified) {
                    tr.classList.add('row-modified');
                }

                tr.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                    selectedRowIndex = (selectedRowIndex === globalIndex) ? null : globalIndex;
                    renderTable(searchInput.value);
                    updateSelectionUI();
                });

                const tdFile = document.createElement('td');
                tdFile.textContent = row.file;
                tdFile.className = 'col-file';
                tr.appendChild(tdFile);

                const tdKey = document.createElement('td');
                tdKey.textContent = row.key;
                tdKey.className = 'col-key';
                tr.appendChild(tdKey);

                // Status Column Badge
                const tdStatus = document.createElement('td');
                tdStatus.className = 'col-status';
                const spanBadge = document.createElement('span');
                if (isAdded) {
                    spanBadge.className = 'badge badge-added';
                    spanBadge.textContent = 'New';
                } else if (isModified) {
                    spanBadge.className = 'badge badge-modified';
                    spanBadge.textContent = 'Modified';
                } else {
                    spanBadge.className = 'badge badge-saved';
                    spanBadge.textContent = 'Saved';
                }
                tdStatus.appendChild(spanBadge);
                tr.appendChild(tdStatus);

                locales.forEach(loc => {
                    const td = document.createElement('td');
                    const input = document.createElement('input');
                    input.value = row.translations[loc] || '';
                    input.addEventListener('input', (e) => {
                        const newVal = e.target.value;
                        row.translations[loc] = newVal;
                        const editKey = \`\${row.file}:::\${row.key}:::\${loc}\`;
                        unsavedEdits.set(editKey, newVal);

                        // Update row state & badge dynamically without rebuilding table DOM
                        const rKey = \`\${row.file}:::\${row.key}\`;
                        const rowIsAdded = newlyAddedKeysSet.has(rKey);
                        const rowOrigJson = originalRowsMap.get(rKey);
                        const rowIsModified = !rowIsAdded && (rowOrigJson === undefined || rowOrigJson !== JSON.stringify(row.translations));

                        if (!tr.classList.contains('selected')) {
                            tr.classList.remove('row-added', 'row-modified');
                            if (rowIsAdded) tr.classList.add('row-added');
                            else if (rowIsModified) tr.classList.add('row-modified');
                        }

                        if (rowIsAdded) {
                            spanBadge.className = 'badge badge-added';
                            spanBadge.textContent = 'New';
                        } else if (rowIsModified) {
                            spanBadge.className = 'badge badge-modified';
                            spanBadge.textContent = 'Modified';
                        } else {
                            spanBadge.className = 'badge badge-saved';
                            spanBadge.textContent = 'Saved';
                        }

                        updateUnsavedStatus();
                    });
                    td.appendChild(input);
                    tr.appendChild(td);
                });

                const tdActions = document.createElement('td');
                tdActions.className = 'col-actions';
                
                const editBtn = document.createElement('button');
                editBtn.className = 'btn-delete-row';
                editBtn.style.color = 'var(--vscode-button-background, #007acc)';
                editBtn.style.marginRight = '6px';
                editBtn.title = 'Edit Translation Details';
                editBtn.innerHTML = '✏️';
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openEditModal(globalIndex);
                });
                tdActions.appendChild(editBtn);

                const delBtn = document.createElement('button');
                delBtn.className = 'btn-delete-row';
                delBtn.title = 'Delete Row';
                delBtn.innerHTML = '&times;';
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteRow(globalIndex);
                });
                tdActions.appendChild(delBtn);
                tr.appendChild(tdActions);

                tableBody.appendChild(tr);
            });

            updateSelectionUI();
        }

        function openEditModal(index) {
            editingRowIndex = index;
            const row = rows[index];
            if (!row) return;

            editModuleSelect.value = row.file;
            editKey.value = row.key;

            locales.forEach(loc => {
                const el = document.getElementById(\`editVal_\${loc}\`);
                if (el) el.value = row.translations[loc] || '';
            });

            editModal.classList.add('show');
        }

        cancelEditBtn.addEventListener('click', () => {
            editModal.classList.remove('show');
            editingRowIndex = null;
        });

        confirmEditBtn.addEventListener('click', () => {
            if (editingRowIndex === null) return;
            const row = rows[editingRowIndex];
            if (!row) return;

            const newModuleVal = editModuleSelect.value;
            const newKeyVal = editKey.value.trim();

            if (!newModuleVal || !newKeyVal) {
                alert('Module and Key are required!');
                return;
            }

            const oldRowKey = \`\${row.file}:::\${row.key}\`;
            row.file = newModuleVal;
            row.key = newKeyVal;

            locales.forEach(loc => {
                const el = document.getElementById(\`editVal_\${loc}\`);
                const val = el ? el.value : '';
                row.translations[loc] = val;
                unsavedEdits.set(\`\${row.file}:::\${row.key}:::\${loc}\`, val);
            });

            editModal.classList.remove('show');
            editingRowIndex = null;
            renderTable();
        });

        function deleteRow(index) {
            const deletedRow = rows[index];
            if (deletedRow) {
                const rowKey = \`\${deletedRow.file}:::\${deletedRow.key}\`;
                deletedKeysSet.add(rowKey);
                newlyAddedKeysSet.delete(rowKey);
                locales.forEach(loc => {
                    unsavedEdits.delete(\`\${deletedRow.file}:::\${deletedRow.key}:::\${loc}\`);
                });
            }
            rows.splice(index, 1);
            if (selectedRowIndex === index) {
                selectedRowIndex = null;
            } else if (selectedRowIndex > index) {
                selectedRowIndex--;
            }
            renderTable();
        }

        deleteSelectedBtn.addEventListener('click', () => {
            if (selectedRowIndex !== null) {
                deleteRow(selectedRowIndex);
            }
        });

        addModuleBtn.addEventListener('click', () => {
            newModuleName.value = '';
            addModuleModal.classList.add('show');
        });

        cancelAddModuleBtn.addEventListener('click', () => {
            addModuleModal.classList.remove('show');
        });

        confirmAddModuleBtn.addEventListener('click', () => {
            const modName = newModuleName.value.trim();
            if (!modName) {
                alert('Module name is required!');
                return;
            }

            vscode.postMessage({ command: 'createModule', moduleName: modName });

            // Create initial placeholder row in webview so module appears right away
            const initialTranslations = {};
            locales.forEach(loc => initialTranslations[loc] = '');

            const rowKey = \`\${modName}:::new_key\`;
            newlyAddedKeysSet.add(rowKey);

            rows.push({
                file: modName,
                key: 'new_key',
                translations: initialTranslations
            });

            addModuleModal.classList.remove('show');
            moduleFilterSelect.value = modName;
            renderTable();
        });

        addRowBtn.addEventListener('click', () => {
            newKey.value = '';
            locales.forEach(loc => {
                const el = document.getElementById(\`newVal_\${loc}\`);
                if (el) el.value = '';
            });
            addModal.classList.add('show');
        });

        cancelAddBtn.addEventListener('click', () => {
            addModal.classList.remove('show');
        });

        confirmAddBtn.addEventListener('click', () => {
            const fileVal = newFile.value.trim();
            const keyVal = newKey.value.trim();
            if (!fileVal || !keyVal) {
                alert('Module and Key are required!');
                return;
            }

            const translations = {};
            locales.forEach(loc => {
                const el = document.getElementById(\`newVal_\${loc}\`);
                const val = el ? el.value : '';
                translations[loc] = val;
                unsavedEdits.set(\`\${fileVal}:::\${keyVal}:::\${loc}\`, val);
            });

            const rowKey = \`\${fileVal}:::\${keyVal}\`;
            newlyAddedKeysSet.add(rowKey);

            rows.push({
                file: fileVal,
                key: keyVal,
                translations
            });

            addModal.classList.remove('show');
            renderTable();
        });

        statusFilterSelect.addEventListener('change', () => {
            currentPage = 1;
            renderTable();
        });
        moduleFilterSelect.addEventListener('change', () => {
            currentPage = 1;
            renderTable();
        });
        searchInput.addEventListener('input', (e) => {
            currentPage = 1;
            renderTable(e.target.value);
        });
        saveBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'save', rows });
            unsavedEdits.clear();
            deletedKeysSet.clear();
            newlyAddedKeysSet.clear();
            originalRowsMap.clear();
            rows.forEach(r => {
                originalRowsMap.set(\`\${r.file}:::\${r.key}\`, JSON.stringify(r.translations));
            });
            renderTable();
        });

        renderTable();
    </script>
</body>
</html>`;
}

export function deactivate() { }
