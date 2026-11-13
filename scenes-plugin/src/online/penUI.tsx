// The pen bar: who is editing the open Drive scene and what this person can
// do about it (./pen.ts, docs/relay/CONCEPT.md):
//
//   someone else edits   "Anna is editing · Ask to edit" (and "Take over"
//                        when Anna is idle 5 minutes or it is your other tab)
//   nobody edits         "Nobody is editing · Edit"
//   you edit             "Ben asks to edit · Hand over / Keep", and
//                        "You're editing · Stop editing" while others watch
//   relay not reachable  "Anna is editing" from the mark on the Drive file

import { useSyncExternalStore } from "react";

import { pen } from "./pen";
import type { PenView } from "./pen";

import "./pen.scss";

const Dot = ({ color }: { color: string }) => <span className="kq-pen__dot" style={{ background: color }} aria-hidden="true" />;

const Button = ({ label, onClick, primary = false, ghost = false, disabled = false }: { label: string; onClick: () => void; primary?: boolean; ghost?: boolean; disabled?: boolean }) => (
  <button
    type="button"
    className={`scenes-btn${primary ? " scenes-btn--primary" : ""}${ghost ? " kq-pen__ghost" : ""}`}
    onClick={onClick}
    disabled={disabled}
  >
    {label}
  </button>
);

const ignore = (promise: Promise<unknown>) => {
  promise.catch((error) => console.error("[pen]", error));
};

/** this tab holds the pen: who asks for it, and stopping */
const HolderCard = ({ view }: { view: PenView }) => (
  <>
    {view.askers.map((asker) => (
      <div key={asker.id} className="kq-pen__card" role="alert">
        <span className="kq-pen__who">
          <Dot color={asker.color} />
          <strong>{asker.name}</strong> asks to edit
        </span>
        <span className="kq-pen__actions">
          <Button label="Hand over" primary disabled={view.busy} onClick={() => ignore(pen.handOver(asker.id))} />
          <Button label="Keep" ghost disabled={view.busy} onClick={() => pen.keep(asker.id)} />
        </span>
      </div>
    ))}
    {view.others > 0 && view.relay === "connected" && (
      <div className="kq-pen__card">
        <span className="kq-pen__who">
          You're editing
          <span className="kq-pen__muted">· {view.others === 1 ? "1 person watching" : `${view.others} people watching`}</span>
        </span>
        <Button label={view.busy ? "Saving…" : "Stop editing"} ghost disabled={view.busy} onClick={() => ignore(pen.stopEditing())} />
      </div>
    )}
  </>
);

/** someone else (or nobody) holds the pen: this tab watches */
const ViewerCard = ({ view }: { view: PenView }) => {
  const mayEdit = view.role === "edit" && view.relay === "connected";
  if (!view.holder) {
    return mayEdit ? (
      <div className="kq-pen__card" role="status">
        <span className="kq-pen__who kq-pen__muted">Nobody is editing</span>
        <Button label="Edit" primary onClick={() => pen.claim()} />
      </div>
    ) : null;
  }
  return (
    <div className="kq-pen__card" role="status">
      <span className="kq-pen__who">
        <Dot color={view.holder.color} />
        <span>
          <strong>{view.holder.name}</strong> is editing{view.idle ? <span className="kq-pen__muted"> (idle)</span> : null}
          {view.byMark ? <span className="kq-pen__muted"> · read only here</span> : null}
        </span>
      </span>
      {mayEdit && (
        <span className="kq-pen__actions">
          <Button label={view.asked ? "Asked…" : "Ask to edit"} disabled={view.asked} onClick={() => pen.ask()} />
          {view.canTakeOver && <Button label="Take over" onClick={() => pen.takeOver()} />}
        </span>
      )}
    </div>
  );
};

export const PenBar = () => {
  const view = useSyncExternalStore(pen.subscribe, pen.getView);
  if (view.me === "none") {
    return null;
  }
  return (
    <div className="kq-pen">
      {view.me === "holder" ? <HolderCard view={view} /> : <ViewerCard view={view} />}
      {view.notice && (
        <div className="kq-pen__card kq-pen__notice" role="status">
          <span>{view.notice}</span>
          <Button label="OK" ghost onClick={() => pen.dismissNotice()} />
        </div>
      )}
    </div>
  );
};
