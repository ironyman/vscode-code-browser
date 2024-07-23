import * as vscode from "vscode";
import { Uri, QuickPickItem, FileType, QuickInputButton, ThemeIcon, ViewColumn } from "vscode";
import * as OS from "os";
import * as OSPath from "path";
import * as fs from "fs";

import { Result, None, Option, Some } from "./rust";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare } from "./fileitem";
import { action, Action } from "./action";
import { initializeSearchDirs, searchDirs } from "./grep";

interface PinnedItem { fsPath: string, type: vscode.FileType }

export enum ConfigItem {
    RemoveIgnoredFiles = "removeIgnoredFiles",
    HideDotfiles = "hideDotfiles",
    HideIgnoreFiles = "hideIgnoredFiles",
    IgnoreFileTypes = "ignoreFileTypes",
    LabelIgnoredFiles = "labelIgnoredFiles",
}

export function config<A>(item: ConfigItem): A | undefined {
    return vscode.workspace.getConfiguration("file-browser").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inFileBrowser", state);
}

function setContext2(path: Path | undefined) {
    if (path === undefined) {
        vscode.commands.executeCommand("setContext", "FileBrowser", undefined);
    } else {
        vscode.commands.executeCommand("setContext", "FileBrowserState", {
            path: path.fsPath
        });
    }
}

function getSelectedText(): string | undefined {
    if (!vscode.window.activeTextEditor) {
        return undefined;
    }
    return vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection);
}

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    pathHistory: { [path: string]: Option<string> };
    inActions: boolean = false;
    keepAlive: boolean = false;
    autoCompletion?: AutoCompletion;
    isAutoCompleteChange = false;

    actionsButton: QuickInputButton = {
        iconPath: new ThemeIcon("ellipsis"),
        tooltip: "Actions on selected file",
    };
    stepOutButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-left"),
        tooltip: "Step out of folder",
    };
    stepInButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-right"),
        tooltip: "Step into folder",
    };

    static defaultConstructorOpts: {
        write?: boolean,
    } = {
        write: false,
    };

    constructor(path: Path, file: Option<string>, private context: vscode.ExtensionContext, private opts: typeof FileBrowser.defaultConstructorOpts = FileBrowser.defaultConstructorOpts) {
        this.opts.write ??= FileBrowser.defaultConstructorOpts.write;

        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };
        this.current = vscode.window.createQuickPick();
        this.current.ignoreFocusOut = true; // add this
        this.current.buttons = [this.actionsButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";
        this.current.onDidHide(() => {
            if (!this.keepAlive) {
                this.dispose();
            }
        });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.current.onDidTriggerItemButton(this.onDidTriggerItemButton.bind(this));
        this.update().then(() => {
            if (this.opts.write) {
                this.current.placeholder = "Type a file name here to create a new file or overwrite existing one";
            } else {
                this.current.placeholder = "Type a file name here to search or open a new file";
            }
            this.current.busy = false;
        });
    }

    dispose() {
        setContext(false);
        setContext2(undefined);
        this.current.dispose();
        active = None;
    }

    hide() {
        this.current.hide();
        setContext(false);
        setContext2(undefined);
    }

    show() {
        setContext(true);
        setContext2(this.path);
        this.current.show();
    }

    async togglePin(path: Path) {
        let pinned: PinnedItem[] = this.context.globalState.get('file-browser.pinned', []);
        let found = pinned.findIndex(p => p.fsPath === path.uri.fsPath);
        if (found === -1) {
            let isDir = await path.isDir();
            pinned.push({ fsPath: path.uri.fsPath, type: isDir ? vscode.FileType.Directory : vscode.FileType.File });
        } else {
            pinned.splice(found, 1);
        }
        return this.context.globalState.update('file-browser.pinned', pinned);
    }

    getPinned(): FileItem[] {
        let pinned: PinnedItem[] = this.context.globalState.get('file-browser.pinned', []);
        // let pinned = pinnedStrings.map(p => vscode.Uri.parse(p));
        return pinned.map(p => {
            let name;
            if (p.type === vscode.FileType.Directory) {
                name = `$(folder-opened) ${p.fsPath}`;
            } else {
                name = `$(file) ${p.fsPath}`;
            }
            let a: FileItem = action(name, Action.OpenPin, p);
            a.buttons = [
                {
                    iconPath: new vscode.ThemeIcon("close")
                }
            ];
            return a;
        });
    }

    async update() {
        // FIXME: temporary and UGLY fix of https://github.com/bodil/vscode-file-browser/issues/35.
        // Brought in from here https://github.com/atariq11700/vscode-file-browser/commit/a2525d01f262f17dac2c478e56640c9ce1f65713.
        // this.current.enabled = false;
        this.current.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;
        this.current.value = "";

        const stat = (await Result.try(vscode.workspace.fs.stat(this.path.uri))).unwrap();
        if (stat && this.inActions && (stat.type & FileType.File) === FileType.File) {
            this.items = [
                action("$(file) Open this file", Action.OpenFile),
                action("$(split-horizontal) Open this file to the side", Action.OpenFileBeside),
                action("$(edit) Rename this file", Action.RenameFile),
                action("$(trash) Delete this file", Action.DeleteFile),
                action("$(search) Find files in containing folder", Action.FindFiles),
                action("$(symbol-keyword) Find files in containing folder by content", Action.FindFilesContent),
                action("$(pin) Pin this file", Action.Pin),
                action("$(clippy) Copy this file path", Action.CopyPath),
                ...this.getPinned(),
            ];
            this.current.items = this.items;
        } else if (
            stat &&
            this.inActions &&
            (stat.type & FileType.Directory) === FileType.Directory
        ) {
            this.items = [
                action("$(folder-opened) Open this folder", Action.OpenFolder),
                action(
                    "$(folder-opened) Open this folder in a new window",
                    Action.OpenFolderInNewWindow
                ),
                action("$(edit) Rename this folder", Action.RenameFile),
                action("$(trash) Delete this folder", Action.DeleteFile),
                action("$(search) Find files", Action.FindFiles),
                action("$(symbol-keyword) Find files by content", Action.FindFilesContent),
                action("$(pin) Pin this folder", Action.Pin),
                action("$(clippy) Copy this file path", Action.CopyPath),
                ...this.getPinned(),
            ];
            this.current.items = this.items;
        } else if (stat && (stat.type & FileType.Directory) === FileType.Directory) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);
            let items = records.map((entry) => new FileItem(entry));
            if (config(ConfigItem.HideIgnoreFiles)) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
            }
            if (config(ConfigItem.RemoveIgnoredFiles)) {
                items = items.filter((item) => item.alwaysShow);
            }
            this.items = items;
            this.current.items = items;
            this.current.activeItems = items.filter((item) => this.file.contains(item.name));
        } else {
            this.items = [action("$(new-folder) Create this folder", Action.NewFolder)];
            this.current.items = this.items;
        }
        this.current.enabled = true;
        if (this.opts.write) {
            // Create default item.
            this.onDidChangeValue(this.current.value);
        }
    }

    onDidChangeValue(value: string) {
        if (this.inActions) {
            return;
        }

        if (!this.isAutoCompleteChange) {
            this.autoCompletion = undefined;
        } else {
            this.isAutoCompleteChange = false;
        }

        const existingItem = this.items.find((item) => item.name === value);
        if (value === "") {
            let currentFileName = vscode.window.activeTextEditor?.document.fileName;
            if (this.opts.write && currentFileName) {
                let currentFileNameBase = OSPath.basename(currentFileName);
                const newItem = {
                    label: `$(new-file) ${currentFileNameBase}`,
                    name: currentFileNameBase,
                    description: "Create file",
                    alwaysShow: true,
                    action: Action.OpenFile,
                };
                this.current.items = [newItem, ...this.items];
                this.current.activeItems = [newItem];
            } else {
                this.current.items = this.items;
                this.current.activeItems = [];
            }
        } else if (existingItem !== undefined) {
            this.current.items = this.items;
            this.current.activeItems = [existingItem];
        } else {
            // Need to support
            // - directory entries in cwd
            // - paths relative to \,
            // - paths relative to c:\,
            // - paths relative to cwd
            // - paths relative to workspace, @
            // - paths relative to ~
            // TODO: You should clean this up to not have separate logic for endsWithPathSeparator.
            const origValue = value;
            value = value.replace(/\\/g, '/');
            let lastPathSeparatorStartSearchIndex = value.length - 1;
            if (value.length > 1 && value.endsWith('/') && !value.endsWith(':/')) {
                lastPathSeparatorStartSearchIndex--;
            }

            let lastPathSeparator = value.lastIndexOf('/', lastPathSeparatorStartSearchIndex);
            if (lastPathSeparator !== -1) {
                let rootRelativePath = value.startsWith('/');
                let driveRootRelativePath = value.length > 1 && value.slice(1).startsWith(':');
                let homeRelativePath = value.startsWith('~');
                let workspaceRelativePath = value.startsWith('@');
                let envRelativePath = value.startsWith('$env:');
                if (rootRelativePath || driveRootRelativePath || homeRelativePath || workspaceRelativePath || envRelativePath) {
                    this.stepIntoFolder(Path.fromFilePath(value.slice(0, lastPathSeparator))).then(() => {
                        this.current.value = value.slice(lastPathSeparator + 1);
                    });
                } else {
                    this.stepIntoFolder(this.path.append(value.slice(0, lastPathSeparator))).then(() => {
                        this.current.value = value.slice(lastPathSeparator + 1);
                    });
                }
                return;
            }

            endsWithPathSeparator(value).match(
                (path) => {
                    if (path === "~" || path === '@') {
                        this.stepIntoFolder(Path.fromFilePath(path));
                    } else if (path === "..") {
                        this.stepOut();
                    } else if (path === '') {
                        this.stepIntoFolder(Path.fromFilePath('/'));
                    } else {
                        this.stepIntoFolder(this.path.append(path));
                    }
                },
                () => {
                    const newItem = {
                        label: `$(new-file) ${origValue}`,
                        name: value,
                        description: "Open as new file",
                        alwaysShow: true,
                        action: Action.NewFile,
                    };
                    if (this.opts.write) {
                        newItem.action = Action.OpenFile;
                        newItem.description = "Create new file";
                    }
                    this.current.items = [newItem, ...this.items];
                    this.current.activeItems = [newItem];
                }
            );
        }
    }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) {
            this.stepIn();
        } else if (button === this.stepOutButton) {
            this.stepOut();
        } else if (button === this.actionsButton) {
            this.actions();
        }
    }

    onDidTriggerItemButton(e: vscode.QuickPickItemButtonEvent<FileItem>) {
        if ((e.button.iconPath as vscode.ThemeIcon)?.id !== 'close') {
            return;
        }
        let item = (e.item as any).arg as PinnedItem;
        let path = Path.fromFilePath(item.fsPath);
        this.togglePin(path).then(() => this.update());
    }

    activeItem(): Option<FileItem> {
        return new Option(this.current.activeItems[0]);
    }

    async stepIntoFolder(folder: Path) {
        // if (!this.path.equals(folder)) {
            this.path = folder;
            setContext2(this.path);
            this.file = this.pathHistory[this.path.id] || None;
            await this.update();
        // }
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    await this.stepIntoFolder(this.path.append(item.name));
                } else if ((item.fileType & FileType.File) === FileType.File) {
                    this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;
                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        this.inActions = false;
        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();
            await this.update();
        }
    }

    async actions() {
        if (this.inActions) {
            return;
        }
        await this.activeItem().match(
            async (item) => {
                this.inActions = true;
                this.path.push(item.name);
                this.file = None;
                await this.update();
            },
            async () => {
                this.inActions = true;
                this.file = None;
                await this.update();
            }
        );
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions) {
            return;
        }

        if (this.autoCompletion) {
            const length = this.autoCompletion.items.length;
            const step = tabNext ? 1 : -1;
            this.autoCompletion.index = (this.autoCompletion.index + length + step) % length;
        } else {
            const items = this.items.filter((i) =>
                i.name.toLowerCase().indexOf(this.current.value.toLowerCase()) !== -1
            ).sort((a, b) => {
                const indexA = a.name.toLowerCase().indexOf(this.current.value.toLowerCase());
                const indexB = b.name.toLowerCase().indexOf(this.current.value.toLowerCase());

                // Compare the indices of the term
                if (indexA !== indexB) {
                    return indexA - indexB; // Sort by earliness
                }

                // If indices are equal, sort lexicographically
                return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            });
            this.autoCompletion = {
                index: tabNext ? 0 : items.length - 1,
                items,
            };
        }

        const newIndex = this.autoCompletion.index;
        const length = this.autoCompletion.items.length;
        if (newIndex < length) {
            // This also checks out when items is empty
            const item = this.autoCompletion.items[newIndex];
            if (length === 1 && item.fileType === vscode.FileType.Directory) {
                this.current.value = item.name + '/';
            } else {
                this.isAutoCompleteChange = true;
                this.current.value = item.name;
            }

            // Setting value automatically calls this.onDidChangeValue so calling with true won't achieve what we want
            // because it will be called after with false in second argument
            // this.onDidChangeValue(this.current.value, true);
            // Setting value doesn't always call onDidChangeValue, something else was calling it after tab completion.
        }
    }

    onDidAccept() {
        this.autoCompletion = undefined;
        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (
                item.fileType !== undefined &&
                (item.fileType & FileType.Directory) === FileType.Directory
            ) {
                this.stepIn();
            } else {
                this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        if (this.opts.write) {
            const document = vscode.window.activeTextEditor?.document.getText();
            if (!document) {
                return;
            }
            try {
                fs.mkdirSync(OSPath.dirname(uri.fsPath), {
                    recursive: true
                });
                fs.writeFileSync(uri.fsPath, document);
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Failed to create file.\n${e}`
                );
            }
        }
        vscode.workspace
            .openTextDocument(uri)
            .then((doc) => {
                vscode.window.showTextDocument(doc, column);
            });
    }

    async rename() {
        const uri = this.path.uri;
        const stat = await vscode.workspace.fs.stat(uri);
        const isDir = (stat.type & FileType.Directory) === FileType.Directory;
        const fileName = this.path.pop().unwrapOrElse(() => {
            throw new Error("Can't rename an empty file name!");
        });
        const fileType = isDir ? "folder" : "file";
        const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
        const relPath = workspaceFolder
            .andThen((workspaceFolder) => new Path(uri).relativeTo(workspaceFolder))
            .unwrapOr(fileName);
        const extension = OSPath.extname(relPath);
        const startSelection = relPath.length - fileName.length;
        const endSelection = startSelection + (fileName.length - extension.length);
        const result = await vscode.window.showInputBox({
            prompt: `Enter the new ${fileType} name`,
            value: relPath,
            valueSelection: [startSelection, endSelection],
        });
        this.file = Some(fileName);
        if (result !== undefined) {
            const newUri = workspaceFolder.match(
                (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
                () => Uri.joinPath(this.path.uri, result)
            );
            if ((await Result.try(vscode.workspace.fs.rename(uri, newUri))).isOk()) {
                this.file = Some(OSPath.basename(result));
            } else {
                vscode.window.showErrorMessage(
                    `Failed to rename ${fileType} "${fileName}"`
                );
            }
        }
    }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.NewFolder: {
                await vscode.workspace.fs.createDirectory(this.path.uri);
                await this.update();
                break;
            }
            case Action.NewFile: {
                const uri = this.path.append(item.name).uri;
                this.openFile(uri.with({ scheme: "untitled" }));
                break;
            }
            case Action.OpenFile: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri);
                break;
            }
            case Action.OpenFileBeside: {
                const path = this.path.clone();
                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }
                this.openFile(path.uri, ViewColumn.Beside);
                break;
            }
            case Action.RenameFile: {
                this.keepAlive = true;
                this.hide();
                await this.rename();
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.DeleteFile: {
                this.keepAlive = true;
                this.hide();
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().unwrapOrElse(() => {
                    throw new Error("Can't delete an empty file name!");
                });
                const fileType = isDir ? "folder" : "file";
                const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
                const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});
                if (result === goAhead) {
                    const delOp = await Result.try(
                        vscode.workspace.fs.delete(uri, { recursive: isDir })
                    );
                    if (delOp.isErr()) {
                        vscode.window.showErrorMessage(
                            `Failed to delete ${fileType} "${fileName}"`
                        );
                    }
                }
                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();
                break;
            }
            case Action.OpenFolder: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri);
                break;
            }
            case Action.OpenFolderInNewWindow: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true);
                break;
            }
            case Action.Pin: {
                this.togglePin(this.path);
                this.hide();
                break;
            }
            case Action.OpenPin: {
                let arg = (item as any).arg as PinnedItem;
                if (arg.type === vscode.FileType.Directory) {
                    this.path = Path.fromFilePath(arg.fsPath);
                    this.inActions = false;
                    this.update();
                } else {
                    this.path = Path.fromFilePath(arg.fsPath);
                    this.openFile(this.path.uri);
                }
                break;
            }
            case Action.FindFiles: {
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;

                if (isDir) {
                    searchDirs([this.path.uri.fsPath]);
                } else {
                    searchDirs([OSPath.dirname(this.path.uri.fsPath)]);
                }
                break;
            }
            case Action.FindFilesContent: {
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;

                if (isDir) {
                    searchDirs([this.path.uri.fsPath], { searchFileNameOnly: false });
                } else {
                    searchDirs([OSPath.dirname(this.path.uri.fsPath)], { searchFileNameOnly: false });
                }
                break;
            }
            case Action.CopyPath: {
                vscode.env.clipboard.writeText(this.path.fsPath);
                this.hide();
                break;
            }
            default:
                throw new Error(`Unhandled action ${item.action}`);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    setContext(false);
    setContext2(undefined);

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.open", (args: any) => {
            const document = vscode.window.activeTextEditor?.document;
            let workspaceFolder =
                vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
            let file: Option<string> = None;
            if (document && !document.isUntitled) {
                try {
                    path = new Path(document.uri);
                    file = path.pop();
                } catch (error) {
                    path = Path.fromFilePath('@');
                }
            }
            active = Some(new FileBrowser(path, file, context));
            setContext(true);
            setContext2(path);

            let initialQueryValue = args[0];
            initialQueryValue ??= getSelectedText();
            if (initialQueryValue) {
                active.unwrap()!.onDidChangeValue(initialQueryValue);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.write", () => {
            const document = vscode.window.activeTextEditor?.document;
            let workspaceFolder =
                vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
            let file: Option<string> = None;
            if (document && !document.isUntitled) {
                try {
                    path = new Path(document.uri);
                    file = path.pop();
                } catch (error) {
                    path = Path.fromFilePath('@');
                }
            }
            active = Some(new FileBrowser(path, file, context, { write: true }));
            setContext(true);
            setContext2(path);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.rename", () =>
            active.orElse(() => {
                const document = vscode.window.activeTextEditor?.document;
                let workspaceFolder =
                    vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
                let path = new Path(document?.uri || workspaceFolder?.uri || Uri.file(OS.homedir()));
                active = Some(new FileBrowser(path, None, context));
                setContext(true);
                setContext2(path);
                return active;
            }).ifSome((active) => active.rename())
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepIn", () =>
            active.ifSome((active) => active.stepIn())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.stepOut", () =>
            active.ifSome((active) => active.stepOut())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.actions", () =>
            active.ifSome((active) => active.actions())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabNext", () =>
            active.ifSome((active) => active.tabCompletion(true))
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("file-browser.tabPrev", () =>
            active.ifSome((active) => active.tabCompletion(false))
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
        "file-browser.grep",
        async () => {
            if (active.isSome()) {
                let currentPath = active.unwrap()!.path;
                const initialQueryValue = active.unwrap()!.current.value;
                if (await currentPath.isDir()) {
                    searchDirs([currentPath.fsPath], {
                        initialQueryValue,
                    });
                } else {
                    searchDirs([OSPath.dirname(currentPath.fsPath)], {
                        initialQueryValue,
                    });
                }
            } else {
                const selectedText = getSelectedText();
                searchDirs([], {
                    initialQueryValue: selectedText || ''
                });
            }
        },
    ));

    initializeSearchDirs(context);

    return {
        queryCurrentPath: (): string | undefined => {
            return active.unwrap()?.path.fsPath;
        },
        queryCurrentQueryValue: (): string | undefined => {
            return active.unwrap()?.current.value;
        },
        close: () => {
            return active.unwrap()?.dispose();
        },
    };
}

export function deactivate() {}
