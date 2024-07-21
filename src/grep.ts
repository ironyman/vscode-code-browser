import * as vscode from "vscode";
import * as cp from "child_process";
import { quote } from "shell-quote";
import * as path from "path";

const MAX_DESC_LENGTH = 1000;
const MAX_BUF_SIZE = 200000 * 1024;

let quickPickValue: string;

const scrollBack: QuickPickItemWithLine[] = [];
let quickPickButtons = [
  {
    iconPath: new vscode.ThemeIcon('symbol-folder'),
    tooltip: 'Search workspace'
  } as vscode.QuickInputButton,
  {
    iconPath: new vscode.ThemeIcon('symbol-keyword'),
    tooltip: 'Search file content',
  },
] as vscode.QuickInputButton[];

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

export async function searchDirs(dirs: string[], opts?: {
  searchFileNameOnly?: boolean
}) {
  const isOption = (s: string) => /^--?[a-z]+/.test(s);
  const isWordQuoted = (s: string) => /^".*"/.test(s);
  if (dirs.length === 0) {
    dirs = [await getCurrentFileDirectory()];
  }

  let originalFileDirectory = dirs[0];

  let searchFileNameOnly: boolean = opts?.searchFileNameOnly !== undefined ? opts?.searchFileNameOnly : true;

  async function updateSearch(value: string) {
    quickPickValue = value;
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
    if (!searchFileNameOnly) {
      quoteSearch = quote([getRgPath(), "-n", ...query, "."]);
    }
    quickPick.items = (
      await Promise.allSettled(
        dirs.map((dir) => searchFileNameOnly ? fetchItemsSearchName(quoteSearch, dir) : fetchItemsSearchContent(quoteSearch, dir) ),
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

  let updateSearchDebounced = debounce((value: string) => {
    updateSearch(value);
  }, 100);

  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = "Please enter a search term";
  quickPick.matchOnDescription = true;

  // quickPick.ignoreFocusOut = true;
  quickPick.items = scrollBack;


  quickPick.buttons = quickPickButtons;

  quickPick.onDidTriggerButton(async (e) => {
    if (e.tooltip === 'Search workspace') {
      if ((e.iconPath as vscode.ThemeIcon).id !== 'check') {
        dirs = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) || [];

        quickPickButtons[0] = {
          iconPath: new vscode.ThemeIcon('check'),
          tooltip: 'Search workspace'
        } as vscode.QuickInputButton;
      } else {
        dirs = [originalFileDirectory];

        quickPickButtons[0] = {
          iconPath: new vscode.ThemeIcon('symbol-folder'),
          tooltip: 'Search workspace'
        } as vscode.QuickInputButton;
      }
      quickPick.buttons = quickPickButtons;
      updateSearch(quickPick.value);
    } else if (e.tooltip === 'Search file content') {
      if ((e.iconPath as vscode.ThemeIcon).id !== 'check') {
        searchFileNameOnly = false;

        quickPickButtons[1] = {
          iconPath: new vscode.ThemeIcon('check'),
          tooltip: 'Search workspace'
        } as vscode.QuickInputButton;
      } else {
        searchFileNameOnly = true;

        quickPickButtons[1] = {
          iconPath: new vscode.ThemeIcon('symbol-keyword'),
          tooltip: 'Search workspace'
        } as vscode.QuickInputButton;
      }
      quickPick.buttons = quickPickButtons;
      updateSearch(quickPick.value);
    }
  });
  quickPick.onDidChangeValue(updateSearchDebounced);

  quickPick.onDidAccept(async () => {
    const item = quickPick.selectedItems[0] as QuickPickItemWithLine;
    if (!item) {
      return;
    }

    if (item.description === "History") {
      quickPick.value = item.label;
      return;
    }

    // Create scrollback item to store history
    const scrollBackItem = {
      label: quickPickValue,
      description: "History",
      num: 0,
    };
    // Scrollback history is limited to 20 items
    if (scrollBack.length > 20) {
      // Remove oldest item
      scrollBack.pop();
    }
    scrollBack.unshift(scrollBackItem);

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
  });

  quickPick.show();
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
      quickPickButtons
    },
  ));

  context.subscriptions.push(
    vscode.commands.registerCommand(
    "file-browser.grep.toggleSearchContent",
    async () => {
        searchDirs([]);
    },
  ));
}