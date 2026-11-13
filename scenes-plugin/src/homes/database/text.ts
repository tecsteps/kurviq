// Small text checks of the database home, without regular expressions that
// could backtrack.

/** base64 text without its "=" padding at the end */
export const withoutPadding = (text: string) => {
  let end = text.length;
  while (end > 0 && text[end - 1] === "=") {
    end--;
  }
  return text.slice(0, end);
};

/** an address of the form name@domain.tld (no spaces, one "@", a dot inside the domain) */
export const looksLikeEmail = (text: string) => {
  const address = text.trim();
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || /\s/.test(address)) {
    return false;
  }
  const domain = address.slice(at + 1);
  const dot = domain.indexOf(".", 1);
  return dot > 0 && dot < domain.length - 1;
};
