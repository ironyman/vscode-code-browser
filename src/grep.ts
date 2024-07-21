import * as vscode from "vscode";
import * as cp from "child_process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

let active: SearchBrowser;

const getRgPath = () => {
  return vscode.env.appRoot + '/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg';
};

interface QuickPickItemWithLine extends vscode.QuickPickItem {
  num: number;
}

function debounce(callback: (...arg0: any[]) => any, wait: number) {
  let timerId: NodeJS.Timeout;
  return (...args: any) => {
      clearTimeout(timerId);
      timerId = setTimeout(() => {
          callback(...args);
      }, wait);
  };
}

function fetchItemsSearchContent(
  command: string,
  dir: string,
): Promise<QuickPickItemWithLine[]> {
  return new Promise((resolve, reject) => {
    if (dir === "") {
      reject(new Error("Can't parse dir ''"));
    }
    cp.exec(
      command,
      { cwd: dir, maxBuffer: MAX_BUF_SIZE },
      (err, stdout, stderr) => {
        if (stderr) {
          reject(new Error(stderr));
        }
        const lines = stdout.split(/\n/).filter((l) => l !== "");
        if (!lines.length) {
          resolve([]);
        }
        resolve(
          lines
            .map((line) => {
              const [fullPath, num, ...desc] = line.split(":");
              const description = desc.join(":").trim();
              return {
                fullPath,
                num: Number(num),
                line,
                description,
              };
            })
            .filter(
              ({ description, num }) =>
                description.length < MAX_DESC_LENGTH && !!num,
            )
            .map(({ fullPath, num, line, description }) => {
              const path = fullPath.split("/");
              return {
                label: `${path[path.length - 1]} : ${num}`,
                description,
                detail: dir + fullPath.substring(1, fullPath.length),
                num,
              };
            }),
        );
      },
    );
  });
}

function fetchItemsSearchName(
  command: string,
  dir: string,
): Promise<QuickPickItemWithLine[]> {
  return new Promise((resolve, reject) => {
    if (dir === "") {
      reject(new Error("Can't parse dir ''"));
    }
    cp.exec(
      command,
      { cwd: dir, maxBuffer: MAX_BUF_SIZE },
      (err, stdout, stderr) => {
        if (stderr) {
          reject(new Error(stderr));
        }
        const lines = stdout.split(/\n/).filter((l) => l !== "");
        if (!lines.length) {
          resolve([]);
        }
        resolve(
          lines
            .map((line) => {
              const path = line.split("/");

              return {
                label: `${path[path.length - 1]}`,
                fullPath: line,
                description: '',
                detail: dir + line.substring(1, line.length),
                num: 0,
              };
            })
        );
      },
    );
  });
}
function getCurrentFileDirectorySync(): string {
  if (!vscode.window.activeTextEditor) {
    vscode.window.showErrorMessage("No active editor.");
    return '';
  }
  let pwd = vscode.Uri.parse(
      vscode.window.activeTextEditor.document.uri.path,
  );
  let pwdString = pwd.path;
    pwdString = path.dirname(pwdString);

  return pwdString;
}
async function getCurrentFileDirectory(): Promise<string> {
  if (!vscode.window.activeTextEditor) {
    vscode.window.showErrorMessage("No active editor.");
    return '';
  }
  let pwd = vscode.Uri.parse(
      vscode.window.activeTextEditor.document.uri.path,
  );
  let pwdString = pwd.path;
  if (
      (await vscode.workspace.fs.stat(pwd)).type === vscode.FileType.File
  ) {
      pwdString = path.dirname(pwdString);
  }

  return pwdString;
}

const isOption = (s: string) => /^--?[a-z]+/.test(s);
const isWordQuoted = (s: string) => /^".*"/.test(s);

class SearchBrowser {
  current: vscode.QuickPick<vscode.QuickPickItem>;
  searchFileNameOnly: boolean;
  originalFileDirectory: string;
  scrollBack: QuickPickItemWithLine[] = [];
  public quickPickButtons = [
    {
      iconPath: new vscode.ThemeIcon('symbol-folder'),
      tooltip: 'Search workspace'
    } as vscode.QuickInputButton,
    {
      iconPath: new vscode.ThemeIcon('symbol-keyword'),
      tooltip: 'Search file content',
    },
  ] as vscode.QuickInputButton[];
  quickPickValue: string = '';



  constructor(public dirs: string[], opts?: {
    searchFileNameOnly?: boolean
  }) {
    if (this.dirs.length === 0) {
      this.dirs = [getCurrentFileDirectorySync()];
    }
    this.originalFileDirectory = this.dirs[0];
    this.searchFileNameOnly = opts?.searchFileNameOnly !== undefined ? opts?.searchFileNameOnly : true;

    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = "Please enter a search term";
    quickPick.matchOnDescription = true;
    // quickPick.ignoreFocusOut = true;
    quickPick.items = this.scrollBack;
    quickPick.buttons = this.quickPickButtons;

    quickPick.show();
    this.current = quickPick;
    this.setContext(true);
    let updateSearchDebounced = debounce(this.updateSearch.bind(this), 100);

    this.current.onDidAccept(this.onDidAccept.bind(this));
    this.current.onDidChangeValue(updateSearchDebounced);
    this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));

    this.current.onDidHide(() => {
      this.setContext(false);
      this.dispose();
    });
  }

  async updateSearch(value: string) {
    this.quickPickValue = value;
    if (!value || value === "") {
      return;
    }
    let query = value.split(/\s/).reduce((acc, curr, index) => {
      if (index === 0 || isOption(curr) || isOption(acc[acc.length - 1])) {
        if (!isWordQuoted(curr) && !isOption(curr)) {
          acc.push("-i", curr); // add case insensitive flag
          return acc;
        }
        acc.push(curr.replace(/"/g, "")); // remove quotes
        return acc;
      }
      acc[acc.length - 1] = acc[acc.length - 1] + ` ${curr}`;
      return acc;
    }, [] as string[]);

    let quoteSearch = quote([getRgPath(), '--files', '.']) + ' | ' + quote([getRgPath(),  ...query]);
    if (!this.searchFileNameOnly) {
      quoteSearch = quote([getRgPath(), "-n", ...query, "."]);
    }
    this.current.items = (
      await Promise.allSettled(
        this.dirs.map((dir) => this.searchFileNameOnly ? fetchItemsSearchName(quoteSearch, dir) : fetchItemsSearchContent(quoteSearch, dir) ),
      )
    )
      .map((result) => {
        if (result.status === "rejected") {
          vscode.window.showErrorMessage(result.reason);
        }
        return result;
      })
      .filter((result) => result.status === "fulfilled")
      .map((result) => {
        if (result.status === "fulfilled") {
          return result.value;
        }
        return [];
      })
      .flat();
  }

  async onDidTriggerButton(e: vscode.QuickInputButton) {
    if (e.tooltip === 'Search workspace') {
      if ((e.iconPath as vscode.ThemeIcon).id !== 'check') {
        this.dirs = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];

        this.quickPickButtons[0] = {
          iconPath: new vscode.ThemeIcon('check'),
          tooltip: e.tooltip,
        } as vscode.QuickInputButton;
      } else {
        this.dirs = [this.originalFileDirectory];

        this.quickPickButtons[0] = {
          iconPath: new vscode.ThemeIcon('symbol-folder'),
          tooltip: e.tooltip,
        } as vscode.QuickInputButton;
      }
      this.current.buttons = this.quickPickButtons;
      this.updateSearch(this.current.value);
    } else if (e.tooltip === 'Search file content') {
      if ((e.iconPath as vscode.ThemeIcon).id !== 'check') {
        this.searchFileNameOnly = false;

        this.quickPickButtons[1] = {
          iconPath: new vscode.ThemeIcon('check'),
          tooltip: e.tooltip,
        } as vscode.QuickInputButton;
      } else {
        this.searchFileNameOnly = true;

        this.quickPickButtons[1] = {
          iconPath: new vscode.ThemeIcon('symbol-keyword'),
          tooltip: e.tooltip,
        } as vscode.QuickInputButton;
      }
      this.current.buttons = this.quickPickButtons;
      this.updateSearch(this.current.value);
    }
  }

  async onDidAccept() {
    const item = this.current.selectedItems[0] as QuickPickItemWithLine;
    if (!item) {
      return;
    }

    if (item.description === "History") {
      this.current.value = item.label;
      return;
    }

    // Create scrollback item to store history
    const scrollBackItem = {
      label: this.quickPickValue,
      description: "History",
      num: 0,
    };
    // Scrollback history is limited to 20 items
    if (this.scrollBack.length > 20) {
      // Remove oldest item
      this.scrollBack.pop();
    }
    this.scrollBack.unshift(scrollBackItem);

    const { detail, num } = item;
    const doc = await vscode.workspace.openTextDocument("" + detail);
    await vscode.window.showTextDocument(doc);
    if (!vscode.window.activeTextEditor) {
      vscode.window.showErrorMessage("No active editor.");
      return;
    }
    vscode.window.activeTextEditor.selection = new vscode.Selection(
      ~~num,
      0,
      ~~num,
      0,
    );
    vscode.commands.executeCommand("cursorUp");
  }
  setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inSearchBrowser", state);
  }

  dispose() {
    this.setContext(false);
    this.current.dispose();
  }
}


export async function searchDirs(dirs: string[], opts?: {
  searchFileNameOnly?: boolean
}) {
  active = new SearchBrowser(dirs, opts);
}

export function initializeSearchDirs(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
    "file-browser.grep",
    async () => {
        searchDirs([]);
    },
  ));

  context.subscriptions.push(
    vscode.commands.registerCommand(
    "file-browser.grep.toggleSearchWorkspace",
    async () => {
      active?.onDidTriggerButton(active?.quickPickButtons[0]);
    },
  ));

  context.subscriptions.push(
    vscode.commands.registerCommand(
    "file-browser.grep.toggleSearchContent",
    async () => {
      active?.onDidTriggerButton(active?.quickPickButtons[1]);
    },
  ));
}