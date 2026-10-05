// WorldSmith portal (Phase 0): world status, Claude connection approvals, push notifications.

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
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// ---- world ---------------------------------------------------------------------------------
async function loadWorld() {
  const w = await api("/api/world").catch((e) => ({ online: false, reason: e.message }));
  const pill = $("world-pill");
  pill.textContent = w.online ? "Online" : "Offline";
  pill.className = `pill ${w.online ? "online" : "offline"}`;
  $("world-motd").textContent = w.online ? w.motd || "(no message)" : "The world isn't answering right now.";
  $("world-version").textContent = w.online ? w.version : "–";
  $("world-players").textContent = w.online ? `${w.players.online} / ${w.players.max}` : "–";
  $("world-latency").textContent = w.online ? `${w.latencyMs} ms` : "–";
}

// ---- Claude connections ---------------------------------------------------------------------
async function decide(id, decision, button) {
  button.disabled = true;
  try {
    await api(`/api/connections/${encodeURIComponent(id)}/${decision}`, { method: "POST" });
    toast(decision === "approve" ? "Approved. Claude is connecting." : "Declined.");
  } catch (e) {
    toast(e.message);
  }
  loadConnections();
}

async function disconnect(clientId, button) {
  button.disabled = true;
  await api(`/api/clients/${encodeURIComponent(clientId)}/disconnect`, { method: "POST" }).catch((e) => toast(e.message));
  toast("Disconnected. Claude will need approval to reconnect.");
  loadConnections();
}

async function loadConnections() {
  const { pending, active } = await api("/api/connections");
  $("connections").hidden = pending.length === 0;
  $("pending-list").replaceChildren(
    ...pending.map((p) => {
      const approve = el("button", { type: "button", class: "primary" }, "Approve");
      const deny = el("button", { type: "button", class: "danger" }, "Decline");
      approve.addEventListener("click", () => decide(p.id, "approve", approve));
      deny.addEventListener("click", () => decide(p.id, "deny", deny));
      return el(
        "div",
        { class: "card approval stack" },
        el("p", {}, el("span", { class: "who" }, p.clientName), " is asking to manage your worlds."),
        el("p", { class: "small muted" }, "Approve only if this code matches the one on the Claude sign-in screen:"),
        el("p", { class: "code" }, p.matchCode),
        el("div", { class: "row" }, approve, deny),
      );
    }),
  );
  $("active-list").replaceChildren(
    ...(active.length === 0
      ? [el("p", { class: "muted small" }, "Not connected yet.")]
      : active.map((a) => {
          const btn = el("button", { type: "button", class: "danger" }, "Disconnect");
          btn.addEventListener("click", () => disconnect(a.clientId, btn));
          return el(
            "div",
            { class: "card row conn" },
            el("span", {}, `${a.clientName} · connected ${new Date(a.since).toLocaleDateString()}`),
            btn,
          );
        })),
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
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(me.vapidPublicKey),
  });
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub) });
  toast("Notifications are on.");
  boot();
}

// ---- boot ----------------------------------------------------------------------------------
async function boot() {
  const me = await api("/api/me");
  $("greeting").textContent = `Hi, ${String(me.name).split(" ")[0]}`;
  $("mcp-url").textContent = `${location.origin.replace(/:8443$/, "")}/mcp`;
  $("notify-enable").onclick = () => enableNotifications(me).catch((e) => toast(e.message));
  $("notify-test").onclick = async () => {
    const r = await api("/api/push/test", { method: "POST" }).catch((e) => toast(e.message));
    if (r) toast(r.delivered ? "Test sent. Check your notifications." : "No device received it.");
  };
  await Promise.all([loadWorld(), loadConnections(), renderNotifyState(me)]);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
boot().catch((e) => toast(e.message));
setInterval(() => document.visibilityState === "visible" && loadConnections().catch(() => {}), 3000);
setInterval(() => document.visibilityState === "visible" && loadWorld(), 15000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && boot().catch(() => {}));
