// WorldSmith portal: worlds, join requests, world plans, friends, library, settings.

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
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
function button(label, cls, onClick) {
  const b = el("button", { type: "button", class: cls || "" }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick(b);
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
/** A destructive button that needs a second tap within 5 seconds. */
function confirmButton(label, confirmLabel, onConfirm) {
  let armed = false;
  return button(label, "danger", async (b) => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      setTimeout(() => ((armed = false), (b.textContent = label)), 5000);
      return;
    }
    await onConfirm(b);
  });
}
const tag = (text, cls = "") => el("span", { class: `tag ${cls}` }, text);

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
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31) || "map";
const mb = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

// ---- tabs ----------------------------------------------------------------------------------
const TABS = ["worlds", "friends", "library", "settings"];
// Notification links point at #requests / #proposals: both live in the Worlds inbox.
const ALIASES = { requests: "worlds", proposals: "worlds", inbox: "worlds" };

function showTab() {
  const raw = location.hash.slice(1);
  const name = TABS.includes(raw) ? raw : ALIASES[raw] ?? "worlds";
  for (const t of document.querySelectorAll(".tab")) t.hidden = t.dataset.tab !== name;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (ALIASES[raw] && !$("inbox").hidden) $("inbox").scrollIntoView({ block: "start" });
}
function goTo(name, target) {
  if (location.hash !== `#${name}`) location.hash = name;
  else showTab();
  if (target) requestAnimationFrame(() => $(target)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
addEventListener("hashchange", showTab);

// ---- inbox: everything waiting on the owner --------------------------------------------------
const inbox = { requests: 0, proposals: 0, connections: 0 };
function updateInbox() {
  const n = inbox.requests + inbox.proposals + inbox.connections;
  $("inbox").hidden = n === 0;
  $("inbox-badge").hidden = n === 0;
  $("inbox-badge").textContent = String(n);
}

// ---- join requests -------------------------------------------------------------------------
async function loadRequests() {
  const requests = await api("/api/requests");
  inbox.requests = requests.length;
  updateInbox();
  $("request-list").replaceChildren(
    ...requests.map((r) =>
      el(
        "article",
        { class: "card" },
        el("h3", {}, `${r.name} wants to join`),
        el(
          "p",
          { class: "muted small" },
          `${r.platform === "bedrock" ? "On Bedrock. " : ""}Tried ${r.attempts > 1 ? `${r.attempts} times, last ` : ""}${ago(r.last_seen)}.`,
        ),
        el(
          "div",
          { class: "row" },
          button("Let them in", "primary", async () => {
            await post(`/api/requests/${r.id}/approve`);
            toast(`${r.name} can join now. Tell them to try again.`);
            refresh();
          }),
          button("As operator", "", async () => {
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
        {},
        el(
          "div",
          { class: "grow" },
          el("span", { class: "who" }, r.name),
          r.platform === "bedrock" ? " " : null,
          r.platform === "bedrock" ? tag("Bedrock") : null,
          el("p", { class: "muted small" }, `Tried ${r.attempts} time${r.attempts === 1 ? "" : "s"}, last ${ago(r.last_seen)}`),
        ),
        button("Let them in", "primary", async () => {
          await post(`/api/requests/${r.id}/reopen`);
          await post(`/api/requests/${r.id}/approve`);
          toast(`${r.name} can join now. Tell them to try again.`);
          refresh();
        }),
        button("Undo decline", "", async () => {
          await post(`/api/requests/${r.id}/reopen`);
          toast(`${r.name} is back in Needs you.`);
          refresh();
        }),
      ),
    ),
  );
}

// ---- world plans (Claude's proposals, and maps or minigames you turn into worlds) ------------
const PROPOSAL_STATE = { pending: ["Waiting for you", "warn"], building: ["Building…", "warn"], approved: ["Built", "good"], declined: ["Declined", ""], failed: ["Didn't work", "risk"] };

function crossplayBlock(p, answers) {
  const cp = p.crossplay;
  const parts = [el("p", { class: "small" }, cp.summary)];
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
  if (cp.differences.length) {
    parts.push(
      el(
        "details",
        { class: "diffs" },
        el("summary", { class: "small" }, `What's different on Bedrock (${cp.differences.length})`),
        el("ul", { class: "small" }, ...cp.differences.map((d) => el("li", {}, el("strong", {}, d.feature), `: Java: ${d.java} Bedrock: ${d.bedrock}`))),
      ),
    );
  }
  return parts;
}

const proposalAnswers = {};
const proposalNotes = {};

function baseLine(p) {
  const b = p.base;
  if (b.kind === "recipe") return `Starts from ${b.name}: ${b.description}`;
  if (b.kind === "map")
    return `Starts from the map "${b.levelName}" (Minecraft ${b.version ?? "1.8 or older"}${b.needsUpgrade ? ", upgraded to 26.2 first" : ""}, ${b.sizeMb} MB, from ${b.source}).`;
  if (b.kind === "saved") return `A fresh copy of your saved minigame "${b.title}", saved from ${b.savedFrom} on ${new Date(b.savedAt).toLocaleDateString()}.`;
  return b.note;
}

function proposalCard(p) {
  const answers = (proposalAnswers[p.id] ??= {});
  const plan = p.plan;
  const pending = p.status === "pending";
  const [stateText, stateCls] = PROPOSAL_STATE[p.status] ?? [p.status, ""];
  const note = el("textarea", { id: `note-${p.id}`, rows: "2", maxlength: "1000", placeholder: "What should Claude change?" });
  note.value = proposalNotes[p.id] ?? "";
  note.addEventListener("input", () => (proposalNotes[p.id] = note.value));
  return el(
    "article",
    { class: "card" },
    el("div", { class: "row" }, el("h3", { style: "flex:1" }, plan.name), tag(stateText, stateCls)),
    el("p", { class: "muted small" }, `From ${p.createdBy}, ${ago(Date.parse(p.createdAt))}. Minecraft ${p.minecraft}.`),
    el("p", { class: "pitch" }, plan.pitch),
    el("p", { class: "small" }, baseLine(p)),
    ...(p.base.kind === "map" ? p.base.warnings.map((w) => el("p", { class: "small warn" }, w)) : []),
    p.content.length
      ? el(
          "ul",
          { class: "small plan-list" },
          ...p.content.map((c) =>
            el(
              "li",
              {},
              el("strong", {}, `${c.title} ${c.version}`),
              " ",
              tag(c.label, c.label === "No install needed" ? "good" : "warn"),
              el("br"),
              el("span", { class: "muted" }, `${c.requiredBy ? `Needed by ${c.requiredBy}` : c.why}${c.license ? ` (${c.license})` : ""}`),
            ),
          ),
        )
      : null,
    p.builds.length ? el("p", { class: "small" }, `Then builds ${p.builds.map((b) => `${b.name} (${b.steps} step${b.steps === 1 ? "" : "s"})`).join(", then ")}.`) : null,
    ...(pending ? crossplayBlock(p, answers) : []),
    p.result?.replacedBy ? el("p", { class: "muted small" }, `Replaced by a newer plan from Claude.`) : p.result?.note ? el("p", { class: "small" }, `You sent it back: "${p.result.note}"`) : null,
    p.result?.builds?.length ? el("p", { class: "small" }, `Build steps: ${p.result.builds.map((b) => `${b.name} ${b.ok ? "done" : `had ${b.failed} problem(s)`}`).join(", ")}.`) : null,
    p.result?.error ? el("p", { class: "small risk" }, p.result.error) : null,
    pending
      ? el(
          "div",
          { class: "stack" },
          button("Approve and build", "primary", async () => {
            await post(`/api/proposals/${p.id}/approve`, { answers });
            toast(`Building ${plan.name}. It shows up in Worlds when it's ready.`);
            refresh();
          }),
          el(
            "details",
            { class: "diffs" },
            el("summary", { class: "small" }, "Send it back or decline"),
            el(
              "div",
              { class: "stack", style: "margin-top:8px" },
              el("label", { class: "field", for: note.id }, "Note for Claude", note),
              el(
                "div",
                { class: "row" },
                button("Send back", "", async () => {
                  if (!note.value.trim()) return toast("Write what to change first.");
                  await post(`/api/proposals/${p.id}/decline`, { note: note.value.trim() });
                  toast("Sent back. Claude sees your note when it checks the plan.");
                  refresh();
                }),
                button("Decline", "danger", async () => {
                  await post(`/api/proposals/${p.id}/decline`);
                  toast("Declined.");
                  refresh();
                }),
              ),
            ),
          ),
        )
      : null,
  );
}

async function loadProposals() {
  const list = await api("/api/proposals");
  const open = list.filter((p) => p.status === "pending" || p.status === "building");
  const past = list.filter((p) => !(p.status === "pending" || p.status === "building"));
  inbox.proposals = open.length;
  updateInbox();
  $("proposals").hidden = past.length === 0;
  if (shouldRender("proposal-list", open)) $("proposal-list").replaceChildren(...open.map(proposalCard));
  if (shouldRender("proposal-history", past)) $("proposal-history").replaceChildren(...past.map(proposalCard));
}

// ---- saved minigames ---------------------------------------------------------------------------
async function loadGames() {
  const games = await api("/api/games");
  if (!shouldRender("game-list", games)) return;
  if (games.length === 0) {
    $("game-list").replaceChildren(el("p", { class: "muted small" }, "Nothing saved yet. Open a world's Manage menu to save it as a minigame."));
    return;
  }
  $("game-list").replaceChildren(
    ...games.map((g) => {
      const key = g.name;
      const name = el("input", { id: `gn-${key}`, value: `${g.title} ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`.slice(0, 60), maxlength: "60" });
      const bedrock = el("select", { id: `gb-${key}` }, el("option", { value: "yes" }, "Yes, Bedrock friends too"), el("option", { value: "no" }, "No, Java only"));
      bedrock.value = g.spec.crossplay?.bedrock === false ? "no" : "yes";
      const form = el(
        "div",
        { class: "stack", hidden: true },
        el("label", { class: "field", for: name.id }, "Name for the copy", name),
        el("label", { class: "field", for: bedrock.id }, "Will Bedrock players join?", bedrock),
        button("Make the copy", "primary", async () => {
          await post(`/api/games/${g.name}/copy`, { name: name.value.trim(), slug: slugify(name.value), bedrock: bedrock.value });
          toast("Review the new world under Needs you.");
          await refresh();
          goTo("worlds", "inbox");
        }),
      );
      return el(
        "article",
        { class: "card" },
        el("h3", {}, g.title),
        g.description ? el("p", { class: "small" }, g.description) : null,
        el("p", { class: "muted small" }, `Saved from ${g.source} ${ago(Date.parse(g.createdAt))}. ${mb(g.bytes)}, Minecraft ${g.spec.minecraft.version}.`),
        el(
          "div",
          { class: "row" },
          button("Start a fresh copy…", "primary", async () => (form.hidden = !form.hidden)),
          confirmButton("Delete", "Tap again to delete", async () => {
            await api(`/api/games/${g.name}`, { method: "DELETE" });
            toast(`Deleted "${g.title}". Worlds copied from it stay.`);
            refresh();
          }),
        ),
        form,
      );
    }),
  );
}

// ---- maps ----------------------------------------------------------------------------------
async function loadMaps() {
  const maps = await api("/api/maps");
  if (!shouldRender("map-list", maps)) return;
  $("map-list").replaceChildren(
    ...maps.map((m) =>
      el(
        "article",
        { class: "card" },
        ...m.worlds.map((w, i) => {
          const key = `${m.id}-${i}`;
          const name = el("input", { id: `mn-${key}`, value: w.levelName.slice(0, 60), maxlength: "60", required: true });
          const bedrock = el("select", { id: `mb-${key}` }, el("option", { value: "yes" }, "Yes, Bedrock friends too"), el("option", { value: "no" }, "No, Java only"));
          const form = el(
            "div",
            { class: "stack", hidden: true },
            el("label", { class: "field", for: name.id }, "World name", name),
            el("label", { class: "field", for: bedrock.id }, "Will Bedrock players join?", bedrock),
            button("Make the world", "primary", async () => {
              await post(`/api/maps/${m.id}/propose`, { root: w.root, name: name.value.trim(), slug: slugify(name.value), bedrock: bedrock.value });
              toast("Review the new world under Needs you.");
              await refresh();
              goTo("worlds", "inbox");
            }),
          );
          return el(
            "div",
            { class: "stack" },
            el("h3", {}, w.levelName),
            el(
              "p",
              { class: "muted small" },
              `Minecraft ${w.version ?? "1.8 or older"}, ${w.gameMode}, ${mb(w.worldBytes)}. From ${m.source.kind === "url" ? new URL(m.source.url).host : m.source.filename}, added ${ago(Date.parse(m.createdAt))}.`,
            ),
            button("Make a world from it…", "", async () => (form.hidden = !form.hidden)),
            form,
          );
        }),
        ...m.warnings.map((w) => el("p", { class: "small warn" }, w)),
        el(
          "div",
          { class: "row" },
          confirmButton("Delete map", "Tap again to delete", async () => {
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
const SVG = "http://www.w3.org/2000/svg";
/** The world's little block: three isometric faces, colored by state in CSS. */
function blockIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.setAttribute("class", "block");
  svg.setAttribute("aria-hidden", "true");
  for (const [cls, points] of [
    ["t", "22,4 40,13 22,22 4,13"],
    ["l", "4,13 22,22 22,41 4,32"],
    ["r", "22,22 40,13 40,32 22,41"],
  ]) {
    const poly = document.createElementNS(SVG, "polygon");
    poly.setAttribute("points", points);
    poly.setAttribute("class", cls);
    svg.append(poly);
  }
  return svg;
}

function statusText(w) {
  if (w.state === "online") return w.players.online > 0 ? `Online, ${w.players.online} playing` : "Online, nobody on yet";
  if (w.state === "waking") return "Waking up…";
  if (w.state === "asleep") return "Asleep. Wakes when a friend joins.";
  if (w.state === "missing") return "Not set up yet";
  return "Having trouble starting";
}

async function loadWorlds() {
  const [{ worlds }, settings] = await Promise.all([api("/api/worlds"), api("/api/settings")]);
  const lanAddress = settings.lan_address || "this computer's Wi-Fi address";
  if (!shouldRender("world-list", { worlds, lanAddress })) return;
  $("world-list").replaceChildren(
    ...(worlds.length === 0
      ? [el("p", { class: "muted small" }, "No worlds yet. Ask Claude for one, or make one from a map in Library.")]
      : worlds.map((w) => worldCard(w, lanAddress))),
  );
}

function worldCard(w, lanAddress) {
  const main = [];
  if (w.state === "asleep") main.push(button("Start", "primary", async () => (await post(`/api/worlds/${w.slug}/start`), toast(`Starting ${w.name}…`), refresh())));
  if (w.state === "online" || w.state === "waking") main.push(button("Put to sleep", "", async () => (await post(`/api/worlds/${w.slug}/stop`), toast(`${w.name} is asleep.`), refresh())));
  if (!w.featured) main.push(button("Make it the main world", "", async () => (await post(`/api/worlds/${w.slug}/feature`), toast(`Friends now join ${w.name}.`), refresh())));

  // Manage: Wi-Fi, who can join, backups, save as minigame, delete.
  const wifi = el("input", { type: "checkbox", id: `lan-${w.slug}` });
  wifi.checked = w.lanPort !== null;
  wifi.addEventListener("change", async () => {
    try {
      const v = await api(`/api/worlds/${w.slug}/lan`, { method: "PUT", body: JSON.stringify({ on: wifi.checked }) });
      toast(v.lanPort ? `People on your Wi-Fi can join ${w.name} now.` : `Wi-Fi play is off for ${w.name}.`);
    } catch (e) {
      toast(e.message);
    }
    refresh();
  });
  const accessBox = el("div", { class: "setting" });
  const backupBox = el("div", { class: "backup-list" });
  const backupsOpen = el("details", { class: "diffs" }, el("summary", { class: "small" }, "Show backups"), backupBox);
  backupsOpen.addEventListener("toggle", () => backupsOpen.open && renderBackups(w, backupBox).catch((e) => toast(e.message)));
  const title = el("input", { id: `sg-${w.slug}`, value: w.name, maxlength: "60" });
  const manage = el(
    "details",
    { class: "manage" },
    el("summary", {}, "Manage"),
    el(
      "div",
      { class: "manage-body" },
      el(
        "div",
        { class: "setting" },
        el("h4", {}, "Wi-Fi play"),
        el("label", { class: "check", for: wifi.id }, wifi, "People on my Wi-Fi can join"),
        w.lanPort
          ? el(
              "p",
              { class: "muted small" },
              `Java: it shows under LAN worlds, or use ${lanAddress}:${w.lanPort}. ` +
                (w.featured ? "Bedrock: Friends tab, LAN Games." : "Bedrock players on your Wi-Fi can only reach the main world."),
            )
          : null,
      ),
      el("div", { class: "setting" }, el("h4", {}, "Who can join"), accessBox),
      el(
        "div",
        { class: "setting" },
        el("h4", {}, "Backups"),
        el("p", { class: "muted small" }, "A backup is made each time the world goes to sleep after being played."),
        el(
          "div",
          { class: "row" },
          button("Back up now", "", async () => {
            await post(`/api/worlds/${w.slug}/backups`);
            toast(`Backed up ${w.name}.`);
            if (backupsOpen.open) renderBackups(w, backupBox);
          }),
        ),
        backupsOpen,
      ),
      el(
        "div",
        { class: "setting" },
        el("h4", {}, "Save as minigame"),
        el("p", { class: "muted small" }, "Keeps the map, builds, game setup and plugins so you can start fresh copies later. Inventories aren't saved."),
        el("label", { class: "field", for: title.id }, "Minigame name", title),
        el(
          "div",
          { class: "row" },
          button("Save minigame", "", async () => {
            const g = await post(`/api/worlds/${w.slug}/save-game`, { name: slugify(title.value).slice(0, 41), title: title.value.trim() });
            toast(`Saved "${g.title}". Find it in Library.`);
            refresh();
          }),
        ),
      ),
      el(
        "div",
        { class: "setting danger-zone" },
        el("h4", {}, "Delete world"),
        el("p", { class: "muted small" }, "Removes the world for everyone. A final backup is kept on the server."),
        el(
          "div",
          { class: "row" },
          confirmButton("Delete world", `Tap again to delete ${w.name}`, async (b) => {
            b.textContent = "Deleting…";
            await api(`/api/worlds/${w.slug}`, { method: "DELETE", body: JSON.stringify({ confirm: w.slug }) });
            toast(`Deleted ${w.name}. A final backup was kept.`);
            refresh();
          }),
        ),
      ),
    ),
  );
  // Fill access controls only once Manage is open (saves a request per world on every refresh).
  manage.addEventListener("toggle", () => manage.open && renderAccess(w, accessBox).catch((e) => toast(e.message)));

  return el(
    "article",
    { class: `card world ${w.state}${w.featured ? " featured" : ""}` },
    el("div", { class: "world-head" }, blockIcon(), el("div", {}, el("h3", {}, w.name), el("p", { class: "status" }, statusText(w)))),
    w.featured ? el("p", { class: "featured-note" }, el("strong", {}, "Main world. "), "Friends who join the server land here.") : null,
    main.length ? el("div", { class: "row" }, ...main) : null,
    manage,
  );
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
  mode.addEventListener("change", () => save({ mode: mode.value }, mode.value === "picked" ? `${w.name} is invite-only now.` : `All friends can join ${w.name}.`));
  const onlyMe = el("input", { type: "checkbox", id: `only-${w.slug}` });
  onlyMe.checked = acc.onlyWithMe;
  onlyMe.addEventListener("change", () =>
    save({ onlyWithMe: onlyMe.checked }, onlyMe.checked ? `Friends can only play ${w.name} while you're on.` : `Friends can play ${w.name} anytime.`),
  );
  const parts = [mode, el("label", { class: "check", for: onlyMe.id }, onlyMe, "Only while I'm playing")];
  if (acc.mode === "picked") {
    const friends = knownPlayers.filter((p) => p.role !== "owner");
    parts.push(
      friends.length === 0
        ? el("p", { class: "muted small" }, "No friends yet. Add some in Friends, or send an invite link for this world.")
        : el(
            "div",
            { class: "picks" },
            ...friends.map((p) => {
              const cb = el("input", { type: "checkbox", id: `m-${w.slug}-${p.uuid}` });
              cb.checked = acc.members.includes(p.uuid);
              cb.addEventListener("change", () => {
                const members = cb.checked ? [...acc.members, p.uuid] : acc.members.filter((u) => u !== p.uuid);
                save({ members }, cb.checked ? `${p.name} can join ${w.name}.` : `${p.name} can't join ${w.name} now.`);
              });
              return el("label", { class: "check", for: cb.id }, cb, p.name);
            }),
          ),
    );
  }
  box.replaceChildren(...parts);
}

// ---- backups -------------------------------------------------------------------------------
const LABELS = { sleep: "went to sleep", periodic: "every 6 hours", manual: "you", claude: "Claude", "before-apply": "before an update", "before-restore": "before a restore", "before-dimension-reset": "before a Nether/End reset" };
const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

async function renderBackups(w, box) {
  box.replaceChildren(el("p", { class: "muted small" }, "Loading backups…"));
  const list = await api(`/api/worlds/${w.slug}/backups`);
  box.replaceChildren(
    ...(list.length === 0
      ? [el("p", { class: "muted small" }, "No backups yet.")]
      : list.map((b) =>
          el(
            "div",
            { class: "row" },
            el(
              "div",
              { style: "flex:1;min-width:10rem" },
              el("p", { class: "small" }, new Date(b.createdAt).toLocaleString()),
              el("p", { class: "muted small" }, `Made ${LABELS[b.label] ? `by ${LABELS[b.label]}`.replace("by went", "when it went").replace("by every", "every").replace("by before", "before") : b.label}, ${size(b.bytes)}`),
            ),
            confirmButton("Restore", "Tap again to roll back", async (btn) => {
              btn.textContent = "Restoring…";
              await post(`/api/worlds/${w.slug}/restore`, { id: b.id });
              toast(`${w.name} is back to ${new Date(b.createdAt).toLocaleString()}. Your previous state was saved too.`);
              refresh();
            }),
          ),
        )),
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
        {},
        el(
          "div",
          { class: "grow" },
          el("p", { class: "who" }, i.world_slug ? (worlds.find((w) => w.slug === i.world_slug)?.name ?? i.world_slug) : "Any world"),
          el("p", { class: "muted small" }, `${i.max_uses - i.uses} use${i.max_uses - i.uses === 1 ? "" : "s"} left, expires ${new Date(i.expires_at).toLocaleDateString()}`),
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
  if (document.activeElement !== $("lan-address")) $("lan-address").value = settings.lan_address ?? "";
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
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ java_address: $("java-address").value.trim() || null, bedrock_address: $("bedrock-address").value.trim() || null, lan_address: $("lan-address").value.trim() || null }),
    });
    toast("Saved. Invite pages show these addresses.");
  } catch (err) {
    toast(err.message);
  }
});

// ---- friends -------------------------------------------------------------------------------
const ROLE = { owner: "You", admin: "Operator", player: "" };

async function loadPlayers() {
  const players = await api("/api/players");
  knownPlayers = players;
  $("player-list").replaceChildren(
    ...players.map((p) =>
      el(
        "div",
        {},
        el(
          "div",
          { class: "grow" },
          el("span", { class: "who" }, p.name),
          " ",
          ROLE[p.role] ? tag(ROLE[p.role], p.role === "owner" ? "good" : "") : null,
          p.platform === "bedrock" ? " " : null,
          p.platform === "bedrock" ? tag("Bedrock") : null,
        ),
        p.role === "owner"
          ? null
          : button(p.role === "admin" ? "Remove operator" : "Make operator", "", async () => {
              await api(`/api/players/${p.uuid}/role`, { method: "PUT", body: JSON.stringify({ role: p.role === "admin" ? "player" : "admin" }) });
              toast(p.role === "admin" ? `${p.name} is no longer an operator.` : `${p.name} is now an operator.`);
              refresh();
            }),
        p.role === "owner"
          ? null
          : confirmButton("Remove", "Tap again", async () => {
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
  inbox.connections = pending.length;
  updateInbox();
  $("pending-list").replaceChildren(
    ...pending.map((p) =>
      el(
        "article",
        { class: "card" },
        el("h3", {}, `${p.clientName} wants to manage your worlds`),
        el("p", { class: "muted small" }, "Approve only if this code matches the one on the Claude sign-in screen:"),
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
      ? [el("div", {}, el("p", { class: "muted small" }, "Not connected yet."))]
      : active.map((a) =>
          el(
            "div",
            {},
            el("div", { class: "grow" }, el("p", { class: "who" }, a.clientName), el("p", { class: "muted small" }, `Connected ${new Date(a.since).toLocaleDateString()}`)),
            confirmButton("Disconnect", "Tap again", async () => (await post(`/api/clients/${encodeURIComponent(a.clientId)}/disconnect`), toast("Disconnected."), refresh())),
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
    ? `On for this device. ${me.pushSubscriptions} device${me.pushSubscriptions === 1 ? "" : "s"} get alerts.`
    : Notification.permission === "denied"
      ? "Notifications are blocked for this site in your browser settings."
      : "Off. Turn them on to hear about join requests, new world plans and Claude connections.";
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
    await Promise.all([loadRequests(), loadDeclined(), loadProposals(), loadGames(), loadMaps(), loadWorlds(), loadConnections()]);
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
  showTab();
}

showTab();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
boot().catch((e) => toast(e.message));
setInterval(() => document.visibilityState === "visible" && Promise.all([loadRequests(), loadConnections(), loadProposals()]).catch(() => {}), 3000);
setInterval(() => document.visibilityState === "visible" && loadWorlds().catch(() => {}), 10000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && boot().catch(() => {}));
