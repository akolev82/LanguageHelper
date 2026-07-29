import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Import core wasm logic
const coreWasm = require('../dist/core/core.js');

interface ProjectConfig {
  format: string;
  file_layout: string;
  locales?: string[] | null;
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
  try {
    console.log('Language Helper extension active');

    let disposable = vscode.commands.registerCommand('languageHelper.openGrid', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }

      const rootUri = workspaceFolders[0].uri;
      console.log("Workspace: ", rootUri);
      const configUri = vscode.Uri.joinPath(rootUri, 'language-helper.json');
      console.log("configUri: ", configUri);

      console.log("Load config >>>>")
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
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            vscode.Uri.joinPath(context.extensionUri, 'dist')
          ]
        }
      );

      const tokensJson = coreWasm.compile_layout(config.file_layout);
      console.log("Parsed Tokens from Rust:\n" + tokensJson);

      const localesJson = config.locales ? JSON.stringify(config.locales) : "[]";
      const globPattern = coreWasm.get_layout_glob(config.file_layout, localesJson);
      console.log("globPattern from Rust: ", globPattern);

      let fileUris = await vscode.workspace.findFiles(globPattern);
      console.log("Found files count: ", fileUris.length);

      const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/^[\.\/]+/, '');

      const relativePaths = fileUris.map(uri => normalizePath(vscode.workspace.asRelativePath(uri, false)));
      const matchedFilesJson = coreWasm.match_layout_files(config.file_layout, JSON.stringify(relativePaths), localesJson);
      const matchedFiles: Array<{ relative_path: string; locale: string; file_basename: string }> = JSON.parse(matchedFilesJson);

      const matchedMap = new Map<string, { locale: string; file_basename: string }>();
      for (const item of matchedFiles) {
        matchedMap.set(normalizePath(item.relative_path), item);
      }

      const gridMap: Map<string, GridRow> = new Map();
      const localesSet: Set<string> = new Set();
      const rawFileContents: Map<string, string> = new Map(); // relativePath -> content

      for (const fileUri of fileUris) {
        const relativePath = normalizePath(vscode.workspace.asRelativePath(fileUri, false));
        const match = matchedMap.get(relativePath);
        if (!match) {
          console.log("No layout match for relativePath:", relativePath);
          continue;
        }

        const locale = match.locale;
        const fileBasename = match.file_basename;
        localesSet.add(locale);

        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        const fileContent = Buffer.from(fileBytes).toString('utf8');
        rawFileContents.set(relativePath, fileContent);

        const parsedJson = coreWasm.parse_format(config.format, fileContent);
        //console.log(`parse_format result for ${relativePath}:`, parsedJson);
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

      const locales = config.locales && config.locales.length > 0 ? config.locales : Array.from(localesSet).sort();
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

        const relativePath = normalizePath(vscode.workspace.asRelativePath(changedUri, false));
        const matchedJson = coreWasm.match_layout_files(config.file_layout, JSON.stringify([relativePath]));
        const matchedList: Array<{ relative_path: string; locale: string; file_basename: string }> = JSON.parse(matchedJson);
        if (!matchedList || matchedList.length === 0) return;

        const locale = matchedList[0].locale;
        const fileBasename = matchedList[0].file_basename;


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

            // Re-scan files to include newly created files in fileUris array
            const newFiles = await vscode.workspace.findFiles(globPattern);
            fileUris.length = 0;
            fileUris.push(...newFiles);

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
  } catch (e) {
    console.log("Error on activation Language: " + e)
  }
}

function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  initialData: { locales: string[]; rows: GridRow[] }
) {
  const nonce = Date.now();
  const styleUri = `${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'))}?v=${nonce}`;
  const scriptUri = `${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'))}?v=${nonce}`;

  const dataJson = JSON.stringify(initialData)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'index.html').fsPath;
  const htmlTemplate = fs.readFileSync(htmlPath, 'utf8');

  return htmlTemplate
    .replace('${styleUri}', styleUri)
    .replace('${scriptUri}', scriptUri)
    .replace('window.__INITIAL_DATA__ = null;', `window.__INITIAL_DATA__ = ${dataJson};`);
}

export function deactivate() { }
