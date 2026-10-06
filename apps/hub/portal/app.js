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
// Background refreshes must not rebuild a list while someone is choosing in it (iPhone closes an
// open picker when its element is replaced), and needn't rebuild a list that hasn't changed.
const lastRender = {};
function shouldRender(id, data) {
  const a = document.activeElement;
  if ($(id).contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return false;
  const sig = JSON.stringify(data);
  if (lastRender[id] === sig) return false;
  lastRender[id] = sig;
  return true;
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
        el("p", {}, el("span", { class: "who" }, r.name), r.platform === "bedrock" ? el("span", { class: "pill" }, "Bedrock") : null, ` tried to join${r.attempts > 1 ? ` ${r.attempts} times` : ""} · ${ago(r.last_seen)}`),
        el(
          "div",
          { class: "row" },
          button("Let them in", "primary", async () => {
            await post(`/api/requests/${r.id}/approve`);
            toast(`${r.name} can join now. Tell them to try again.`);
            refresh();
          }),
          button("Make operator", "", async () => {
            await post(`/api/requests/${r.id}/approve`, { role: "admin" });
            toast(`${r.name} can join now, as an operator.`);
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

// ---- declined bucket ------------------------------------------------------------------------
async function loadDeclined() {
  const list = await api("/api/requests/declined");
  $("declined").hidden = list.length === 0;
  $("declined-count").textContent = String(list.length);
  $("declined-list").replaceChildren(
    ...list.map((r) =>
      el(
        "div",
        { class: "card stack" },
        el(
          "p",
          {},
          el("span", { class: "who" }, r.name),
          r.platform === "bedrock" ? el("span", { class: "pill" }, "Bedrock") : null,
          ` · tried ${r.attempts} time${r.attempts === 1 ? "" : "s"} · last ${ago(r.last_seen)}`,
        ),
        el(
          "div",
          { class: "row" },
          button("Undo decline", "", async () => {
            await post(`/api/requests/${r.id}/reopen`);
            toast(`${r.name} is back in "Wants to join".`);
            refresh();
          }),
          button("Let them in", "primary", async () => {
            await post(`/api/requests/${r.id}/reopen`);
            await post(`/api/requests/${r.id}/approve`);
            toast(`${r.name} can join now. Tell them to try again.`);
            refresh();
          }),
        ),
      ),
    ),
  );
}

// ---- new worlds to review (Claude's proposals, and maps you turn into worlds) ----------------
const PROPOSAL_STATE = { pending: "Waiting for you", building: "Building…", approved: "Built", declined: "Declined", failed: "Didn't work" };
const mb = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

function crossplayBlock(p, answers) {
  const cp = p.crossplay;
  const parts = [el("p", { class: "small" }, cp.summary)];
  if (p.status === "pending") {
    for (const q of cp.questions) {
      const key = q.id === "bedrock_players" ? "bedrockPlayers" : q.id;
      const sel = el("select", { id: `q-${p.id}-${q.id}` }, el("option", { value: "" }, "Choose…"), ...q.options.map((o) => el("option", { value: o.value }, o.label)));
      const detail = el("p", { class: "muted small" }, "");
      const show = () => (detail.textContent = q.options.find((o) => o.value === sel.value)?.detail ?? "");
      if (answers[key]) sel.value = answers[key];
      show();
      sel.addEventListener("change", () => {
        answers[key] = sel.value || undefined;
        show();
      });
      parts.push(el("label", { class: "field", for: sel.id }, q.prompt, sel), detail);
    }
  }
  if (cp.differences.length) {
    parts.push(
      el(
        "details",
        { class: "diffs" },
        el("summary", { class: "small" }, `What's different on Bedrock (${cp.differences.length})`),
        el("ul", { class: "small" }, ...cp.differences.map((d) => el("li", {}, el("strong", {}, d.feature), ` · Java: ${d.java} Bedrock: ${d.bedrock}`))),
      ),
    );
  }
  return parts;
}

const proposalAnswers = {};

async function loadProposals() {
  const list = await api("/api/proposals");
  const open = list.filter((p) => p.status === "pending" || p.status === "building");
  $("proposals").hidden = list.length === 0;
  if (!shouldRender("proposal-list", list)) return;
  $("proposal-list").replaceChildren(
    ...list.map((p) => {
      const answers = (proposalAnswers[p.id] ??= {});
      const r = p.request;
      const facts = p.map
        ? `From "${p.map.levelName}" · Minecraft ${p.map.version ?? "1.8 or older"}${p.map.needsUpgrade ? " (upgraded to 26.2 on first start)" : ""} · ${p.map.sizeMb} MB · ${p.map.source}`
        : "The downloaded map is gone.";
      return el(
        "div",
        { class: `card stack${p.status === "pending" ? " approval" : ""}` },
        el("div", { class: "section-head" }, el("span", { class: "who" }, r.name), el("span", { class: `pill ${p.status}` }, PROPOSAL_STATE[p.status] ?? p.status)),
        el("p", { class: "muted small" }, `${p.createdBy} · ${ago(Date.parse(p.createdAt))}`),
        r.notes ? el("p", { class: "notes" }, r.notes) : null,
        el("p", { class: "small" }, facts),
        ...(p.map?.warnings ?? []).map((w) => el("p", { class: "small warn" }, w)),
        ...(p.status === "pending" ? crossplayBlock(p, answers) : []),
        p.result?.error ? el("p", { class: "small risk" }, p.result.error) : null,
        p.status === "pending"
          ? el(
              "div",
              { class: "row" },
              button("Approve and build", "primary", async () => {
                const done = await post(`/api/proposals/${p.id}/approve`, { answers });
                toast(done.status === "approved" ? `${r.name} is ready. Start it from Worlds.` : `Couldn't build it: ${done.result?.error ?? done.status}`);
                refresh();
              }),
              button("Decline", "danger", async () => {
                await post(`/api/proposals/${p.id}/decline`);
                toast("Declined.");
                refresh();
              }),
            )
          : null,
      );
    }),
  );
  if (open.length && location.hash === "#proposals") $("proposals").scrollIntoView();
}

// ---- maps ----------------------------------------------------------------------------------
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31) || "map";

async function loadMaps() {
  const maps = await api("/api/maps");
  if (!shouldRender("map-list", maps)) return;
  $("map-list").replaceChildren(
    ...maps.map((m) =>
      el(
        "div",
        { class: "card stack" },
        ...m.worlds.map((w, i) => {
          const key = `${m.id}-${i}`;
          const name = el("input", { id: `mn-${key}`, value: w.levelName.slice(0, 60), maxlength: "60", required: "" });
          const bedrock = el("select", { id: `mb-${key}` }, el("option", { value: "yes" }, "Yes, Bedrock friends too"), el("option", { value: "no" }, "No, Java only"));
          const form = el(
            "div",
            { class: "stack make", hidden: "" },
            el("label", { class: "field", for: name.id }, "World name", name),
            el("label", { class: "field", for: bedrock.id }, "Will Bedrock players join?", bedrock),
            button("Make a world", "primary", async () => {
              await post(`/api/maps/${m.id}/propose`, { root: w.root, name: name.value.trim(), slug: slugify(name.value), bedrock: bedrock.value });
              toast("Review it under New worlds to review.");
              await refresh();
              $("proposals").scrollIntoView({ behavior: "smooth" });
            }),
          );
          return el(
            "div",
            { class: "stack" },
            el("div", { class: "section-head" }, el("span", { class: "who" }, w.levelName), el("span", { class: "pill" }, `MC ${w.version ?? "≤1.8"}`)),
            el(
              "p",
              { class: "muted small" },
              `${w.gameMode} · ${mb(w.worldBytes)} · ${m.source.kind === "url" ? new URL(m.source.url).host : m.source.filename} · added ${ago(Date.parse(m.createdAt))}`,
            ),
            button("Make a world…", "", async () => {
              form.hidden = !form.hidden;
            }),
            form,
          );
        }),
        ...m.warnings.map((w) => el("p", { class: "small warn" }, w)),
        el(
          "div",
          { class: "row" },
          button("Delete map", "danger", async () => {
            await api(`/api/maps/${m.id}`, { method: "DELETE" });
            toast("Map deleted. Worlds made from it stay.");
            refresh();
          }),
        ),
      ),
    ),
  );
}

$("map-upload").addEventListener("submit", (e) => {
  e.preventDefault();
  const file = $("map-file").files[0];
  if (!file) return;
  const btn = e.target.querySelector("button");
  const bar = $("map-progress");
  btn.disabled = true;
  bar.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/maps/upload?filename=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader("X-WorldSmith", "1");
  xhr.setRequestHeader("Content-Type", "application/zip");
  xhr.upload.onprogress = (ev) => ev.lengthComputable && (bar.value = ev.loaded / ev.total);
  xhr.onloadend = () => {
    btn.disabled = false;
    bar.hidden = true;
    bar.value = 0;
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status !== 200) return toast(data.error || `Upload failed (${xhr.status || "connection lost"})`);
    $("map-file").value = "";
    toast(`Added "${data.worlds?.[0]?.levelName ?? file.name}". Tap Make a world when you're ready.`);
    refresh();
  };
  xhr.send(file);
});

$("map-link").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Downloading…";
  try {
    const m = await post("/api/maps/import", { url: $("map-url").value.trim() });
    $("map-url").value = "";
    toast(`Added "${m.worlds?.[0]?.levelName ?? "map"}".`);
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download";
  }
});

// ---- worlds --------------------------------------------------------------------------------
const STATE_LABEL = { online: "Online", waking: "Waking up", asleep: "Asleep", missing: "Not set up", error: "Trouble" };

async function loadWorlds() {
  const { worlds } = await api("/api/worlds");
  if (!shouldRender("world-list", worlds)) return;
  $("world-list").replaceChildren(
    ...(worlds.length === 0
      ? [el("p", { class: "muted small" }, "No worlds yet.")]
      : worlds.map((w) => {
          const actions = [];
          if (w.state === "asleep") actions.push(button("Start", "", async () => (await post(`/api/worlds/${w.slug}/start`), toast(`Starting ${w.name}…`), refresh())));
          if (w.state === "online" || w.state === "waking")
            actions.push(button("Put to sleep", "", async () => (await post(`/api/worlds/${w.slug}/stop`), toast(`${w.name} is asleep.`), refresh())));
          if (!w.featured) actions.push(button("Feature", "", async () => (await post(`/api/worlds/${w.slug}/feature`), toast(`Friends now join ${w.name}.`), refresh())));
          const backupBox = el("div", { class: "stack backups", hidden: "" });
          actions.push(
            button("Backups", "", async () => {
              backupBox.hidden = !backupBox.hidden;
              if (!backupBox.hidden) await renderBackups(w, backupBox);
            }),
          );
          const players = w.state === "online" ? ` · ${w.players.online} playing` : "";
          const accessBox = el("div", { class: "stack access" });
          renderAccess(w, accessBox).catch((e) => toast(e.message));
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
            accessBox,
            backupBox,
          );
        })),
  );
  $("address-note").textContent = "Worlds sleep when nobody's on and wake when an approved friend joins (about a minute).";
}

// ---- per-world access ------------------------------------------------------------------------
let knownPlayers = [];

async function renderAccess(w, box) {
  const acc = await api(`/api/worlds/${w.slug}/access`);
  const save = async (change, msg) => {
    try {
      await api(`/api/worlds/${w.slug}/access`, { method: "PUT", body: JSON.stringify(change) });
      toast(msg);
    } catch (e) {
      toast(e.message);
    }
    renderAccess(w, box);
  };
  const mode = el(
    "select",
    { "aria-label": `Who can join ${w.name}` },
    el("option", { value: "everyone" }, "Everyone on my friends list"),
    el("option", { value: "picked" }, "Only people I pick"),
  );
  mode.value = acc.mode;
  mode.addEventListener("change", () =>
    save({ mode: mode.value }, mode.value === "picked" ? `${w.name} is invite-only now.` : `All friends can join ${w.name}.`),
  );
  const onlyMe = el("input", { type: "checkbox", id: `only-${w.slug}` });
  onlyMe.checked = acc.onlyWithMe;
  onlyMe.addEventListener("change", () =>
    save(
      { onlyWithMe: onlyMe.checked },
      onlyMe.checked ? `Friends can only play ${w.name} while you're on.` : `Friends can play ${w.name} anytime.`,
    ),
  );
  const parts = [
    el("label", { class: "field" }, "Who can join", mode),
    el("label", { class: "check", for: `only-${w.slug}` }, onlyMe, " Only when I'm playing"),
  ];
  if (acc.mode === "picked") {
    const friends = knownPlayers.filter((p) => p.role !== "owner");
    parts.push(
      friends.length === 0
        ? el("p", { class: "muted small" }, "No friends yet. Add some below, or send an invite link for this world.")
        : el(
            "div",
            { class: "row picks" },
            ...friends.map((p) => {
              const cb = el("input", { type: "checkbox", id: `m-${w.slug}-${p.uuid}` });
              cb.checked = acc.members.includes(p.uuid);
              cb.addEventListener("change", () => {
                const members = cb.checked ? [...acc.members, p.uuid] : acc.members.filter((u) => u !== p.uuid);
                save({ members }, cb.checked ? `${p.name} can join ${w.name}.` : `${p.name} can't join ${w.name} now.`);
              });
              return el("label", { class: "check", for: cb.id }, cb, ` ${p.name}`);
            }),
          ),
    );
  }
  box.replaceChildren(...parts);
}

// ---- backups -------------------------------------------------------------------------------
const LABELS = { sleep: "went to sleep", periodic: "every 6 hours", manual: "you", claude: "Claude", "before-apply": "before an update", "before-restore": "before a restore" };
const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

async function renderBackups(w, box) {
  box.replaceChildren(el("p", { class: "muted small" }, "Loading backups…"));
  const list = await api(`/api/worlds/${w.slug}/backups`);
  const now = button("Back up now", "primary", async () => {
    await post(`/api/worlds/${w.slug}/backups`);
    toast(`Backed up ${w.name}.`);
    renderBackups(w, box);
  });
  box.replaceChildren(
    now,
    ...(list.length === 0
      ? [el("p", { class: "muted small" }, "No backups yet. One is made automatically each time the world goes to sleep after being played.")]
      : list.map((b) => {
          let armed = false;
          const restore = button("Restore", "danger", async () => {
            if (!armed) {
              armed = true;
              restore.textContent = "Tap again to roll back";
              setTimeout(() => {
                armed = false;
                restore.textContent = "Restore";
              }, 5000);
              return;
            }
            restore.textContent = "Restoring…";
            await post(`/api/worlds/${w.slug}/restore`, { id: b.id });
            toast(`${w.name} is back to ${new Date(b.createdAt).toLocaleString()}. Your previous state was saved too.`);
            refresh();
          });
          return el(
            "div",
            { class: "row conn backup" },
            el("span", { class: "small" }, `${new Date(b.createdAt).toLocaleString()} · ${LABELS[b.label] ?? b.label} · ${size(b.bytes)}`),
            restore,
          );
        })),
  );
}

// ---- invites -------------------------------------------------------------------------------
async function loadInvites(worlds) {
  const sel = $("invite-world");
  const current = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "Any world they're allowed on"), ...worlds.map((w) => el("option", { value: w.slug }, w.name)));
  sel.value = current;
  const invites = await api("/api/invites");
  $("invite-list").replaceChildren(
    ...invites.map((i) =>
      el(
        "div",
        { class: "card row conn" },
        el(
          "span",
          { class: "small" },
          `${i.world_slug ? (worlds.find((w) => w.slug === i.world_slug)?.name ?? i.world_slug) : "Any world"} · ${i.max_uses - i.uses} use(s) left · expires ${new Date(i.expires_at).toLocaleDateString()}`,
        ),
        button("Revoke", "danger", async () => {
          await api(`/api/invites/${i.id}`, { method: "DELETE" });
          toast("Invite revoked.");
          refresh();
        }),
      ),
    ),
  );
  const settings = await api("/api/settings");
  if (document.activeElement !== $("java-address")) $("java-address").value = settings.java_address ?? "";
  if (document.activeElement !== $("bedrock-address")) $("bedrock-address").value = settings.bedrock_address ?? "";
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const body = { days: Number($("invite-days").value), maxUses: Number($("invite-uses").value) };
    if ($("invite-world").value) body.world = $("invite-world").value;
    const { url } = await post("/api/invites", body);
    const share = button("Share link", "primary", async () => {
      if (navigator.share) await navigator.share({ title: "Join my Minecraft server", text: "You're invited to my Minecraft server:", url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      }
    });
    const copy = button("Copy", "", async () => {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    });
    $("invite-result").replaceChildren(el("code", { class: "url" }, url), el("div", { class: "row" }, share, copy));
    $("invite-result").hidden = false;
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$("address-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ java_address: $("java-address").value.trim() || null, bedrock_address: $("bedrock-address").value.trim() || null }) });
    toast("Saved. Invite pages will show these addresses.");
  } catch (err) {
    toast(err.message);
  }
});

// ---- friends -------------------------------------------------------------------------------
async function loadPlayers() {
  const players = await api("/api/players");
  knownPlayers = players;
  $("player-list").replaceChildren(
    ...players.map((p) =>
      el(
        "div",
        { class: "card row conn" },
        el("span", {}, el("span", { class: "who" }, p.name), el("span", { class: "muted small" }, ` · ${p.role === "owner" ? "you" : p.role}${p.platform === "bedrock" ? " · Bedrock" : ""}`)),
        p.role === "owner"
          ? null
          : button(p.role === "admin" ? "Remove operator" : "Make operator", "", async () => {
              await api(`/api/players/${p.uuid}/role`, { method: "PUT", body: JSON.stringify({ role: p.role === "admin" ? "player" : "admin" }) });
              toast(p.role === "admin" ? `${p.name} is no longer an operator.` : `${p.name} is now an operator.`);
              refresh();
            }),
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
    const p = await post("/api/players", { name: input.value.trim(), platform: $("add-platform").value });
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
async function refresh() {
  try {
    await loadPlayers(); // world access controls need the friends list
    await Promise.all([loadRequests(), loadDeclined(), loadProposals(), loadMaps(), loadWorlds(), loadConnections()]);
    await loadInvites((await api("/api/worlds")).worlds);
  } catch (e) {
    toast(e.message);
  }
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
setInterval(() => document.visibilityState === "visible" && Promise.all([loadRequests(), loadConnections(), loadProposals()]).catch(() => {}), 3000);
setInterval(() => document.visibilityState === "visible" && loadWorlds().catch(() => {}), 10000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && boot().catch(() => {}));
