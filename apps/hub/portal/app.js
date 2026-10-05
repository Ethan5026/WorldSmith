// WorldSmith portal: join requests, worlds, friends, Claude connections, notifications.

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "X-WorldSmith": "1", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const post = (path, body) => api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}
function button(label, cls, onClick) {
  const b = el("button", { type: "button", class: cls || "" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

// ---- join requests -------------------------------------------------------------------------
async function loadRequests() {
  const requests = await api("/api/requests");
  $("requests").hidden = requests.length === 0;
  $("request-list").replaceChildren(
    ...requests.map((r) =>
      el(
        "div",
        { class: "card approval stack" },
        el("p", {}, el("span", { class: "who" }, r.name), ` tried to join${r.attempts > 1 ? ` ${r.attempts} times` : ""} · ${ago(r.last_seen)}`),
        el(
          "div",
          { class: "row" },
          button("Let them in", "primary", async () => {
            await post(`/api/requests/${r.id}/approve`);
            toast(`${r.name} can join now. Tell them to try again.`);
            refresh();
          }),
          button("Decline", "danger", async () => {
            await post(`/api/requests/${r.id}/deny`);
            toast(`Declined ${r.name}.`);
            refresh();
          }),
        ),
      ),
    ),
  );
}

// ---- worlds --------------------------------------------------------------------------------
const STATE_LABEL = { online: "Online", waking: "Waking up", asleep: "Asleep", missing: "Not set up", error: "Trouble" };

async function loadWorlds() {
  const { worlds } = await api("/api/worlds");
  $("world-list").replaceChildren(
    ...(worlds.length === 0
      ? [el("p", { class: "muted small" }, "No worlds yet.")]
      : worlds.map((w) => {
          const actions = [];
          if (w.state === "asleep") actions.push(button("Start", "", async () => (await post(`/api/worlds/${w.slug}/start`), toast(`Starting ${w.name}…`), refresh())));
          if (w.state === "online" || w.state === "waking")
            actions.push(button("Put to sleep", "", async () => (await post(`/api/worlds/${w.slug}/stop`), toast(`${w.name} is asleep.`), refresh())));
          if (!w.featured) actions.push(button("Feature", "", async () => (await post(`/api/worlds/${w.slug}/feature`), toast(`Friends now join ${w.name}.`), refresh())));
          const players = w.state === "online" ? ` · ${w.players.online} playing` : "";
          return el(
            "div",
            { class: `card stack world${w.featured ? " featured" : ""}` },
            el(
              "div",
              { class: "section-head" },
              el("span", { class: "who" }, w.name),
              el("span", { class: `pill ${w.state}` }, STATE_LABEL[w.state] || w.state),
            ),
            el("p", { class: "muted small" }, `${w.featured ? "Featured · friends join this one · " : ""}Minecraft ${w.version}${players}`),
            actions.length ? el("div", { class: "row" }, ...actions) : null,
          );
        })),
  );
  $("address-note").textContent = "Worlds sleep when nobody's on and wake when an approved friend joins (about a minute).";
}

// ---- friends -------------------------------------------------------------------------------
async function loadPlayers() {
  const players = await api("/api/players");
  $("player-list").replaceChildren(
    ...players.map((p) =>
      el(
        "div",
        { class: "card row conn" },
        el("span", {}, el("span", { class: "who" }, p.name), el("span", { class: "muted small" }, ` · ${p.role === "owner" ? "you" : p.role}${p.platform === "bedrock" ? " · Bedrock" : ""}`)),
        p.role === "owner"
          ? null
          : button("Remove", "danger", async () => {
              await api(`/api/players/${p.uuid}`, { method: "DELETE" });
              toast(`${p.name} can no longer join.`);
              refresh();
            }),
      ),
    ),
  );
}

$("add-player").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("add-name");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const p = await post("/api/players", { name: input.value.trim() });
    toast(`${p.name} can join now.`);
    input.value = "";
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Claude connections ---------------------------------------------------------------------
async function loadConnections() {
  const { pending, active } = await api("/api/connections");
  $("connections").hidden = pending.length === 0;
  $("pending-list").replaceChildren(
    ...pending.map((p) =>
      el(
        "div",
        { class: "card approval stack" },
        el("p", {}, el("span", { class: "who" }, p.clientName), " is asking to manage your worlds."),
        el("p", { class: "small muted" }, "Approve only if this code matches the one on the Claude sign-in screen:"),
        el("p", { class: "code" }, p.matchCode),
        el(
          "div",
          { class: "row" },
          button("Approve", "primary", async () => (await post(`/api/connections/${encodeURIComponent(p.id)}/approve`), toast("Approved. Claude is connecting."), refresh())),
          button("Decline", "danger", async () => (await post(`/api/connections/${encodeURIComponent(p.id)}/deny`), toast("Declined."), refresh())),
        ),
      ),
    ),
  );
  $("active-list").replaceChildren(
    ...(active.length === 0
      ? [el("p", { class: "muted small" }, "Not connected yet.")]
      : active.map((a) =>
          el(
            "div",
            { class: "card row conn" },
            el("span", {}, `${a.clientName} · connected ${new Date(a.since).toLocaleDateString()}`),
            button("Disconnect", "danger", async () => (await post(`/api/clients/${encodeURIComponent(a.clientId)}/disconnect`), toast("Disconnected."), refresh())),
          ),
        )),
  );
}

// ---- notifications --------------------------------------------------------------------------
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function renderNotifyState(me) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  $("ios-hint").hidden = !(isIos && !isStandalone);
  if (!supported) {
    $("notify-state").textContent = isIos ? "Add WorldSmith to your Home Screen to get notifications." : "This browser can't receive notifications.";
    $("notify-enable").disabled = true;
    $("notify-test").disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  $("notify-state").textContent = sub
    ? `On for this device. ${me.pushSubscriptions} device(s) get alerts.`
    : Notification.permission === "denied"
      ? "Notifications are blocked for this site in your browser settings."
      : "Off. Turn them on to hear about join requests and Claude connections.";
  $("notify-enable").hidden = Boolean(sub);
  $("notify-test").disabled = me.pushSubscriptions === 0;
}

async function enableNotifications(me) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return toast("Notifications weren't allowed.");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(me.vapidPublicKey) });
  await post("/api/push/subscribe", sub);
  toast("Notifications are on.");
  boot();
}

// ---- boot ----------------------------------------------------------------------------------
function refresh() {
  return Promise.all([loadRequests(), loadWorlds(), loadPlayers(), loadConnections()]).catch((e) => toast(e.message));
}

async function boot() {
  const me = await api("/api/me");
  $("greeting").textContent = `Hi, ${String(me.name).split(" ")[0]}`;
  $("mcp-url").textContent = `${location.origin.replace(/:8443$/, "")}/mcp`;
  $("notify-enable").onclick = () => enableNotifications(me).catch((e) => toast(e.message));
  $("notify-test").onclick = async () => {
    const r = await post("/api/push/test").catch((e) => toast(e.message));
    if (r) toast(r.delivered ? "Test sent. Check your notifications." : "No device received it.");
  };
  await Promise.all([refresh(), renderNotifyState(me)]);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
boot().catch((e) => toast(e.message));
setInterval(() => document.visibilityState === "visible" && Promise.all([loadRequests(), loadConnections()]).catch(() => {}), 3000);
setInterval(() => document.visibilityState === "visible" && loadWorlds().catch(() => {}), 10000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && boot().catch(() => {}));
