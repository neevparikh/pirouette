/** Desktop notifications requested by an agent or a script it started.
 *
 *  `pru notify` (and anything else that can POST) asks the dashboard to
 *  raise a browser notification with its own title and body — "the AWS
 *  login expired, approve this code" rather than the generic "your turn"
 *  that turn-end notifications carry. The server only validates and
 *  broadcasts; each open dashboard decides whether to fire, under the
 *  same `notify` toggle and browser permission as the turn-end ones.
 *
 *  An optional `url` lets the notification act on click (open the login
 *  page); without one, clicking selects the agent. Only http(s) URLs are
 *  accepted so a notification can't be used to open `javascript:` or
 *  other schemes.
 */

export const NOTIFY_TITLE_MAX = 200;
export const NOTIFY_BODY_MAX = 2000;
export const NOTIFY_URL_MAX = 2048;

export interface AgentNotification {
  title: string;
  body: string;
  url?: string;
}

/** Validate a POST /api/agents/:id/notify body. Returns the cleaned
 *  notification, or an error message suitable for a 400. `defaultTitle`
 *  is used when the request has no title (the server passes the agent's
 *  name). */
export function parseNotifyRequest(
  raw: unknown,
  defaultTitle: string,
): { ok: true; notification: AgentNotification } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { title, body, url } = raw as Record<string, unknown>;

  if (typeof body !== "string" || body.trim() === "") {
    return { ok: false, error: "body must be a non-empty string" };
  }
  if (body.length > NOTIFY_BODY_MAX) {
    return { ok: false, error: `body must be at most ${NOTIFY_BODY_MAX} characters` };
  }
  if (title !== undefined && typeof title !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  const cleanTitle = (title ?? "").trim() || defaultTitle;
  if (cleanTitle.length > NOTIFY_TITLE_MAX) {
    return { ok: false, error: `title must be at most ${NOTIFY_TITLE_MAX} characters` };
  }

  const notification: AgentNotification = { title: cleanTitle, body };
  if (url !== undefined && url !== null && url !== "") {
    if (typeof url !== "string" || url.length > NOTIFY_URL_MAX) {
      return { ok: false, error: `url must be a string of at most ${NOTIFY_URL_MAX} characters` };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "url must be an absolute http(s) URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "url must be an absolute http(s) URL" };
    }
    notification.url = parsed.toString();
  }
  return { ok: true, notification };
}
