export function presentationOf(data: any): boolean;
export function mergePresentation(mine: any, theirs: any): { kurviqPresentation: boolean; kurviqPresentationAt: number };
export function restorePresentation(data: any, remembered: any): { kurviqPresentation: boolean; kurviqPresentationAt: number };
export function editedPresentation(command: any, appState: any, existing?: readonly any[]): boolean;
export function presentationEdit(command: any, appState: any, existing?: readonly any[]): { kurviqPresentation: boolean; kurviqPresentationAt: number } | null;
export function presentationChange(on: boolean, appState: any, now?: number): { kurviqPresentation: boolean; kurviqPresentationAt: number };
export function presentationSave(wanted: any, base: any, current: any): { kurviqPresentation: boolean; kurviqPresentationAt: number };
