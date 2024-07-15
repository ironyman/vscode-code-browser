export enum Action {
    NewFile,
    NewFolder,
    OpenFile,
    OpenFileBeside,
    RenameFile,
    DeleteFile,
    OpenFolder,
    OpenFolderInNewWindow,
    Pin,
    OpenPin,
}

export function action(label: string, action: Action, arg?: any) {
    return {
        label,
        name: "",
        action,
        alwaysShow: true,
        arg,
    };
}
