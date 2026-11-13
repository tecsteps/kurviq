// The share panel's rules (pure; Drive's calls are in drive.ts): General
// access (anyone with the link, or anyone at the user's organization with the
// link) and end dates of people's access. Nothing of it is stored by Kurviq:
// it is all Drive permissions.

export type SharingRole = "reader" | "commenter" | "writer";
export type LinkAccess = "restricted" | SharingRole;
/** what General access offers: the link for anyone, or for the organization ("domain:<role>") */
export type GeneralAccess = LinkAccess | `domain:${SharingRole}`;

/** the parts of a Drive permission these rules read */
export type Grant = { id: string; type: string; role: string; domain?: string; expirationTime?: string };

/** personal Google accounts: no organization to share with */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** the organization of a Google Workspace account (its address's domain); null for a personal Gmail account */
export const organizationDomain = (email: string | null | undefined): string | null => {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  return domain && !CONSUMER_DOMAINS.has(domain) ? domain : null;
};

const asRole = (role: string): SharingRole => (role === "writer" || role === "commenter" ? role : "reader");

export type LinkGrants = {
  anyone: LinkAccess;
  /** "anyone at <domain> with the link", one per domain */
  domains: { id: string; domain: string; role: SharingRole }[];
};

/** who may open a file by its link: anyone (or not), and the domains */
export const linkAccessOf = (permissions: Grant[]): LinkGrants => {
  const anyone = permissions.find((permission) => permission.type === "anyone");
  return {
    anyone: anyone ? asRole(anyone.role) : "restricted",
    domains: permissions
      .filter((permission) => permission.type === "domain" && !!permission.domain)
      .map((permission) => ({ id: permission.id, domain: String(permission.domain).toLowerCase(), role: asRole(permission.role) })),
  };
};

/** what the General access field shows: the link for anyone, else the user's organization's, else "only people added" */
export const generalAccessOf = (grants: LinkGrants, domain: string | null): GeneralAccess => {
  if (grants.anyone !== "restricted") {
    return grants.anyone;
  }
  const own = grants.domains.find((grant) => grant.domain === domain);
  return own ? `domain:${own.role}` : "restricted";
};

/** the domain grants the field doesn't show (made in Drive, or next to "anyone"): listed under it */
export const otherDomainGrants = (grants: LinkGrants, shown: GeneralAccess, domain: string | null) =>
  grants.domains.filter((grant) => !(shown.startsWith("domain:") && grant.domain === domain));

const VERB: Record<SharingRole, string> = { reader: "view", commenter: "comment", writer: "edit" };

/** the field's options for this user (the organization's only for a Workspace account) */
export const generalAccessOptions = (domain: string | null): GeneralAccess[] => {
  const options: GeneralAccess[] = ["restricted", "reader", "commenter", "writer"];
  return domain ? [...options, "domain:reader", "domain:commenter", "domain:writer"] : options;
};

/** "Anyone at tecsteps.com with the link can edit" */
export const domainLabel = (domain: string, role: SharingRole) => `Anyone at ${domain} with the link can ${VERB[role]}`;

export const generalAccessLabel = (value: GeneralAccess, domain: string | null) => {
  if (value === "restricted") {
    return "Only people added here";
  }
  if (value.startsWith("domain:")) {
    return domainLabel(domain ?? "your organization", value.slice("domain:".length) as SharingRole);
  }
  return `Anyone with the link can ${VERB[value as SharingRole]}`;
};

const LINK_HINT: Record<LinkAccess, string> = {
  restricted: "The link only works for the people above, signed in with Google.",
  reader: "Anyone who has the link can view and present it, no account needed.",
  commenter: "Anyone who has the link can view it; with a Google account they can also comment.",
  writer: "Anyone who has the link can view it; with a Google account they can also change it.",
};

export const generalAccessHint = (value: GeneralAccess, domain: string | null) => {
  if (value.startsWith("domain:")) {
    const role = value.slice("domain:".length) as SharingRole;
    return `People at ${domain ?? "your organization"} who have the link can ${VERB[role]} it, signed in with their Google account. It doesn't show up in their Drive search.`;
  }
  return LINK_HINT[value as LinkAccess];
};

/** one Drive call of a change of General access */
export type PermissionChange = { remove: string } | { patch: string; role: SharingRole } | { create: Record<string, unknown> };

const targetOf = (value: GeneralAccess): { kind: "anyone" | "domain"; role: SharingRole } | null => {
  if (value === "restricted") {
    return null;
  }
  if (value.startsWith("domain:")) {
    return { kind: "domain", role: value.slice("domain:".length) as SharingRole };
  }
  return { kind: "anyone", role: value as SharingRole };
};

/**
 * The Drive calls that make `value` the file's General access: the link
 * permissions ("anyone", "domain") that don't fit go, the one that does gets
 * the role, or is made (never findable in Drive's search).
 */
export const generalAccessChanges = (permissions: Grant[], value: GeneralAccess, domain: string | null): PermissionChange[] => {
  const target = targetOf(value);
  if (target?.kind === "domain" && !domain) {
    throw new Error("Only a Google Workspace account can share with its organization");
  }
  const fits = (permission: Grant) =>
    permission.type === target?.kind && (target.kind === "anyone" || permission.domain?.toLowerCase() === domain);
  const changes: PermissionChange[] = [];
  let found = false;
  for (const permission of permissions.filter((entry) => entry.type === "anyone" || entry.type === "domain")) {
    if (!target || !fits(permission) || found) {
      changes.push({ remove: permission.id });
      continue;
    }
    found = true;
    if (permission.role !== target.role) {
      changes.push({ patch: permission.id, role: target.role });
    }
  }
  if (target && !found) {
    const grantee = target.kind === "domain" ? { type: "domain", domain } : { type: "anyone" };
    changes.push({ create: { ...grantee, role: target.role, allowFileDiscovery: false } });
  }
  return changes;
};

// -----------------------------------------------------------------------------
// end dates: Drive's expirationTime on people's (and groups') access to view or
// comment; after it, Drive removes the permission
// -----------------------------------------------------------------------------

/** rows that may get an end date: people and groups who view or comment (not editors) */
export const canHaveEndDate = (permission: { type: string; role: string }) =>
  (permission.type === "user" || permission.type === "group") && (permission.role === "reader" || permission.role === "commenter");

const pad = (value: number) => String(value).padStart(2, "0");

/** a date field's value ("2026-11-30") of a moment, in the user's time zone */
export const dateFieldValue = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** the end of the picked day ("2026-11-30") in the user's time zone, as Drive takes it */
export const endOfDay = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59).toISOString();
};

const DAY_MS = 24 * 3600 * 1000;

/** what the date field offers: today up to a year from now (Drive's limit) */
export const endDateRange = (now = new Date()) => ({ min: dateFieldValue(now), max: dateFieldValue(new Date(now.getTime() + 365 * DAY_MS)) });

/** a row's end date: "until 30 Nov" (with the year when it isn't this year's) */
export const untilText = (iso: string, now = new Date()) => {
  const at = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (at.getFullYear() !== now.getFullYear()) {
    options.year = "numeric";
  }
  return `until ${at.toLocaleDateString("en-GB", options)}`;
};

/** the PATCH of a permission's end date: the query to add and the body (date null: no end date) */
export const endDatePatch = (role: string, date: string | null) =>
  date ? { query: "", body: { role, expirationTime: endOfDay(date) } } : { query: "&removeExpiration=true", body: { role } };
