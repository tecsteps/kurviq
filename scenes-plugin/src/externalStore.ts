// A value outside React that components follow (useSyncExternalStore): the
// open notes, the comments' UI state, the slide sidebar's tab and the like
// live outside the components that show them, which unmount and remount.

import { useSyncExternalStore } from "react";

export type ExternalStore<T> = {
  get: () => T;
  set: (next: T) => void;
  /** a change without a new value (a registry changed inside): listeners run */
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
  /** the value in a component, re-rendered when it changes */
  use: () => T;
};

export const createStore = <T,>(initial: T): ExternalStore<T> => {
  let value = initial;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    get,
    set: (next: T) => {
      value = next;
      notify();
    },
    notify,
    subscribe,
    use: () => useSyncExternalStore(subscribe, get),
  };
};
