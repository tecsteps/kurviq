/** Preserve visible editor settling time without hidden-tab timer throttling. */
export const editorYield = (delay = 50): Promise<void> => {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
};
