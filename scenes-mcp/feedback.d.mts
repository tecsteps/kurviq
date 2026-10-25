// types of feedback.mjs (used by the app's form and the Worker)
export declare const FEEDBACK_KINDS: Array<"bug" | "change">;
export declare const TITLE_MAX: number;
export declare const TEXT_MAX: number;
export type FeedbackReport = { kind: "bug" | "change"; title: string; text: string; scene: string | null };
export declare const cleanFeedback: (input?: {
  kind?: unknown;
  title?: unknown;
  text?: unknown;
  scene?: unknown;
}) => { ok: true; value: FeedbackReport } | { ok: false; error: string };
