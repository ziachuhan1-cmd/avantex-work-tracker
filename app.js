const STORAGE_KEY = "avantex-work-tracker-v1";
const SUPABASE_URL = "https://lrgqryhggolksgdhimci.supabase.co";
const SUPABASE_KEY = "sb_publishable_l0zZ3C1EAwZrOOMK6W4CTA_BwxMwdu3";
const CANONICAL_HOST = "avantexwork.xyz";
const IS_LOCAL_PREVIEW = ["localhost", "127.0.0.1", ""].includes(window.location.hostname);
const APP_REDIRECT_URL = IS_LOCAL_PREVIEW ? window.location.origin : `https://${CANONICAL_HOST}`;
const EMAILJS_SERVICE_ID = "service_diufs8y";
const EMAILJS_TEMPLATE_ID = "template_1kjiba2";
const EMAILJS_PUBLIC_KEY = "p5VI1lrJJ0QDqcvKR";
const SESSION_KEY = "avantex-supabase-session";
const WORKSPACE_KEY = "avantex-current-workspace";
const INVITE_KEY = "avantex-pending-invite";
const THEME_KEY = "avantex-theme";
const VIEW_KEY = "avantex-current-view";

if (!IS_LOCAL_PREVIEW && window.location.hostname !== CANONICAL_HOST) {
  window.location.replace(`${APP_REDIRECT_URL}${window.location.pathname}${window.location.search}${window.location.hash}`);
}

const sampleTeam = [];

let state = { team: [], attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
let toastTimer = null;
let supabaseClient = null;
let usingSupabase = false;
let currentUser = null;
let currentProfile = null;
let currentWorkspace = null;
let workspaceMemberships = [];
let availableWorkspaces = [];
let workspaceInvites = [];
let authMode = "signup";
let passwordRecoveryMode = false;
let emailJsLoadPromise = null;
let autoRefreshTimer = null;
let autoRefreshRunning = false;
let lastSyncedAt = null;
let cancelledInviteIds = new Set();
let workspaceCreateOpen = false;
let selectedChatThreadId = "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const todayKey = () => localDateKey(new Date());

function applyTheme(theme = localStorage.getItem(THEME_KEY) || "light") {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem(THEME_KEY, nextTheme);
  const themeButton = document.querySelector('[data-profile-action="theme"]');
  if (themeButton) themeButton.textContent = nextTheme === "dark" ? "Switch to Day Mode" : "Switch to Night Mode";
}

function authRedirectUrl() {
  const inviteToken = rememberInviteToken();
  return inviteToken ? inviteUrl(inviteToken) : APP_REDIRECT_URL;
}

function authErrorMessage(error) {
  const message = error?.message || error?.error_description || error?.error || "Login request failed. Try again.";
  const lower = message.toLowerCase();
  if (lower.includes("email not confirmed")) {
    return "Email not confirmed. Click Resend Confirmation Email, then open the email link.";
  }
  if (lower.includes("invalid login credentials")) {
    return "Email or password is wrong. For old accounts, click Forgot / Set Password.";
  }
  if (lower.includes("already registered") || lower.includes("user already")) {
    return "This email already has an account. Switch to Login or use Forgot / Set Password.";
  }
  if (lower.includes("redirect") || lower.includes("not allowed")) {
    return "Auth redirect was blocked. Use the live Avantex Flow link, then try again.";
  }
  if (lower.includes("role_label") || lower.includes("invite row")) {
    return "Invite setup needs the latest Supabase SQL patch. Ask the owner to run invite-role-label-repair.sql, then login again with the invited email.";
  }
  if (lower.includes("network")) {
    return "Network connection failed. Check internet, then try again.";
  }
  return message;
}

function uid() {
  return crypto.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function inviteUrl(token) {
  return `${APP_REDIRECT_URL}?invite=${encodeURIComponent(token)}`;
}

function inviteEmailContent(email, token, roleLabel = "Team Member") {
  const url = inviteUrl(token);
  const workspaceName = currentWorkspace?.name || "your workspace";
  return {
    to_email: email,
    to_name: email.split("@")[0],
    from_name: currentProfile?.display_name || currentUser?.email || "Workspace Admin",
    name: currentProfile?.display_name || currentUser?.email || "Workspace Admin",
    email: currentUser?.email || "",
    time: new Date().toLocaleString(),
    title: `${workspaceName} invitation`,
    workspace_name: workspaceName,
    role_label: roleLabel,
    invite_link: url,
    subject: `${workspaceName} invitation`,
    message: [
      `You have been invited to join ${workspaceName} on Avantex Flow as ${roleLabel}.`,
      "",
      "Open this invite link:",
      url,
      "",
      "If you do not have an account, sign up with this same email first. After email confirmation, login and the invite will be accepted."
    ].join("\n")
  };
}

function emailJsReady() {
  return Boolean(EMAILJS_SERVICE_ID && EMAILJS_TEMPLATE_ID && EMAILJS_PUBLIC_KEY);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((script) => script.src === src);
    if (existing && window.emailjs?.send) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureEmailJsReady() {
  if (!emailJsReady()) return false;
  if (window.emailjs?.send) return true;
  if (!emailJsLoadPromise) {
    emailJsLoadPromise = (async () => {
      const urls = [
        "https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js",
        "https://unpkg.com/@emailjs/browser@4/dist/email.min.js"
      ];
      for (const url of urls) {
        try {
          await loadScript(url);
          if (window.emailjs?.send) return true;
        } catch {
          // Try the next CDN.
        }
      }
      return false;
    })();
  }
  return emailJsLoadPromise;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function reportRangeFromPreset(preset = $("#reportPreset")?.value || "today") {
  const today = new Date();
  const todayDate = todayKey();
  if (preset === "week") {
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() + 1);
    return { start: localDateKey(start), end: todayDate, label: "This Week" };
  }
  if (preset === "month") {
    return { start: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`, end: todayDate, label: "This Month" };
  }
  if (preset === "year") {
    return { start: `${today.getFullYear()}-01-01`, end: todayDate, label: "This Year" };
  }
  if (preset === "custom") {
    const start = $("#reportStartDate")?.value || todayDate;
    const end = $("#reportEndDate")?.value || start;
    return { start, end, label: "Custom" };
  }
  return { start: todayDate, end: todayDate, label: "Today" };
}

function datesBetween(startDate, endDate) {
  const dates = [];
  if (!startDate || !endDate || startDate > endDate) return dates;
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return {
      team: sampleTeam,
      attendance: [],
      work: [],
      assignments: [],
      chatThreads: [],
      chatMessages: []
    };
  }

  try {
    const parsed = JSON.parse(stored);
    return {
      team: Array.isArray(parsed.team) ? parsed.team : sampleTeam,
      attendance: Array.isArray(parsed.attendance) ? parsed.attendance : [],
      work: Array.isArray(parsed.work) ? parsed.work : [],
      assignments: Array.isArray(parsed.assignments) ? parsed.assignments : [],
      chatThreads: Array.isArray(parsed.chatThreads) ? parsed.chatThreads : [],
      chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages : []
    };
  } catch {
    return { team: sampleTeam, attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
  }
}

function createRestSupabaseClient(url, key) {
  let session = loadSession();

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  function saveSession(nextSession) {
    session = nextSession;
    localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
  }

  async function request(path, options = {}) {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${session?.access_token || key}`,
      ...options.headers
    };
    let response;
    try {
      response = await fetch(`${url}${path}`, {
        ...options,
        headers
      });
    } catch {
      return {
        data: null,
        error: new Error("Network connection failed. Check internet, then try again.")
      };
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text || response.statusText };
    }
    if (!response.ok) {
      const message = payload?.msg || payload?.message || payload?.error_description || payload?.error || payload?.hint || response.statusText || `Request failed (${response.status})`;
      return {
        data: null,
        error: new Error(message)
      };
    }
    return { data: payload, error: null };
  }

  async function refreshSessionIfNeeded() {
    if (!session?.refresh_token) return session;
    const expiresAt = Number(session.expires_at || 0);
    if (expiresAt && expiresAt - 60 > Math.floor(Date.now() / 1000)) return session;
    const result = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (result.error) {
      localStorage.removeItem(SESSION_KEY);
      session = null;
      return null;
    }
    saveSession(result.data);
    return session;
  }

  class RestQuery {
    constructor(table) {
      this.table = table;
      this.method = "GET";
      this.params = new URLSearchParams();
      this.body = null;
      this.extraHeaders = {};
      this.single = false;
    }

    select(columns = "*") {
      this.method = "GET";
      this.params.set("select", columns);
      return this;
    }

    eq(column, value) {
      this.params.set(column, `eq.${value}`);
      return this;
    }

    in(column, values) {
      this.params.set(column, `in.(${values.join(",")})`);
      return this;
    }

    gte(column, value) {
      this.params.set(column, `gte.${value}`);
      return this;
    }

    lte(column, value) {
      this.params.set(column, `lte.${value}`);
      return this;
    }

    order(column, options = {}) {
      this.params.set("order", `${column}.${options.ascending === false ? "desc" : "asc"}`);
      return this;
    }

    maybeSingle() {
      this.single = true;
      return this.execute();
    }

    insert(payload) {
      this.method = "POST";
      this.body = payload;
      this.extraHeaders.Prefer = "return=representation";
      return this;
    }

    update(payload) {
      this.method = "PATCH";
      this.body = payload;
      this.extraHeaders.Prefer = "return=representation";
      return this;
    }

    delete() {
      this.method = "DELETE";
      this.extraHeaders.Prefer = "return=representation";
      return this;
    }

    upsert(payload, options = {}) {
      this.method = "POST";
      this.body = payload;
      if (options.onConflict) this.params.set("on_conflict", options.onConflict);
      this.extraHeaders.Prefer = "resolution=merge-duplicates,return=representation";
      return this;
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute() {
      await refreshSessionIfNeeded();
      const query = this.params.toString();
      const result = await request(`/rest/v1/${this.table}${query ? `?${query}` : ""}`, {
        method: this.method,
        headers: {
          "Content-Type": "application/json",
          ...this.extraHeaders
        },
        body: this.body ? JSON.stringify(this.body) : undefined
      });
      if (result.error) return result;
      if (this.single && Array.isArray(result.data)) {
        return { data: result.data[0] || null, error: null };
      }
      return result;
    }
  }

  return {
    auth: {
      async getSession() {
        await refreshSessionIfNeeded();
        return { data: { session }, error: null };
      },
      async setSession(nextSession) {
        saveSession(nextSession);
        return { data: { session }, error: null };
      },
      async getUser() {
        await refreshSessionIfNeeded();
        return request("/auth/v1/user", { method: "GET" });
      },
      async signInWithPassword(credentials) {
        const result = await request("/auth/v1/token?grant_type=password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials)
        });
        if (result.error) return result;
        saveSession(result.data);
        return { data: result.data, error: null };
      },
      async signUp(credentials) {
        const redirectUrl = authRedirectUrl();
        const result = await request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectUrl)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: credentials.email,
            password: credentials.password,
            data: credentials.data || {}
          })
        });
        if (result.error) return result;
        if (result.data?.access_token) saveSession(result.data);
        if (result.data?.session?.access_token) saveSession(result.data.session);
        return { data: result.data, error: null };
      },
      async resendConfirmation(email) {
        return request("/auth/v1/resend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "signup",
            email,
            options: { email_redirect_to: authRedirectUrl() }
          })
        });
      },
      async requestPasswordReset(email) {
        return request(`/auth/v1/recover?redirect_to=${encodeURIComponent(authRedirectUrl())}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
      },
      async updatePassword(password) {
        return request("/auth/v1/user", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password })
        });
      },
      async signOut() {
        await request("/auth/v1/logout", { method: "POST" });
        localStorage.removeItem(SESSION_KEY);
        session = null;
        return { error: null };
      }
    },
    from(table) {
      return new RestQuery(table);
    },
    async rpc(name, payload = {}) {
      await refreshSessionIfNeeded();
      return request(`/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
  };
}

function saveState(message) {
  if (!usingSupabase) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  render();
  if (message) showToast(message);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function formatTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-PK", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-PK", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

function formatDay(value) {
  return new Intl.DateTimeFormat("en-PK", {
    weekday: "long"
  }).format(new Date(`${value}T12:00:00`));
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat("en-PK", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00`));
}

function formatDateTimeWithDay(value) {
  const date = new Date(value);
  return {
    day: new Intl.DateTimeFormat("en-PK", { weekday: "long" }).format(date),
    date: new Intl.DateTimeFormat("en-PK", { day: "2-digit", month: "short", year: "numeric" }).format(date),
    time: formatTime(value)
  };
}

function toDateTimeLocal(value) {
  const date = new Date(value);
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date - offsetMs).toISOString().slice(0, 16);
}

function dateFromTimestamp(value) {
  return localDateKey(new Date(value));
}

function getPerson(id) {
  return state.team.find((person) => person.id === id);
}

function activeTeam() {
  return state.team.filter((person) => person.active !== false);
}

function reportTeam() {
  return canManageWorkspace() ? activeTeam() : visibleTeam();
}

function personJoinDate(person) {
  return dateFromTimestamp(person.joinedAt || person.createdAt || currentWorkspace?.created_at || new Date().toISOString());
}

function personMatchesReportDate(person, date) {
  return date >= personJoinDate(person);
}

function ownTeamMember() {
  if (!usingSupabase || !currentUser) return null;
  return state.team.find((person) => person.userId === currentUser.id) || null;
}

function ownActiveTeamMember() {
  const own = ownTeamMember();
  return own?.active === false ? null : own;
}

function isRemovedFromWorkspace() {
  if (!usingSupabase || canManageWorkspace()) return false;
  const membership = currentMembership();
  return Boolean(currentWorkspace && membership && membership.active === false);
}

function visibleTeam() {
  if (!usingSupabase || canManageWorkspace()) return activeTeam();
  const own = ownTeamMember();
  return own ? [own] : [];
}

function actionTeam() {
  if (!usingSupabase || canManageWorkspace()) return activeTeam();
  const own = ownActiveTeamMember();
  return own ? [own] : [];
}

function canUsePerson(personId) {
  if (!personId) return false;
  if (!usingSupabase || canManageWorkspace()) return true;
  return actionTeam().some((person) => person.id === personId);
}

function currentMembership() {
  if (!currentWorkspace) return null;
  return workspaceMemberships.find((membership) => membership.workspace_id === currentWorkspace.id) || null;
}

function canManageWorkspace() {
  if (!usingSupabase) return true;
  const membership = currentMembership();
  return membership?.active !== false && ["owner", "admin"].includes(membership?.role);
}

function isWorkspaceOwner() {
  if (!usingSupabase) return true;
  const membership = currentMembership();
  return membership?.active !== false && membership?.role === "owner";
}

function isWorkspaceOwnerFor(workspaceId) {
  if (!usingSupabase) return true;
  const membership = workspaceMemberships.find((item) => item.workspace_id === workspaceId);
  return membership?.active !== false && membership?.role === "owner";
}

function membershipRoleLabel(role = currentMembership()?.role) {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

function profileInitial(value) {
  const source = value || currentProfile?.display_name || currentUser?.email || "A";
  return source.trim().slice(0, 1).toUpperCase();
}

function inviteRoleConfig(choice, customRole = "") {
  const trimmedCustom = customRole.trim();
  if (choice === "admin") return { permissionRole: "admin", roleLabel: "Admin" };
  if (choice === "video-editor") return { permissionRole: "editor", roleLabel: "Video Editor" };
  if (choice === "thumbnail-designer") return { permissionRole: "editor", roleLabel: "Thumbnail Designer" };
  if (choice === "custom") return { permissionRole: "editor", roleLabel: trimmedCustom || "Team Member" };
  return { permissionRole: "editor", roleLabel: "Team Member" };
}

function roleChoiceFromLabel(role = "") {
  if (role === "Admin") return "admin";
  if (role === "Video Editor") return "video-editor";
  if (role === "Thumbnail Designer") return "thumbnail-designer";
  if (!role || role === "Team Member") return "member";
  return "custom";
}

function roleSelectOptions(role = "") {
  const selected = roleChoiceFromLabel(role);
  return [
    ["member", "Member"],
    ["video-editor", "Video Editor"],
    ["thumbnail-designer", "Thumbnail Designer"],
    ["admin", "Admin"],
    ["custom", "Custom"]
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function inviteRoleLabel(invite) {
  return invite?.role_label || membershipRoleLabel(invite?.role === "editor" ? "member" : invite?.role);
}

function inviteTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("invite") || localStorage.getItem(INVITE_KEY);
}

function inviteTokenOnlyFromUrl() {
  return new URLSearchParams(window.location.search).get("invite");
}

function rememberInviteToken() {
  const token = inviteTokenOnlyFromUrl();
  if (token) localStorage.setItem(INVITE_KEY, token);
  return token || localStorage.getItem(INVITE_KEY);
}

function clearPendingInvite() {
  localStorage.removeItem(INVITE_KEY);
}

function cleanInviteFromAddressBar() {
  if (new URLSearchParams(window.location.search).has("invite")) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

async function resolveAuthUser(authData = {}) {
  if (authData.user) return authData.user;
  if (authData.session?.user) return authData.session.user;
  const userResult = await supabaseClient.auth.getUser();
  if (userResult.error) throw userResult.error;
  return userResult.data?.user || userResult.data || null;
}

async function acceptPendingInvite() {
  const inviteToken = inviteTokenOnlyFromUrl() || localStorage.getItem(INVITE_KEY);
  if (!inviteToken) return { accepted: false };

  const inviteResult = await supabaseClient.rpc("accept_workspace_invite", { invite_token: inviteToken });
  if (inviteResult.error) {
    const inviteMessage = inviteResult.error.message || "";
    const lowerMessage = inviteMessage.toLowerCase();
    if (lowerMessage.includes("invalid") || lowerMessage.includes("expired")) {
      cleanInviteFromAddressBar();
      clearPendingInvite();
      showToast("Invite link was already used or expired. Loading your workspaces.");
      return { accepted: false, ignored: true };
    }
    if (lowerMessage.includes("already used")) {
      cleanInviteFromAddressBar();
      clearPendingInvite();
      showToast("Invite was already used. Loading your workspace access.");
      return { accepted: false, ignored: true };
    }
    if (lowerMessage.includes("invited email")) {
      throw new Error("Login with the same email address that received this invite.");
    }
    throw inviteResult.error;
  }

  if (inviteResult.data) localStorage.setItem(WORKSPACE_KEY, inviteResult.data);
  cleanInviteFromAddressBar();
  clearPendingInvite();
  showToast("Invite accepted. Workspace opened.");
  return { accepted: true, workspaceId: inviteResult.data };
}

function actionLabel(action) {
  return {
    in: "In",
    break_start: "Break Start",
    break_end: "Break End",
    out: "Out"
  }[action] || action;
}

function attendanceEntriesForDate(personId, date = todayKey()) {
  const dateStart = new Date(`${date}T00:00:00`);
  const dateEnd = new Date(`${date}T23:59:59.999`);
  const allEntries = state.attendance
    .filter((entry) => entry.personId === personId)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const sameDayEntries = allEntries.filter((entry) => dateFromTimestamp(entry.time) === date);
  const previousEntries = allEntries.filter((entry) => new Date(entry.time) < dateStart);
  const lastBeforeDay = previousEntries.at(-1);
  const hasOpenCarryover = lastBeforeDay && lastBeforeDay.action !== "out";

  if (!hasOpenCarryover) return sameDayEntries;

  const shiftStartIndex = allEntries.findLastIndex((entry) =>
    new Date(entry.time) < dateStart && entry.action === "in"
  );
  const carryoverStart = shiftStartIndex >= 0 ? allEntries[shiftStartIndex] : lastBeforeDay;
  const shiftStartTime = new Date(carryoverStart.time);
  const closingOut = allEntries.find((entry) =>
    entry.action === "out" &&
    new Date(entry.time) > shiftStartTime
  );
  const shiftEndTime = closingOut ? new Date(closingOut.time) : new Date();

  if (shiftStartTime > dateEnd || shiftEndTime < dateStart) return sameDayEntries;

  return allEntries.filter((entry) => {
    const time = new Date(entry.time);
    return time >= shiftStartTime && time <= shiftEndTime;
  });
}

function statusFor(personId, date = todayKey()) {
  const entries = attendanceEntriesForDate(personId, date);
  const latest = entries.at(-1);
  if (!latest) return { label: "Not In", className: "out", entries };
  if (latest.action === "in" || latest.action === "break_end") return { label: "In Office", className: "in", entries };
  if (latest.action === "break_start") return { label: "On Break", className: "break", entries };
  return { label: "Out", className: "out", entries };
}

function workFor(personId, date = todayKey()) {
  return state.work.filter((entry) => entry.personId === personId && entry.date === date);
}

function attendanceSummary(personId, date = todayKey()) {
  const entries = statusFor(personId, date).entries;
  const firstIn = entries.find((entry) => entry.action === "in");
  const lastOut = entries.filter((entry) => entry.action === "out").at(-1);
  const breaks = [];
  let openBreak = null;

  entries.forEach((entry) => {
    if (entry.action === "break_start") openBreak = new Date(entry.time);
    if (entry.action === "break_end" && openBreak) {
      breaks.push({ start: openBreak, end: new Date(entry.time) });
      openBreak = null;
    }
  });

  const breakMinutes = breaks.reduce((sum, item) => sum + Math.max(0, item.end - item.start) / 60000, 0);
  let workingMinutes = 0;
  if (firstIn) {
    const end = lastOut ? new Date(lastOut.time) : new Date();
    workingMinutes = Math.max(0, end - new Date(firstIn.time)) / 60000 - breakMinutes;
  }

  return {
    firstIn,
    lastOut,
    breakMinutes,
    workingMinutes: Math.max(0, workingMinutes)
  };
}

function liveWorkingMinutes(personId, date = todayKey()) {
  const status = statusFor(personId, date);
  if (status.className === "out") return 0;

  const entries = status.entries;
  const lastInIndex = entries.findLastIndex((entry) => entry.action === "in" || entry.action === "break_end");
  if (lastInIndex < 0) return 0;

  const currentSegment = entries.slice(lastInIndex);
  const segmentStart = new Date(currentSegment[0].time);
  const segmentEnd = status.className === "break"
    ? new Date(currentSegment.find((entry) => entry.action === "break_start")?.time || new Date())
    : new Date();

  return Math.max(0, (segmentEnd - segmentStart) / 60000);
}

function hoursLabel(minutes) {
  if (!minutes) return "0h";
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (!hours) return `${mins}m`;
  if (!mins) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function sumWork(entries) {
  return entries.reduce(
    (acc, entry) => {
      acc.longVideos += Number(entry.longVideos || 0);
      acc.shorts += Number(entry.shorts || 0);
      acc.thumbnails += Number(entry.thumbnails || 0);
      acc.otherCount += Number(entry.otherCount || 0);
      return acc;
    },
    { longVideos: 0, shorts: 0, thumbnails: 0, otherCount: 0 }
  );
}

function setCurrentInputs() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  $("#attendanceTime").value = new Date(now - offsetMs).toISOString().slice(0, 16);
  $("#workDate").value = todayKey();
  $("#reportDate").value = todayKey();
  if ($("#reportStartDate")) $("#reportStartDate").value = todayKey();
  if ($("#reportEndDate")) $("#reportEndDate").value = todayKey();
  if ($("#reportStartDate")) $("#reportStartDate").disabled = true;
  if ($("#reportEndDate")) $("#reportEndDate").disabled = true;
  $("#adminDate").value = todayKey();
  $("#bulkStartDate").value = todayKey();
  $("#bulkEndDate").value = todayKey();
  updateDateHints();
}

function updateDateHints() {
  const attendanceValue = $("#attendanceTime").value;
  const workDate = $("#workDate").value || todayKey();
  const reportRange = reportRangeFromPreset();
  if (attendanceValue) {
    const attendanceDate = localDateKey(new Date(attendanceValue));
    $("#attendanceSelectedDay").textContent = `${formatDay(attendanceDate)}, ${formatDateOnly(attendanceDate)}`;
  } else {
    $("#attendanceSelectedDay").textContent = "-";
  }
  $("#workSelectedDay").textContent = `${formatDay(workDate)}, ${formatDateOnly(workDate)}`;
  $("#reportDayLabel").textContent = `${reportRange.label}: ${formatDateOnly(reportRange.start)} to ${formatDateOnly(reportRange.end)}`;
}

function isAdmin() {
  return canManageWorkspace();
}

function workspaceInitial(name = "") {
  const clean = name.trim() || currentProfile?.display_name || currentUser?.email || "A";
  return clean.charAt(0).toUpperCase();
}

function workspacePlanLabel() {
  if (!currentUser) return "Login required";
  const role = currentMembership()?.role || "member";
  return `${role} · Free Workspace`;
}

function toggleWorkspaceMenu(force) {
  const menu = $("#workspaceMenu");
  const button = $("#workspaceMenuBtn");
  if (!menu || !button) return;
  const open = typeof force === "boolean" ? force : menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function showWorkspaceCreate() {
  workspaceCreateOpen = true;
  const setup = $("#workspaceSetup");
  if (setup) {
    setup.style.display = "block";
    setup.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const input = $("#workspaceName");
  if (input) {
    const defaultName = currentProfile?.display_name ? `${currentProfile.display_name}'s Workspace` : "";
    if (!input.value && defaultName) input.value = defaultName;
    input.focus();
  }
}

function renderWorkspaceMenu() {
  if (!$("#workspaceMenuBtn")) return;
  const name = currentWorkspace?.name || (currentUser ? "Create Workspace" : "No workspace");
  const initial = workspaceInitial(name);
  const meta = currentWorkspace ? workspacePlanLabel() : currentUser ? "Set up your team" : "Login required";

  $("#workspaceTriggerName").textContent = name;
  $("#workspaceTriggerRole").textContent = meta;
  $("#workspaceMenuName").textContent = name;
  $("#workspaceMenuMeta").textContent = meta;
  $("#workspaceAvatar").textContent = initial;
  $("#workspaceMenuAvatar").textContent = initial;

  const list = $("#workspaceMenuList");
  list.innerHTML = availableWorkspaces.length
    ? availableWorkspaces.map((workspace) => `
        <div class="workspace-option-row ${workspace.id === currentWorkspace?.id ? "is-active" : ""}">
          <button class="workspace-option" type="button" data-workspace-id="${workspace.id}">
            <span class="workspace-avatar">${workspaceInitial(workspace.name)}</span>
            <span>${escapeHtml(workspace.name)}</span>
          </button>
          ${isWorkspaceOwnerFor(workspace.id) ? `
            <span class="workspace-more-wrap">
              <button class="workspace-more-button" type="button" data-workspace-menu="${workspace.id}" aria-label="Manage ${escapeHtml(workspace.name)}">...</button>
              <span class="workspace-row-menu" id="workspaceRowMenu-${workspace.id}" hidden>
                <button type="button" data-workspace-rename="${workspace.id}">Update Name</button>
                <button type="button" data-workspace-delete="${workspace.id}">Delete Workspace</button>
              </span>
            </span>
          ` : ""}
        </div>
      `).join("")
    : `<div class="empty">No workspaces yet.</div>`;
}

function closeWorkspaceRowMenus(exceptId = "") {
  $$(".workspace-row-menu").forEach((menu) => {
    menu.hidden = menu.id === `workspaceRowMenu-${exceptId}` ? menu.hidden : true;
  });
}

function toggleWorkspaceRowMenu(workspaceId) {
  const menu = $(`#workspaceRowMenu-${workspaceId}`);
  if (!menu) return;
  const nextHidden = !menu.hidden;
  closeWorkspaceRowMenus(workspaceId);
  menu.hidden = nextHidden;
}

function toggleProfileMenu(force) {
  const menu = $("#profileMenu");
  const button = $("#profileMenuBtn");
  if (!menu || !button) return;
  const open = typeof force === "boolean" ? force : menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function renderProfileMenu() {
  const wrap = $("#profileMenuWrap");
  if (!wrap) return;
  const authenticated = usingSupabase && currentUser;
  wrap.style.display = authenticated ? "block" : "none";
  if (!authenticated) return;

  const displayName = currentProfile?.display_name || currentUser.email || "Account";
  const email = currentUser.email || "";
  const role = membershipRoleLabel();
  const workspaceName = currentWorkspace?.name || "No workspace";
  const initial = profileInitial(displayName);

  $("#profileAvatar").textContent = initial;
  $("#profileMenuAvatar").textContent = initial;
  $("#profileMenuName").textContent = displayName;
  $("#profileMenuEmail").textContent = email;
  $("#profileMenuStatus").textContent = `${role} | ${workspaceName}`;
}

function updateSessionUI() {
  const pill = $("#sessionPill");
  if (!usingSupabase) {
    pill.textContent = "Local mode";
    $("#profileMenuWrap").style.display = "none";
    renderWorkspaceMenu();
    renderProfileMenu();
    return;
  }
  if (!currentUser) {
    pill.textContent = "Login required";
    $("#profileMenuWrap").style.display = "none";
    renderWorkspaceMenu();
    renderProfileMenu();
    return;
  }
  const role = membershipRoleLabel(currentMembership()?.role || currentProfile?.role || "member");
  pill.textContent = `${role} | ${currentProfile?.display_name || currentUser.email}`;
  renderWorkspaceMenu();
  renderProfileMenu();
  updateSyncStatus();
}

function updateSyncStatus() {
  const syncLabel = $("#syncStatus");
  if (!syncLabel) return;
  if (!usingSupabase) {
    syncLabel.textContent = "Local data";
    return;
  }
  if (!currentUser) {
    syncLabel.textContent = "Not synced";
    return;
  }
  syncLabel.textContent = lastSyncedAt ? `Synced ${formatTime(lastSyncedAt)}` : "Sync pending";
}

function viewButton(viewName) {
  return document.querySelector(`[data-view="${viewName}"]`);
}

function isViewAvailable(viewName) {
  const button = viewButton(viewName);
  const view = $(`#${viewName}View`);
  return Boolean(button && view && !button.hidden);
}

function setActiveView(viewName, { persist = true } = {}) {
  const safeViewName = isViewAvailable(viewName) ? viewName : "dashboard";
  $$(".nav-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === safeViewName);
  });
  $$(".view").forEach((view) => view.classList.remove("is-active"));
  const view = $(`#${safeViewName}View`);
  if (view) {
    view.classList.add("is-active");
    $("#viewTitle").textContent = view.dataset.title;
  }
  if (persist) localStorage.setItem(VIEW_KEY, safeViewName);
  return safeViewName;
}

function activeViewName() {
  const active = $(".view.is-active");
  return active?.id?.replace(/View$/, "") || localStorage.getItem(VIEW_KEY) || "dashboard";
}

function applyAccessControls() {
  const admin = canManageWorkspace();
  const removed = isRemovedFromWorkspace();
  const attendanceTab = document.querySelector('[data-view="attendance"]');
  const workTab = document.querySelector('[data-view="work"]');
  const teamTab = document.querySelector('[data-view="team"]');
  const assignmentsTab = document.querySelector('[data-view="assignments"]');
  const chatTab = document.querySelector('[data-view="chat"]');
  const adminTab = document.querySelector('[data-view="admin"]');
  if (attendanceTab) attendanceTab.hidden = admin || !currentWorkspace;
  if (workTab) workTab.hidden = admin || !currentWorkspace;
  if (teamTab) teamTab.hidden = !admin || !currentWorkspace;
  if (assignmentsTab) assignmentsTab.hidden = !currentWorkspace;
  if (chatTab) chatTab.hidden = !currentWorkspace;
  if (adminTab) adminTab.hidden = !admin || !currentWorkspace;
  const manualPanel = document.querySelector(".manual-member-panel");
  if (manualPanel) manualPanel.style.display = "none";
  $("#teamForm").style.display = "none";
  $("#inviteForm").style.display = admin ? "grid" : "none";
  const assignmentAdminPanel = document.querySelector(".assignment-admin-panel");
  if (assignmentAdminPanel) assignmentAdminPanel.style.display = admin ? "" : "none";
  $$(".admin-chat-tools").forEach((item) => {
    item.style.display = admin ? "" : "none";
  });
  $$(".admin-metric").forEach((item) => {
    item.style.display = admin ? "" : "none";
  });
  $$(".editor-only-action").forEach((item) => {
    item.style.display = admin ? "none" : "";
  });
  $("#workspaceSetup").style.display = usingSupabase && currentUser && (!currentWorkspace || workspaceCreateOpen) ? "block" : "none";
  $("#clearDataBtn").style.display = admin && !usingSupabase ? "inline-grid" : "none";
  $("#importJsonInput").closest(".file-button").style.display = admin && !usingSupabase ? "inline-grid" : "none";
  if ($("#exportJsonBtn")) $("#exportJsonBtn").style.display = "none";
  $("#attendanceForm").classList.toggle("is-disabled", removed);
  $("#workForm").classList.toggle("is-disabled", removed);
  $("#assignmentForm")?.classList.toggle("is-disabled", removed);
  $$("#attendanceForm input, #attendanceForm select, #attendanceForm button, #workForm input, #workForm select, #workForm textarea, #workForm button").forEach((field) => {
    field.disabled = removed || (!canManageWorkspace() && actionTeam().length === 0);
  });
  const removedNotice = $("#removedNotice");
  if (removedNotice) {
    removedNotice.hidden = !removed;
    removedNotice.textContent = removed ? "You have been removed from this workspace by an admin or owner. Your history is still available, but attendance and work updates are disabled until you are added again." : "";
  }
  const savedView = localStorage.getItem(VIEW_KEY) || activeViewName();
  const requestedView = document.body.classList.contains("is-booting") ? savedView : activeViewName();
  setActiveView(isViewAvailable(requestedView) ? requestedView : savedView, { persist: false });
  document.body.classList.remove("is-booting");
}

function showAuthGate(message = "") {
  document.body.classList.remove("is-booting");
  $("#authGate").classList.add("is-active");
  if (message) {
    openAuthPage(authMode, message);
  } else {
    $("#authGate").classList.remove("is-auth-page");
    updateAuthMode(authMode);
  }
  updateSessionUI();
}

function hideAuthGate() {
  document.body.classList.remove("is-booting");
  $("#authGate").classList.remove("is-active");
  $("#authGate").classList.remove("is-auth-page");
}

function updateAuthMode(mode, message = "") {
  authMode = mode === "reset" ? "reset" : mode === "login" ? "login" : "signup";
  const isReset = authMode === "reset";
  const isSignup = authMode === "signup";
  $$("[data-auth-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.authMode === authMode && button.closest(".auth-tabs"));
  });
  $("#authNameWrap").style.display = isSignup ? "block" : "none";
  $("#signupName").required = isSignup;
  $("#loginEmail").required = !isReset;
  $("#loginEmail").closest("label").style.display = isReset ? "none" : "block";
  $("#resendConfirmBtn").style.display = isReset ? "none" : "block";
  $("#forgotPasswordBtn").style.display = isReset ? "none" : "block";
  $("#loginPassword").autocomplete = isSignup || isReset ? "new-password" : "current-password";
  $("#loginPassword").placeholder = isReset ? "New password" : "";
  $("#authModeTitle").textContent = isReset ? "Set new password" : isSignup ? "Create your account" : "Welcome back";
  $("#authModeCopy").textContent = isReset
    ? "Create a new password for this account. After saving, you can use normal login again."
    : isSignup
    ? "Start with your email. After login, create a workspace or accept an invite."
    : "Login to open your workspace, manage your team, and review daily reports.";
  $("#authPageHeadline").textContent = isReset ? "Reset your workspace password." : isSignup ? "Create your team account." : "Welcome back to your workspace.";
  $("#authSubmitBtn").textContent = isReset ? "Save New Password" : isSignup ? "Create Account" : "Login";
  $("#authSwitchText").innerHTML = isReset
    ? `Password changed? <button type="button" data-auth-mode="login">Login</button>`
    : isSignup
    ? `Already have an account? <button type="button" data-auth-mode="login">Login</button>`
    : `New to Avantex Flow? <button type="button" data-auth-mode="signup">Create account</button>`;
  $("#authMessage").textContent = message || (isReset ? "Enter a new password with at least 6 characters." : isSignup ? "Use the same email address if you received an invite." : "Login with your workspace account.");
}

function openAuthPage(mode = "signup", message = "") {
  $("#authGate").classList.add("is-auth-page");
  updateAuthMode(mode, message);
  requestAnimationFrame(() => {
    const field = authMode === "signup" ? $("#signupName") : $("#loginEmail");
    field?.focus();
  });
}

function closeAuthPage() {
  $("#authGate").classList.remove("is-auth-page");
  updateAuthMode("signup");
}

function configureSupabase() {
  supabaseClient = createRestSupabaseClient(SUPABASE_URL, SUPABASE_KEY);
  usingSupabase = true;
  return true;
}

async function consumeAuthRedirectSession() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const queryParams = new URLSearchParams(window.location.search);
  const accessToken = hashParams.get("access_token") || queryParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token") || queryParams.get("refresh_token");
  const linkType = hashParams.get("type") || queryParams.get("type");
  if (!accessToken || !refreshToken) return null;

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: hashParams.get("token_type") || queryParams.get("token_type") || "bearer",
    expires_in: Number(hashParams.get("expires_in") || queryParams.get("expires_in") || 3600),
    expires_at: Math.floor(Date.now() / 1000) + Number(hashParams.get("expires_in") || queryParams.get("expires_in") || 3600)
  };
  await supabaseClient.auth.setSession(session);
  const userResult = await supabaseClient.auth.getUser();
  if (userResult.error) throw userResult.error;
  passwordRecoveryMode = linkType === "recovery";
  const pendingInvite = inviteTokenFromUrl();
  window.history.replaceState({}, document.title, window.location.pathname + (pendingInvite ? `?invite=${pendingInvite}` : ""));
  return userResult.data?.user || userResult.data;
}

function showPasswordResetGate(message = "Set a new password to finish account recovery.") {
  $("#authGate").classList.add("is-active", "is-auth-page");
  updateAuthMode("reset", message);
  updateSessionUI();
  requestAnimationFrame(() => $("#loginPassword")?.focus());
}

async function loadRemoteState(options = {}) {
  const profileResult = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (profileResult.error) throw profileResult.error;
  currentProfile = profileResult.data || {
    user_id: currentUser.id,
    email: currentUser.email,
    display_name: currentUser.email,
    role: "editor"
  };

  await acceptPendingInvite();

  const membershipResult = await supabaseClient
    .from("memberships")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true });
  if (membershipResult.error) throw membershipResult.error;
  workspaceMemberships = membershipResult.data || [];

  if (!workspaceMemberships.length) {
    currentWorkspace = null;
    availableWorkspaces = [];
    workspaceInvites = [];
    state = { team: [], attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
    return;
  }

  const workspaceIds = workspaceMemberships.map((membership) => membership.workspace_id);
  const workspaceResult = await supabaseClient
    .from("workspaces")
    .select("*")
    .in("id", workspaceIds)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (workspaceResult.error) throw workspaceResult.error;
  availableWorkspaces = workspaceResult.data || [];

  const savedWorkspaceId = localStorage.getItem(WORKSPACE_KEY);
  currentWorkspace =
    availableWorkspaces.find((workspace) => workspace.id === savedWorkspaceId) ||
    availableWorkspaces[0] ||
    null;
  if (currentWorkspace) localStorage.setItem(WORKSPACE_KEY, currentWorkspace.id);

  if (!currentWorkspace) {
    workspaceInvites = [];
    state = { team: [], attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
    return;
  }

  const [editorsResult, attendanceResult, workResult, workspaceMembersResult, assignmentsResult, chatThreadsResult, chatMessagesResult] = await Promise.all([
    supabaseClient.from("editors").select("*").eq("workspace_id", currentWorkspace.id).order("created_at", { ascending: true }),
    supabaseClient.from("attendance_logs").select("*").eq("workspace_id", currentWorkspace.id).order("happened_at", { ascending: false }),
    supabaseClient.from("daily_work").select("*").eq("workspace_id", currentWorkspace.id).order("work_date", { ascending: false }),
    supabaseClient.from("memberships").select("*").eq("workspace_id", currentWorkspace.id),
    supabaseClient.from("work_assignments").select("*").eq("workspace_id", currentWorkspace.id).order("created_at", { ascending: false }),
    supabaseClient.from("chat_threads").select("*").eq("workspace_id", currentWorkspace.id).order("updated_at", { ascending: false }),
    supabaseClient.from("chat_messages").select("*").eq("workspace_id", currentWorkspace.id).order("created_at", { ascending: true })
  ]);

  if (editorsResult.error) throw editorsResult.error;
  if (attendanceResult.error) throw attendanceResult.error;
  if (workResult.error) throw workResult.error;
  if (workspaceMembersResult.error) throw workspaceMembersResult.error;
  const assignmentsReady = !assignmentsResult.error;
  if (assignmentsResult.error && !(assignmentsResult.error.message || "").toLowerCase().includes("work_assignments")) {
    throw assignmentsResult.error;
  }
  const chatReady = !chatThreadsResult.error && !chatMessagesResult.error;
  const chatErrorText = `${chatThreadsResult.error?.message || ""} ${chatMessagesResult.error?.message || ""}`.toLowerCase();
  if (!chatReady && chatErrorText && !chatErrorText.includes("chat_threads") && !chatErrorText.includes("chat_messages")) {
    throw chatThreadsResult.error || chatMessagesResult.error;
  }

  if (canManageWorkspace()) {
    const invitesResult = await supabaseClient
      .from("workspace_invites")
      .select("*")
      .eq("workspace_id", currentWorkspace.id)
      .order("created_at", { ascending: false });
    if (invitesResult.error) throw invitesResult.error;
    workspaceInvites = invitesResult.data || [];
  } else {
    workspaceInvites = [];
  }

  const memberByUserId = new Map((workspaceMembersResult.data || []).map((membership) => [membership.user_id, membership]));
  const emailByUserId = new Map((workspaceInvites || [])
    .filter((invite) => invite.accepted_by && invite.email)
    .map((invite) => [invite.accepted_by, invite.email]));

  state = {
    team: (editorsResult.data || []).map((editor) => ({
      id: editor.id,
      workspaceId: editor.workspace_id,
      userId: editor.user_id,
      email: emailByUserId.get(editor.user_id) || "",
      name: editor.name,
      role: editor.role || "Team Member",
      shift: editor.shift || "",
      active: editor.active !== false && (!editor.user_id || memberByUserId.get(editor.user_id)?.active !== false),
      createdAt: editor.created_at,
      joinedAt: editor.created_at,
      removedAt: editor.removed_at
    })),
    attendance: (attendanceResult.data || []).map((entry) => ({
      id: entry.id,
      workspaceId: entry.workspace_id,
      personId: entry.editor_id,
      action: entry.action,
      time: entry.happened_at,
      note: entry.note || ""
    })),
    work: (workResult.data || []).map((entry) => ({
      id: entry.id,
      workspaceId: entry.workspace_id,
      personId: entry.editor_id,
      date: entry.work_date,
      longVideos: entry.long_videos,
      shorts: entry.shorts,
      thumbnails: entry.thumbnails,
      otherCount: entry.other_count,
      details: entry.details || "",
      status: entry.status,
      createdAt: entry.created_at
    })),
    assignments: (assignmentsReady ? assignmentsResult.data || [] : []).map((entry) => ({
      id: entry.id,
      workspaceId: entry.workspace_id,
      personId: entry.assigned_to,
      assignedBy: entry.assigned_by,
      title: entry.title,
      workType: entry.work_type,
      url: entry.work_url || "",
      notes: entry.notes || "",
      priority: entry.priority || "normal",
      status: entry.status || "assigned",
      dueDate: entry.due_date || "",
      createdAt: entry.created_at,
      updatedAt: entry.updated_at
    })),
    chatThreads: (chatReady ? chatThreadsResult.data || [] : []).map((thread) => ({
      id: thread.id,
      workspaceId: thread.workspace_id,
      type: thread.thread_type || "group",
      title: thread.title || "",
      createdBy: thread.created_by,
      memberIds: Array.isArray(thread.member_editor_ids) ? thread.member_editor_ids : [],
      createdAt: thread.created_at,
      updatedAt: thread.updated_at
    })),
    chatMessages: (chatReady ? chatMessagesResult.data || [] : []).map((message) => ({
      id: message.id,
      workspaceId: message.workspace_id,
      threadId: message.thread_id,
      senderId: message.sender_id,
      senderEditorId: message.sender_editor_id,
      body: message.body || "",
      createdAt: message.created_at
    }))
  };

  if (!options.skipRepair && canManageWorkspace()) {
    const repaired = await repairAcceptedInviteEditors();
  if (repaired) {
    await loadRemoteState({ skipRepair: true });
  }
  }
}

function normalizedName(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}

async function repairAcceptedInviteEditors() {
  if (!usingSupabase || !currentWorkspace || !canManageWorkspace()) return false;
  const acceptedEditorInvites = workspaceInvites.filter((invite) => invite.accepted_at && invite.accepted_by && invite.role !== "admin");
  let repaired = false;

  for (const invite of acceptedEditorInvites) {
    const existingLinked = state.team.find((person) => person.userId === invite.accepted_by);
    if (existingLinked?.active !== false) continue;

    const fallbackName = invite.email?.split("@")[0] || "Team Member";
    const roleLabel = invite.role_label || "Team Member";
    const manualMatch = state.team.find((person) => !person.userId && normalizedName(person.name) === normalizedName(fallbackName));
    if (manualMatch) {
      const { error } = await supabaseClient
        .from("editors")
        .update({ user_id: invite.accepted_by, role: roleLabel, active: true })
        .eq("id", manualMatch.id);
      if (error) {
        console.warn("Editor link repair failed", error);
        continue;
      }
      repaired = true;
      continue;
    }

    if (existingLinked?.active === false) {
      const { error } = await supabaseClient
        .from("editors")
        .update({ role: roleLabel, active: true })
        .eq("id", existingLinked.id);
      if (error) {
        console.warn("Editor activation repair failed", error);
        continue;
      }
      repaired = true;
      continue;
    }

    const { error } = await supabaseClient.from("editors").insert({
      workspace_id: currentWorkspace.id,
      user_id: invite.accepted_by,
      name: fallbackName,
      role: roleLabel,
      active: true
    });
    if (error) {
      console.warn("Editor creation repair failed", error);
      continue;
    }
    repaired = true;
  }

  return repaired;
}

async function refreshRemote(message, options = {}) {
  await loadRemoteState();
  lastSyncedAt = new Date().toISOString();
  render();
  updateSyncStatus();
  if (message && !options.silent) showToast(message);
}

async function syncRemoteSilently() {
  if (!usingSupabase || !currentUser || !currentWorkspace || passwordRecoveryMode || autoRefreshRunning) return;
  if (document.visibilityState && document.visibilityState !== "visible") return;
  autoRefreshRunning = true;
  try {
    await refreshRemote("", { silent: true });
  } catch (error) {
    console.warn("Auto sync failed", error);
  } finally {
    autoRefreshRunning = false;
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = window.setInterval(syncRemoteSilently, 20000);
}

function stopAutoRefresh() {
  if (!autoRefreshTimer) return;
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

async function signOut() {
  if (!usingSupabase) return;
  await supabaseClient.auth.signOut();
  currentUser = null;
  currentProfile = null;
  currentWorkspace = null;
  workspaceMemberships = [];
  availableWorkspaces = [];
  workspaceInvites = [];
  state = { team: [], attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
  lastSyncedAt = null;
  stopAutoRefresh();
  toggleProfileMenu(false);
  render();
  showAuthGate("Signed out.");
}

async function bootApp() {
  applyTheme();
  rememberInviteToken();
  setCurrentInputs();
  setupEvents();
  if (!configureSupabase()) {
    hideAuthGate();
    applyAccessControls();
    updateSessionUI();
    render();
    return;
  }

  const redirectUser = await consumeAuthRedirectSession();
  if (redirectUser) {
    currentUser = redirectUser;
    if (passwordRecoveryMode) {
      showPasswordResetGate();
      return;
    }
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    showAuthGate(authErrorMessage(error));
    return;
  }
  if (!data.session) {
    showAuthGate(inviteTokenFromUrl() ? "Login with the invited email to join this workspace." : "");
    if (inviteTokenFromUrl()) openAuthPage("login", "Login with the same email address that received this invite.");
    return;
  }
  currentUser = currentUser || data.session.user;
  try {
    await loadRemoteState();
    lastSyncedAt = new Date().toISOString();
    hideAuthGate();
    applyAccessControls();
    updateSessionUI();
    render();
    startAutoRefresh();
  } catch (err) {
    showAuthGate(`Supabase setup needed: ${authErrorMessage(err)}`);
  }
}

function populateSelects() {
  if ($("#workspaceSelect")) {
    $("#workspaceSelect").innerHTML = availableWorkspaces.length
      ? availableWorkspaces.map((workspace) => `<option value="${workspace.id}">${escapeHtml(workspace.name)}</option>`).join("")
      : `<option value="">No workspace</option>`;
    $("#workspaceSelect").value = currentWorkspace?.id || "";
    $("#workspaceSelect").disabled = availableWorkspaces.length <= 1;
  }

  const people = actionTeam();
  const allPeople = reportTeam();
  const selectedAttendance = $("#attendancePerson").value;
  const selectedWork = $("#workPerson").value;
  const selectedReport = $("#reportPerson").value;
  const selectedAdmin = $("#adminPerson").value;
  const selectedBulk = $("#bulkEditor").value;
  const selectedAssignment = $("#assignmentPerson")?.value;
  const personOptions = people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)} | ${escapeHtml(person.role)}</option>`).join("");
  const allPersonOptions = allPeople.map((person) => `<option value="${person.id}">${escapeHtml(person.name)} | ${escapeHtml(person.role)}</option>`).join("");
  $("#attendancePerson").innerHTML = personOptions;
  $("#workPerson").innerHTML = personOptions;
  $("#attendancePerson").disabled = !people.length;
  $("#workPerson").disabled = !people.length;
  $("#reportPerson").innerHTML = canManageWorkspace() ? `<option value="all">All team members</option>${allPersonOptions}` : allPersonOptions;
  $("#adminPerson").innerHTML = `<option value="all">All team members</option>${allPersonOptions}`;
  $("#bulkEditor").innerHTML = `<option value="all">All team members</option>${allPersonOptions}`;
  if ($("#assignmentPerson")) $("#assignmentPerson").innerHTML = activeTeam().map((person) => `<option value="${person.id}">${escapeHtml(person.name)} | ${escapeHtml(person.role)}</option>`).join("");
  $("#attendancePerson").value = selectedAttendance || $("#attendancePerson").value;
  $("#workPerson").value = selectedWork || $("#workPerson").value;
  $("#reportPerson").value = selectedReport || (canManageWorkspace() ? "all" : $("#reportPerson").value);
  $("#adminPerson").value = selectedAdmin || "all";
  $("#bulkEditor").value = selectedBulk || "all";
  if ($("#assignmentPerson")) $("#assignmentPerson").value = selectedAssignment || $("#assignmentPerson").value;
}

function render() {
  populateSelects();
  applyAccessControls();
  updateSessionUI();
  renderWorkspacePanel();
  renderDashboard();
  renderAttendanceLog();
  renderWorkLog();
  renderTeam();
  renderAssignments();
  renderChat();
  renderReports();
  renderAdminControls();
}

function renderWorkspacePanel() {
  if (!$("#workspaceNameLabel")) return;
  $("#workspaceNameLabel").textContent = currentWorkspace?.name || "No workspace selected";
  $("#workspaceRoleLabel").textContent = currentMembership()?.role || "none";
  const settingsPanel = $("#workspaceSettingsPanel");
  if (settingsPanel) {
    settingsPanel.hidden = true;
    const settingsName = $("#workspaceSettingsName");
    if (settingsName && document.activeElement !== settingsName) settingsName.value = currentWorkspace?.name || "";
  }
  const pendingInvites = workspaceInvites.filter((invite) => {
    const isExpired = invite.expires_at && new Date(invite.expires_at) <= new Date();
    return !invite.accepted_at && !isExpired && !cancelledInviteIds.has(invite.id);
  });
  $("#inviteList").innerHTML = pendingInvites.length
    ? pendingInvites.map((invite) => {
        const accepted = invite.accepted_at ? "Accepted" : invite.expires_at && new Date(invite.expires_at) < new Date() ? "Expired" : "Pending";
        const roleText = inviteRoleLabel(invite);
        return `
          <article class="invite-row">
            <div class="invite-main">
              <strong>${escapeHtml(invite.email)}</strong>
              <div class="meta-line">
                <span>${escapeHtml(roleText)}</span>
                <span>${accepted}</span>
              </div>
            </div>
            <div class="admin-item-actions invite-actions">
              <button class="ghost-button" type="button" data-copy-invite="${invite.token}">Copy Link</button>
              <button class="ghost-button" type="button" data-email-invite="${invite.token}" data-invite-email="${escapeHtml(invite.email)}" data-invite-role-label="${escapeHtml(roleText)}">Resend Email</button>
              <button class="ghost-button danger-text" type="button" data-cancel-invite="${invite.id}">Cancel</button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState("No pending invites yet.");
}

function renderDashboard() {
  const date = todayKey();
  const people = visibleTeam();
  const statuses = people.map((person) => ({ person, status: statusFor(person.id, date) }));
  const present = statuses.filter((item) => item.status.className === "in" || item.status.className === "break").length;
  const offline = statuses.filter((item) => item.status.className === "out").length;
  const onBreak = statuses.filter((item) => item.status.className === "break").length;
  const visibleIds = new Set(people.map((person) => person.id));
  const todayWork = state.work.filter((entry) => entry.date === date && visibleIds.has(entry.personId));
  const totals = sumWork(todayWork);
  const totalMinutes = people.reduce((sum, person) => sum + liveWorkingMinutes(person.id, date), 0);
  const totalMembers = canManageWorkspace() ? activeTeam().length : people.length;

  $("#metricDay").textContent = formatDay(date);
  $("#metricDate").textContent = formatDateOnly(date);
  $("#metricPresent").textContent = present;
  $("#metricOffline").textContent = offline;
  $("#metricTotalMembers").textContent = totalMembers;
  $("#metricBreak").textContent = onBreak;
  $("#metricVideos").textContent = totals.longVideos + totals.shorts;
  $("#metricHours").textContent = hoursLabel(totalMinutes);
  $("#sideToday").textContent = canManageWorkspace() ? `${totalMembers} members` : "My daily record";
  $("#sideDate").textContent = formatDate(date);

  $("#dashboardStatus").innerHTML = people.length
    ? people.map((person) => personStatusRow(person, date)).join("")
    : emptyState(isRemovedFromWorkspace() ? "You were removed from this workspace. Your old records remain available in Reports." : "No team members yet.");

  $("#dashboardWork").innerHTML = todayWork.length
    ? todayWork.slice().reverse().map(workCard).join("")
    : emptyState("No work updates for today.");

  const assignmentPeopleIds = new Set(people.map((person) => person.id));
  const dashboardAssignments = state.assignments
    .filter((assignment) => assignmentPeopleIds.has(assignment.personId))
    .filter((assignment) => !["approved"].includes(assignment.status))
    .slice(0, 5);
  if ($("#dashboardAssignmentsTitle")) $("#dashboardAssignmentsTitle").textContent = canManageWorkspace() ? "Open Assignments" : "My Assigned Work";
  if ($("#dashboardAssignments")) {
    $("#dashboardAssignments").innerHTML = dashboardAssignments.length
      ? dashboardAssignments.map((assignment) => {
          const person = getPerson(assignment.personId);
          return `
            <article class="mini-assignment">
              <strong>${escapeHtml(assignment.title)}</strong>
              <div class="meta-line">
                <span>${escapeHtml(person?.name || "Me")}</span>
                <span>${assignmentStatusText(assignment.status)}</span>
                ${assignment.dueDate ? `<span>${formatDateOnly(assignment.dueDate)}</span>` : ""}
              </div>
            </article>
          `;
        }).join("")
      : emptyState(canManageWorkspace() ? "No open assignments." : "No assigned work yet.");
  }
}

function personStatusRow(person, date = todayKey()) {
  const status = statusFor(person.id, date);
  const summary = attendanceSummary(person.id, date);
  const work = sumWork(workFor(person.id, date));
  const quickActions = canManageWorkspace()
    ? `<span class="badge ${status.className}">${status.label}</span>`
    : person.active === false
    ? `<span class="badge out">Removed</span>`
    : `
        <span class="badge ${status.className}">${status.label}</span>
        <button type="button" data-quick="${person.id}:in" title="Mark in">In</button>
        <button type="button" data-quick="${person.id}:break_start" title="Start break">Break</button>
        <button type="button" data-quick="${person.id}:break_end" title="End break">Back</button>
        <button type="button" data-quick="${person.id}:out" title="Mark out">Out</button>
      `;
  return `
    <article class="person-row">
      <div class="person-main">
        <strong>${escapeHtml(person.name)}</strong>
        <div class="meta-line">
          <span>${escapeHtml(person.role)}</span>
          <span>${summary.firstIn ? `In ${formatTime(summary.firstIn.time)}` : "No in time"}</span>
          <span>${hoursLabel(liveWorkingMinutes(person.id, date))}</span>
          <span>${work.longVideos + work.shorts} tasks</span>
        </div>
      </div>
      <div class="quick-actions">
        ${quickActions}
      </div>
    </article>
  `;
}

function renderAttendanceLog() {
  const date = todayKey();
  const visibleIds = new Set(visibleTeam().map((person) => person.id));
  $("#attendanceDayLabel").textContent = formatDate(date);
  const entries = state.attendance
    .filter((entry) => dateFromTimestamp(entry.time) === date)
    .filter((entry) => visibleIds.has(entry.personId))
    .sort((a, b) => new Date(b.time) - new Date(a.time));

  $("#attendanceLog").innerHTML = entries.length
    ? entries.map((entry) => {
        const person = getPerson(entry.personId);
        const entryDate = formatDateTimeWithDay(entry.time);
        return `
          <article class="timeline-item">
            <div class="timeline-time">${entryDate.day}<small>${entryDate.date} | ${entryDate.time}</small></div>
            <div>
              <strong>${escapeHtml(person?.name || "Unknown")}</strong>
              <div class="meta-line">
                <span class="badge ${entry.action.includes("break") ? "break" : entry.action}">${actionLabel(entry.action)}</span>
                ${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ""}
              </div>
            </div>
          </article>
        `;
      }).join("")
    : emptyState("No attendance marked today.");
}

function renderWorkLog() {
  const date = todayKey();
  const visibleIds = new Set(visibleTeam().map((person) => person.id));
  $("#workDayLabel").textContent = formatDate(date);
  const entries = state.work
    .filter((entry) => entry.date === date)
    .filter((entry) => visibleIds.has(entry.personId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $("#workLog").innerHTML = entries.length
    ? entries.map(workCard).join("")
    : emptyState("No production updates saved today.");
}

function workCard(entry) {
  const person = getPerson(entry.personId);
  const taskCount = Number(entry.longVideos || 0) + Number(entry.shorts || 0);
  return `
    <article class="work-card">
      <strong>${escapeHtml(person?.name || "Unknown")} | ${taskCount} work items</strong>
      <div class="work-meta">
        <span>${formatDate(entry.date)}</span>
        <span>${entry.longVideos || 0} tasks</span>
        <span>${entry.shorts || 0} follow-ups</span>
        <span>${entry.thumbnails || 0} reviews</span>
        <span>${entry.otherCount || 0} other</span>
        <span class="badge ${entry.status}">${statusText(entry.status)}</span>
      </div>
      ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ""}
    </article>
  `;
}

function renderTeam() {
  const roster = activeTeam();
  $("#teamList").innerHTML = roster.length
    ? roster.map((person) => `
      <article class="team-card">
        <div>
          <strong>${escapeHtml(person.name)}</strong>
          <div class="meta-line">
            <span>${escapeHtml(person.role)}</span>
            <span>${escapeHtml(person.shift || "No shift added")}</span>
            <span>Active</span>
          </div>
        </div>
        <div class="team-actions">
          <button class="ghost-button" type="button" data-edit-person="${person.id}">Edit</button>
          ${person.userId ? `
            <label class="team-role-control">
              <span>Role</span>
              <select data-member-role="${person.id}">
                ${roleSelectOptions(person.role)}
              </select>
            </label>
          ` : ""}
          <button class="ghost-button danger-text" type="button" data-delete-person="${person.id}">Remove</button>
        </div>
      </article>
    `).join("")
    : emptyState("No active team members.");
}

function assignmentStatusText(status) {
  return {
    assigned: "Assigned",
    in_progress: "In Progress",
    submitted: "Submitted",
    approved: "Approved",
    revision: "Revision",
    help: "Need Help"
  }[status] || status;
}

function priorityLabel(priority = "normal") {
  return {
    low: "Low",
    normal: "Normal",
    high: "High",
    urgent: "Urgent"
  }[priority] || priority;
}

function renderAssignments() {
  if (!$("#assignmentList")) return;
  const admin = canManageWorkspace();
  const own = ownTeamMember();
  const visibleAssignments = admin
    ? state.assignments
    : state.assignments.filter((assignment) => assignment.personId === own?.id);
  $("#assignmentListKicker").textContent = admin ? "Team Work" : "My Work";
  $("#assignmentListTitle").textContent = admin ? "Assigned Work" : "My Assigned Work";
  $("#assignmentList").innerHTML = visibleAssignments.length
    ? visibleAssignments.map((assignment) => {
        const person = getPerson(assignment.personId);
        const due = assignment.dueDate ? formatDateOnly(assignment.dueDate) : "No due date";
        return `
          <article class="assignment-card">
            <div class="assignment-card-main">
              <div class="assignment-title-row">
                <strong>${escapeHtml(assignment.title)}</strong>
                <span class="assignment-status ${assignment.status}">${assignmentStatusText(assignment.status)}</span>
              </div>
              <div class="assignment-meta-grid">
                <span><small>Owner</small>${escapeHtml(person?.name || "Unknown")}</span>
                <span><small>Type</small>${escapeHtml(assignment.workType)}</span>
                <span><small>Priority</small>${priorityLabel(assignment.priority)}</span>
                <span><small>Due</small>${due}</span>
              </div>
              ${assignment.notes ? `<div class="assignment-notes">${escapeHtml(assignment.notes)}</div>` : ""}
            </div>
            <div class="assignment-actions">
              ${assignment.url ? `<a class="ghost-button" href="${escapeHtml(assignment.url)}" target="_blank" rel="noopener">Open Link</a>` : ""}
              ${admin ? `
                <button class="ghost-button" type="button" data-assignment-status="${assignment.id}:approved">Approve</button>
                <button class="ghost-button" type="button" data-assignment-status="${assignment.id}:revision">Revision</button>
                <button class="ghost-button danger-text" type="button" data-delete-assignment="${assignment.id}">Delete</button>
              ` : `
                <button class="ghost-button" type="button" data-assignment-status="${assignment.id}:in_progress">Start</button>
                <button class="ghost-button" type="button" data-assignment-status="${assignment.id}:submitted">Submit</button>
                <button class="ghost-button" type="button" data-assignment-status="${assignment.id}:help">Need Help</button>
              `}
            </div>
          </article>
        `;
      }).join("")
    : emptyState(canManageWorkspace() ? "No work assigned yet." : "No assignments yet.");
}

function chatParticipantIds(thread) {
  return Array.isArray(thread?.memberIds) ? thread.memberIds : [];
}

function canSeeChatThread(thread) {
  if (canManageWorkspace()) return true;
  const own = ownTeamMember();
  return own && chatParticipantIds(thread).includes(own.id);
}

function directThreadFor(personId) {
  return state.chatThreads.find((thread) => thread.type === "direct" && chatParticipantIds(thread).includes(personId));
}

function visibleChatThreads() {
  const own = ownTeamMember();
  const directPeople = activeTeam().filter((person) => canManageWorkspace() ? person.id !== own?.id : person.userId !== currentUser?.id);
  const directItems = directPeople.map((person) => {
    const thread = directThreadFor(person.id);
    return {
      id: thread?.id || `direct:${person.id}`,
      type: "direct",
      title: person.name,
      meta: person.role || "Team Member",
      personId: person.id,
      updatedAt: thread?.updatedAt || person.joinedAt || person.createdAt,
      lastMessage: thread ? lastChatMessage(thread.id) : null
    };
  });
  const mappedDirectIds = new Set(directItems.map((item) => directThreadFor(item.personId)?.id).filter(Boolean));
  const existingDirectItems = state.chatThreads
    .filter((thread) => thread.type === "direct")
    .filter(canSeeChatThread)
    .filter((thread) => !mappedDirectIds.has(thread.id))
    .map((thread) => {
      const participant = chatParticipantIds(thread).map(getPerson).filter(Boolean).find((person) => person.id !== own?.id);
      return {
        id: thread.id,
        type: "direct",
        title: participant?.name || thread.title || "Direct Chat",
        meta: participant?.role || "Private conversation",
        updatedAt: thread.updatedAt,
        lastMessage: lastChatMessage(thread.id)
      };
    });
  const groupItems = state.chatThreads
    .filter((thread) => thread.type === "group")
    .filter(canSeeChatThread)
    .map((thread) => ({
      id: thread.id,
      type: "group",
      title: thread.title || "Group Chat",
      meta: `${chatParticipantIds(thread).length} members`,
      updatedAt: thread.updatedAt,
      lastMessage: lastChatMessage(thread.id)
    }));
  return [...groupItems, ...existingDirectItems, ...directItems].sort((a, b) => new Date(b.lastMessage?.createdAt || b.updatedAt || 0) - new Date(a.lastMessage?.createdAt || a.updatedAt || 0));
}

function lastChatMessage(threadId) {
  return state.chatMessages.filter((message) => message.threadId === threadId).slice(-1)[0] || null;
}

function selectedChatThread() {
  if (!selectedChatThreadId) return null;
  if (selectedChatThreadId.startsWith("direct:")) {
    const personId = selectedChatThreadId.split(":")[1];
    const existing = directThreadFor(personId);
    const person = getPerson(personId);
    return existing || (person ? { id: selectedChatThreadId, type: "direct", title: person.name, memberIds: [personId], virtual: true } : null);
  }
  return state.chatThreads.find((thread) => thread.id === selectedChatThreadId) || null;
}

function senderName(message) {
  const person = getPerson(message.senderEditorId);
  return person?.name || currentProfile?.display_name || currentUser?.email || "Member";
}

function renderChat() {
  if (!$("#chatThreadList")) return;
  const threads = visibleChatThreads();
  if (!selectedChatThreadId && threads.length) selectedChatThreadId = threads[0].id;
  if (selectedChatThreadId && !threads.some((thread) => thread.id === selectedChatThreadId)) selectedChatThreadId = threads[0]?.id || "";

  $("#chatThreadList").innerHTML = threads.length
    ? threads.map((thread) => `
      <button class="chat-thread ${thread.id === selectedChatThreadId ? "is-active" : ""}" type="button" data-chat-thread="${thread.id}">
        <span class="chat-thread-avatar">${thread.type === "group" ? "G" : escapeHtml(thread.title.slice(0, 1).toUpperCase())}</span>
        <span>
          <strong>${escapeHtml(thread.title)}</strong>
          <small>${escapeHtml(thread.lastMessage?.body || thread.meta || "No messages yet")}</small>
        </span>
      </button>
    `).join("")
    : emptyState(canManageWorkspace() ? "No active team members yet." : "No chats available yet.");

  const thread = selectedChatThread();
  const messageBox = $("#chatMessages");
  $("#manageGroupBtn").hidden = !(thread && thread.type === "group" && canManageWorkspace());
  if (!thread) {
    $("#chatThreadType").textContent = "Chat";
    $("#chatThreadTitle").textContent = "Select a chat";
    $("#chatThreadMeta").textContent = "Choose a member or group to start messaging.";
    messageBox.innerHTML = emptyState("No chat selected.");
    $("#chatMessageInput").disabled = true;
    return;
  }

  const participants = chatParticipantIds(thread).map(getPerson).filter(Boolean);
  $("#chatThreadType").textContent = thread.type === "group" ? "Group Chat" : "Direct Chat";
  $("#chatThreadTitle").textContent = thread.title || "Chat";
  $("#chatThreadMeta").textContent = thread.type === "group" ? participants.map((person) => person.name).join(", ") : "Private workspace conversation";
  $("#chatMessageInput").disabled = false;
  const messages = state.chatMessages.filter((message) => message.threadId === thread.id);
  messageBox.innerHTML = messages.length
    ? messages.map((message) => {
        const mine = message.senderId === currentUser?.id;
        return `
          <article class="chat-message ${mine ? "mine" : ""}">
            <strong>${escapeHtml(senderName(message))}</strong>
            <p>${escapeHtml(message.body)}</p>
            <small>${formatDateTimeWithDay(message.createdAt).date} ${formatDateTimeWithDay(message.createdAt).time}</small>
          </article>
        `;
      }).join("")
    : emptyState("No messages yet. Start the conversation.");
  messageBox.scrollTop = messageBox.scrollHeight;
}

async function ensureDirectChat(personId) {
  const existing = directThreadFor(personId);
  if (existing) return existing;
  const person = getPerson(personId);
  const own = ownTeamMember();
  const memberIds = [...new Set([personId, own?.id].filter(Boolean))];
  const payload = {
    workspace_id: currentWorkspace.id,
    thread_type: "direct",
    title: person?.name || "Direct Chat",
    member_editor_ids: memberIds,
    created_by: currentUser.id,
    updated_at: new Date().toISOString()
  };
  if (usingSupabase) {
    const { data, error } = await supabaseClient.rpc("create_chat_thread_rpc", {
      target_workspace_id: currentWorkspace.id,
      target_thread_type: "direct",
      target_title: person?.name || "Direct Chat",
      target_member_editor_ids: memberIds
    });
    if (error) throw new Error("Chat setup needed. Run chat-rpc-fix.sql in Supabase.");
    const threadId = Array.isArray(data) ? data[0] : data;
    return {
      id: threadId,
      workspaceId: currentWorkspace.id,
      type: "direct",
      title: payload.title,
      createdBy: currentUser.id,
      memberIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  return { id: uid(), workspaceId: currentWorkspace?.id, type: "direct", title: payload.title, memberIds, createdBy: currentUser?.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

async function createGroupChat() {
  if (!canManageWorkspace()) return showToast("Only workspace admin can create groups");
  const title = prompt("Group name?");
  if (!title?.trim()) return;
  const membersText = activeTeam().map((person, index) => `${index + 1}. ${person.name}`).join("\n");
  const picks = prompt(`Select members by number, comma separated:\n\n${membersText}`);
  if (!picks) return;
  const people = activeTeam();
  const memberIds = picks.split(",")
    .map((item) => Number(item.trim()) - 1)
    .filter((index) => index >= 0 && index < people.length)
    .map((index) => people[index].id);
  if (!memberIds.length) return showToast("Select at least one member");
  const payload = {
    workspace_id: currentWorkspace.id,
    thread_type: "group",
    title: title.trim(),
    member_editor_ids: [...new Set(memberIds)],
    created_by: currentUser.id,
    updated_at: new Date().toISOString()
  };
  if (usingSupabase) {
    const { error } = await supabaseClient.rpc("create_chat_thread_rpc", {
      target_workspace_id: currentWorkspace.id,
      target_thread_type: "group",
      target_title: payload.title,
      target_member_editor_ids: payload.member_editor_ids
    });
    if (error) return showToast("Chat setup needed. Run chat-rpc-fix.sql in Supabase.");
    await refreshRemote("Group created");
    return;
  }
  state.chatThreads.unshift({ id: uid(), workspaceId: currentWorkspace?.id, type: "group", title: payload.title, memberIds: payload.member_editor_ids, createdBy: currentUser?.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  saveState("Group created");
}

async function manageSelectedGroupChat() {
  const thread = selectedChatThread();
  if (!thread || thread.type !== "group" || !canManageWorkspace()) return;
  const people = activeTeam();
  const membersText = people.map((person, index) => `${index + 1}. ${person.name}${chatParticipantIds(thread).includes(person.id) ? " (added)" : ""}`).join("\n");
  const picks = prompt(`Update group members by number, comma separated:\n\n${membersText}`);
  if (!picks) return;
  const memberIds = picks.split(",")
    .map((item) => Number(item.trim()) - 1)
    .filter((index) => index >= 0 && index < people.length)
    .map((index) => people[index].id);
  if (!memberIds.length) return showToast("Select at least one member");
  const uniqueMemberIds = [...new Set(memberIds)];
  if (usingSupabase) {
    const { error } = await supabaseClient
      .from("chat_threads")
      .update({ member_editor_ids: uniqueMemberIds, updated_at: new Date().toISOString() })
      .eq("id", thread.id);
    if (error) return showToast(error.message);
    await refreshRemote("Group updated");
    return;
  }
  state.chatThreads = state.chatThreads.map((item) => item.id === thread.id ? { ...item, memberIds: uniqueMemberIds, updatedAt: new Date().toISOString() } : item);
  saveState("Group updated");
}

async function sendChatMessage(body) {
  const text = String(body || "").trim();
  if (!text) return;
  let thread = selectedChatThread();
  if (!thread) return;
  try {
    if (thread.virtual && thread.id.startsWith("direct:")) {
      thread = await ensureDirectChat(thread.id.split(":")[1]);
      selectedChatThreadId = thread.id;
      if (!state.chatThreads.some((item) => item.id === thread.id)) state.chatThreads.unshift(thread);
    }
    const own = ownTeamMember();
    const payload = {
      workspace_id: currentWorkspace.id,
      thread_id: thread.id,
      sender_id: currentUser.id,
      sender_editor_id: own?.id || null,
      body: text
    };
    if (usingSupabase) {
      const { error } = await supabaseClient.rpc("send_chat_message_rpc", {
        target_thread_id: thread.id,
        message_body: text
      });
      if (error) return showToast("Chat setup needed. Run chat-rpc-fix.sql in Supabase.");
      await refreshRemote("Message sent");
      return;
    }
    state.chatMessages.push({ id: uid(), workspaceId: currentWorkspace?.id, threadId: thread.id, senderId: currentUser?.id, senderEditorId: own?.id, body: text, createdAt: new Date().toISOString() });
    saveState("Message sent");
  } catch (err) {
    showToast(err.message || "Message could not send");
  }
}

function renderAdminControls() {
  if (!isAdmin()) return;
  const date = $("#adminDate").value || todayKey();
  const selectedPerson = $("#adminPerson").value || "all";
  const attendanceEntries = state.attendance
    .filter((entry) => dateFromTimestamp(entry.time) === date)
    .filter((entry) => selectedPerson === "all" || entry.personId === selectedPerson)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  const workEntries = state.work
    .filter((entry) => entry.date === date)
    .filter((entry) => selectedPerson === "all" || entry.personId === selectedPerson)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  $("#adminAttendanceList").innerHTML = attendanceEntries.length
    ? attendanceEntries.map((entry) => {
        const person = getPerson(entry.personId);
        const entryDate = formatDateTimeWithDay(entry.time);
        return `
          <article class="admin-item">
            <div>
              <strong>${escapeHtml(person?.name || "Unknown")} | ${actionLabel(entry.action)}</strong>
              <div class="meta-line">
                <span>${entryDate.day}</span>
                <span>${entryDate.date}</span>
                <span>${entryDate.time}</span>
                ${entry.note ? `<span>${escapeHtml(entry.note)}</span>` : ""}
              </div>
            </div>
            <div class="admin-item-actions">
              <button class="ghost-button" type="button" data-edit-attendance="${entry.id}">Edit</button>
              <button class="ghost-button danger-text" type="button" data-delete-attendance="${entry.id}">Delete</button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState("No attendance entries for this filter.");

  $("#adminWorkList").innerHTML = workEntries.length
    ? workEntries.map((entry) => {
        const person = getPerson(entry.personId);
        const taskCount = Number(entry.longVideos || 0) + Number(entry.shorts || 0);
        return `
          <article class="admin-item">
            <div>
              <strong>${escapeHtml(person?.name || "Unknown")} | ${taskCount} work items</strong>
              <div class="meta-line">
                <span>${formatDate(entry.date)}</span>
                <span>${entry.longVideos || 0} tasks</span>
                <span>${entry.shorts || 0} follow-ups</span>
                <span>${entry.thumbnails || 0} reviews</span>
                <span>${entry.otherCount || 0} other</span>
                <span>${statusText(entry.status)}</span>
              </div>
              ${entry.details ? `<div>${escapeHtml(entry.details)}</div>` : ""}
            </div>
            <div class="admin-item-actions">
              <button class="ghost-button" type="button" data-edit-work="${entry.id}">Edit</button>
              <button class="ghost-button danger-text" type="button" data-delete-work="${entry.id}">Delete</button>
            </div>
          </article>
        `;
      }).join("")
    : emptyState("No daily work entries for this filter.");
}

function renderReports() {
  const range = reportRangeFromPreset();
  const selectedPerson = $("#reportPerson").value || "all";
  updateDateHints();
  const rows = datesBetween(range.start, range.end).flatMap((date) => reportTeam()
    .filter((person) => selectedPerson === "all" || person.id === selectedPerson)
    .filter((person) => personMatchesReportDate(person, date))
    .map((person) => reportRow(person, date)));

  $("#reportRows").innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="11">No records found.</td></tr>`;
}

function applyReportFilters() {
  const range = reportRangeFromPreset();
  if (range.start > range.end) {
    showToast("Start date cannot be after end date");
    return;
  }
  renderReports();
  showToast("Report filter applied");
}

function reportRow(person, date) {
  const summary = attendanceSummary(person.id, date);
  const status = statusFor(person.id, date);
  const work = sumWork(workFor(person.id, date));
  const latestWork = workFor(person.id, date).at(-1);
  return `
    <tr>
      <td>${escapeHtml(person.name)}</td>
      <td>${escapeHtml(person.role)}</td>
      <td>${formatDay(date)}</td>
      <td>${formatDateOnly(date)}</td>
      <td>${summary.firstIn ? formatTime(summary.firstIn.time) : "-"}</td>
      <td>${hoursLabel(summary.breakMinutes)}</td>
      <td>${summary.lastOut ? formatTime(summary.lastOut.time) : "-"}</td>
      <td>${hoursLabel(summary.workingMinutes)}</td>
      <td>${work.longVideos}</td>
      <td>${work.shorts}</td>
      <td><span class="badge ${latestWork?.status || status.className}">${latestWork ? statusText(latestWork.status) : status.label}</span></td>
    </tr>
  `;
}

function statusText(status) {
  return {
    completed: "Completed",
    in_progress: "In progress",
    revision: "Revision",
    blocked: "Blocked"
  }[status] || status;
}

function emptyState(text) {
  return `<div class="empty">${text}</div>`;
}

async function addAttendance(personId, action, time = new Date().toISOString(), note = "") {
  if (!personId) {
    showToast("Select a team member first");
    return;
  }
  if (!canUsePerson(personId)) {
    showToast(isRemovedFromWorkspace() ? "Admin removed you from this workspace. Attendance is disabled." : "You can only update your own attendance");
    return;
  }
  if (usingSupabase) {
    if (!currentWorkspace) {
      showToast("Create or select a workspace first");
      return;
    }
    const { error } = await supabaseClient.from("attendance_logs").insert({
      workspace_id: currentWorkspace.id,
      editor_id: personId,
      action,
      happened_at: time,
      note: note.trim() || null,
      created_by: currentUser.id
    });
    if (error) {
      showToast(error.message);
      return;
    }
    await refreshRemote(`${actionLabel(action)} saved`);
    return;
  }
  state.attendance.push({
    id: uid(),
    personId,
    action,
    time,
    note: note.trim()
  });
  saveState(`${actionLabel(action)} saved`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function exportReportCsv() {
  const range = reportRangeFromPreset();
  const selectedPerson = $("#reportPerson").value || "all";
  const rows = datesBetween(range.start, range.end).flatMap((date) => reportTeam()
    .filter((person) => selectedPerson === "all" || person.id === selectedPerson)
    .filter((person) => personMatchesReportDate(person, date))
    .map((person) => {
      const summary = attendanceSummary(person.id, date);
      const status = statusFor(person.id, date);
      const workEntries = workFor(person.id, date);
      const work = sumWork(workEntries);
      const latestWork = workEntries.at(-1);
      return [
        person.name,
        person.role,
        formatDay(date),
        formatDateOnly(date),
        summary.firstIn ? formatTime(summary.firstIn.time) : "",
        hoursLabel(summary.breakMinutes),
        summary.lastOut ? formatTime(summary.lastOut.time) : "",
        hoursLabel(summary.workingMinutes),
        work.longVideos,
        work.shorts,
        work.thumbnails,
        work.otherCount,
        latestWork ? statusText(latestWork.status) : status.label,
        workEntries.map((entry) => entry.details).filter(Boolean).join(" | ")
      ];
    }));

  const header = ["Team Member", "Role", "Day", "Date", "In", "Break", "Out", "Hours", "Tasks", "Follow-ups", "Reviews", "Other", "Status", "Details"];
  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadFile(`avantex-report-${range.start}-to-${range.end}.csv`, csv, "text/csv");
}

async function refreshData(message = "Data refreshed") {
  if (usingSupabase) {
    await refreshRemote(message);
  } else {
    render();
    showToast(message);
  }
}

async function updateEditor(personId) {
  const person = getPerson(personId);
  if (!person) return;
  const name = prompt("Team member name", person.name);
  if (!name) return;
  const shift = prompt("Shift", person.shift || "") ?? person.shift;
  if (usingSupabase) {
    const { error } = await supabaseClient.from("editors").update({ name: name.trim(), shift: shift.trim() }).eq("id", person.id);
    if (error) return showToast(error.message);
    await refreshRemote("Team member updated");
  } else {
    person.name = name.trim();
    person.shift = shift.trim();
    saveState("Team member updated");
  }
}

async function setMemberAdminRole(personId, nextRole) {
  await updateMemberRole(personId, nextRole);
}

async function updateMemberRole(personId, roleChoice) {
  const person = getPerson(personId);
  if (!person?.userId || !currentWorkspace || !canManageWorkspace()) return;
  let customRole = "";
  if (roleChoice === "custom") {
    customRole = prompt("Custom role tag", roleChoiceFromLabel(person.role) === "custom" ? person.role : "") || "";
    if (!customRole.trim()) return showToast("Custom role is required");
  }
  const roleConfig = inviteRoleConfig(roleChoice, customRole);
  const role = roleConfig.permissionRole;
  const label = roleConfig.roleLabel;
  if (role === "admin" && !confirm(`Give admin access to ${person.name}?`)) {
    renderTeam();
    return;
  }
  if (usingSupabase) {
    const membershipResult = await supabaseClient
      .from("memberships")
      .update({ role, active: true })
      .eq("workspace_id", currentWorkspace.id)
      .eq("user_id", person.userId);
    if (membershipResult.error) return showToast(membershipResult.error.message);
    const editorResult = await supabaseClient
      .from("editors")
      .update({ role: label, active: true })
      .eq("id", person.id);
    if (editorResult.error) return showToast(editorResult.error.message);
    await refreshRemote(`${person.name} role updated`);
  } else {
    person.role = label;
    saveState(`${person.name} role updated`);
  }
}

async function updateAttendanceEntry(entryId) {
  const entry = state.attendance.find((item) => item.id === entryId);
  if (!entry) return;
  const action = prompt("Action: in, break_start, break_end, out", entry.action);
  if (!["in", "break_start", "break_end", "out"].includes(action)) {
    showToast("Invalid action");
    return;
  }
  const timeValue = prompt("Date/time", toDateTimeLocal(entry.time));
  if (!timeValue) return;
  const note = prompt("Note", entry.note || "") ?? "";
  const nextTime = new Date(timeValue).toISOString();
  if (usingSupabase) {
    const { error } = await supabaseClient
      .from("attendance_logs")
      .update({ action, happened_at: nextTime, note: note.trim() || null })
      .eq("id", entry.id);
    if (error) return showToast(error.message);
    await refreshRemote("Attendance updated");
  } else {
    Object.assign(entry, { action, time: nextTime, note: note.trim() });
    saveState("Attendance updated");
  }
}

async function deleteAttendanceEntry(entryId) {
  if (!confirm("Delete this attendance entry?")) return;
  if (usingSupabase) {
    const { error } = await supabaseClient.from("attendance_logs").delete().eq("id", entryId);
    if (error) return showToast(error.message);
    await refreshRemote("Attendance deleted");
  } else {
    state.attendance = state.attendance.filter((entry) => entry.id !== entryId);
    saveState("Attendance deleted");
  }
}

async function updateWorkEntry(entryId) {
  const entry = state.work.find((item) => item.id === entryId);
  if (!entry) return;
  const longVideos = Number(prompt("Completed tasks", entry.longVideos || 0));
  const shorts = Number(prompt("Follow-ups", entry.shorts || 0));
  const thumbnails = Number(prompt("Reviews", entry.thumbnails || 0));
  const otherCount = Number(prompt("Other tasks", entry.otherCount || 0));
  const details = prompt("Task details", entry.details || "") ?? "";
  const status = prompt("Status: completed, in_progress, revision, blocked", entry.status || "completed");
  if (!["completed", "in_progress", "revision", "blocked"].includes(status)) {
    showToast("Invalid status");
    return;
  }
  const payload = { longVideos, shorts, thumbnails, otherCount, details: details.trim(), status };
  if (usingSupabase) {
    const { error } = await supabaseClient
      .from("daily_work")
      .update({
        long_videos: longVideos,
        shorts,
        thumbnails,
        other_count: otherCount,
        details: details.trim() || null,
        status,
        updated_at: new Date().toISOString()
      })
      .eq("id", entry.id);
    if (error) return showToast(error.message);
    await refreshRemote("Daily work updated");
  } else {
    Object.assign(entry, payload);
    saveState("Daily work updated");
  }
}

async function deleteWorkEntry(entryId) {
  if (!confirm("Delete this daily work entry?")) return;
  if (usingSupabase) {
    const { error } = await supabaseClient.from("daily_work").delete().eq("id", entryId);
    if (error) return showToast(error.message);
    await refreshRemote("Daily work deleted");
  } else {
    state.work = state.work.filter((entry) => entry.id !== entryId);
    saveState("Daily work deleted");
  }
}

function bulkDeleteRange(kind) {
  const confirmText = $("#bulkConfirm").value.trim();
  if (confirmText !== "DELETE AVANTEX RECORDS") {
    showToast("Type DELETE AVANTEX RECORDS first");
    return;
  }
  const editorId = $("#bulkEditor").value;
  const startDate = $("#bulkStartDate").value;
  const endDate = $("#bulkEndDate").value;
  if (!startDate || !endDate || startDate > endDate) {
    showToast("Select a valid date range");
    return;
  }
  if (!confirm(`Delete ${kind} records from ${startDate} to ${endDate}?`)) return;
  runBulkDelete(kind, editorId, startDate, endDate);
}

async function runBulkDelete(kind, editorId, startDate, endDate) {
  if (usingSupabase) {
    const deleteAttendance = async () => {
      let query = supabaseClient
        .from("attendance_logs")
        .delete()
        .eq("workspace_id", currentWorkspace.id)
        .gte("happened_at", `${startDate}T00:00:00.000Z`)
        .lte("happened_at", `${endDate}T23:59:59.999Z`);
      if (editorId !== "all") query = query.eq("editor_id", editorId);
      return query;
    };
    const deleteWork = async () => {
      let query = supabaseClient
        .from("daily_work")
        .delete()
        .eq("workspace_id", currentWorkspace.id)
        .gte("work_date", startDate)
        .lte("work_date", endDate);
      if (editorId !== "all") query = query.eq("editor_id", editorId);
      return query;
    };
    if (kind === "attendance" || kind === "both") {
      const { error } = await deleteAttendance();
      if (error) return showToast(error.message);
    }
    if (kind === "work" || kind === "both") {
      const { error } = await deleteWork();
      if (error) return showToast(error.message);
    }
    $("#bulkConfirm").value = "";
    await refreshRemote("Records deleted");
    return;
  }

  const matchesEditor = (entry) => editorId === "all" || entry.personId === editorId;
  if (kind === "attendance" || kind === "both") {
    state.attendance = state.attendance.filter((entry) => {
      const date = dateFromTimestamp(entry.time);
      return !(matchesEditor(entry) && date >= startDate && date <= endDate);
    });
  }
  if (kind === "work" || kind === "both") {
    state.work = state.work.filter((entry) => !(matchesEditor(entry) && entry.date >= startDate && entry.date <= endDate));
  }
  $("#bulkConfirm").value = "";
  saveState("Records deleted");
}

async function createWorkspace(name) {
  if (!usingSupabase || !currentUser) return;
  const cleanName = name.trim();
  if (!cleanName) {
    showToast("Workspace name required");
    return;
  }
  const { error } = await supabaseClient.rpc("create_workspace_with_owner", { workspace_name: cleanName });
  if (error) return showToast(error.message);
  workspaceCreateOpen = false;
  await refreshRemote("Workspace created");
  const createdWorkspace = [...availableWorkspaces].reverse().find((workspace) => workspace.name === cleanName);
  if (createdWorkspace && createdWorkspace.id !== currentWorkspace?.id) {
    localStorage.setItem(WORKSPACE_KEY, createdWorkspace.id);
    await refreshRemote("Workspace selected");
  }
}

async function updateWorkspaceName(name, workspaceId = currentWorkspace?.id) {
  const targetWorkspace = availableWorkspaces.find((workspace) => workspace.id === workspaceId) || currentWorkspace;
  if (!targetWorkspace || !isWorkspaceOwnerFor(targetWorkspace.id)) return;
  const cleanName = name.trim();
  if (!cleanName) return showToast("Workspace name required");
  if (usingSupabase) {
    const rpcResult = await supabaseClient.rpc("update_workspace_name", {
      target_workspace_id: targetWorkspace.id,
      new_name: cleanName
    });
    if (rpcResult.error) {
      const updateResult = await supabaseClient.from("workspaces").update({ name: cleanName }).eq("id", targetWorkspace.id);
      if (updateResult.error) return showToast(rpcResult.error.message || updateResult.error.message);
    }
    await refreshRemote("Workspace name updated");
    return;
  }
  targetWorkspace.name = cleanName;
  showToast("Workspace name updated");
  render();
}

async function deleteWorkspace(workspaceId = currentWorkspace?.id) {
  const targetWorkspace = availableWorkspaces.find((workspace) => workspace.id === workspaceId) || currentWorkspace;
  if (!targetWorkspace || !isWorkspaceOwnerFor(targetWorkspace.id)) return;
  const workspaceName = targetWorkspace.name;
  if (!confirm(`Delete ${workspaceName}? Member access will stop, but history stays saved.`)) return;
  if (usingSupabase) {
    const rpcResult = await supabaseClient.rpc("archive_workspace", { target_workspace_id: targetWorkspace.id });
    if (rpcResult.error) return showToast(rpcResult.error.message);
    availableWorkspaces = availableWorkspaces.filter((workspace) => workspace.id !== targetWorkspace.id);
    workspaceMemberships = workspaceMemberships.filter((membership) => membership.workspace_id !== targetWorkspace.id);
    if (currentWorkspace?.id === targetWorkspace.id) localStorage.removeItem(WORKSPACE_KEY);
    await refreshRemote("Workspace deleted");
    return;
  }
  availableWorkspaces = availableWorkspaces.filter((workspace) => workspace.id !== targetWorkspace.id);
  currentWorkspace = availableWorkspaces[0] || null;
  render();
  showToast("Workspace deleted");
}

async function manageWorkspace(workspaceId) {
  const workspace = availableWorkspaces.find((item) => item.id === workspaceId);
  if (!workspace || !isWorkspaceOwnerFor(workspace.id)) return;
  const newName = prompt("Workspace name", workspace.name);
  if (newName) await updateWorkspaceName(newName, workspace.id);
}

async function createInvite(email, roleChoice, customRole = "") {
  if (!currentWorkspace || !canManageWorkspace()) return;
  const inviteEmail = email.trim().toLowerCase();
  if (!inviteEmail) return showToast("Member email required");
  const roleConfig = inviteRoleConfig(roleChoice, customRole);
  const token = uid().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  const invitePayload = {
    workspace_id: currentWorkspace.id,
    email: inviteEmail,
    role: roleConfig.permissionRole,
    role_label: roleConfig.roleLabel,
    token,
    invited_by: currentUser.id,
    expires_at: expiresAt
  };
  let { error } = await supabaseClient.from("workspace_invites").insert(invitePayload);
  if (error && (error.message || "").toLowerCase().includes("role_label")) {
    const fallbackPayload = { ...invitePayload };
    delete fallbackPayload.role_label;
    ({ error } = await supabaseClient.from("workspace_invites").insert(fallbackPayload));
    if (!error) showToast("Invite created. Run the role-label SQL patch for custom tags.");
  }
  if (error) return showToast(error.message);
  await refreshRemote("Invite created");
  await copyInviteLink(token);
  await sendInviteEmail(inviteEmail, token, roleConfig.roleLabel);
}

async function sendAssignmentEmail(person, assignment) {
  if (!person?.email) {
    showToast("Assignment saved. Email not sent because member email was not found.");
    return false;
  }
  const content = {
    to_email: person.email,
    to_name: person.name,
    title: `New assignment: ${assignment.title}`,
    subject: `New assignment: ${assignment.title}`,
    message: [
      `You have a new assignment in ${currentWorkspace?.name || "your workspace"}.`,
      `Title: ${assignment.title}`,
      `Type: ${assignment.workType}`,
      `Priority: ${assignment.priority}`,
      assignment.dueDate ? `Due date: ${formatDateOnly(assignment.dueDate)}` : "",
      assignment.url ? `Link: ${assignment.url}` : "",
      assignment.notes ? `Instructions: ${assignment.notes}` : "",
      `Open ${APP_REDIRECT_URL} to update status.`
    ].filter(Boolean).join("\n")
  };
  if (await ensureEmailJsReady()) {
    try {
      await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, content, { publicKey: EMAILJS_PUBLIC_KEY });
      showToast(`Assignment email sent to ${person.email}`);
      return true;
    } catch (error) {
      showToast("Assignment saved. Email notification could not be sent.");
    }
  }
  showToast("Assignment saved. Member will see it inside the tool.");
  return false;
}

async function createAssignment(data) {
  if (!currentWorkspace || !canManageWorkspace()) return;
  const person = getPerson(data.personId);
  if (!person) return showToast("Select a team member");
  const title = data.title.trim();
  if (!title) return showToast("Task title required");
  const payload = {
    workspace_id: currentWorkspace.id,
    assigned_to: person.id,
    assigned_by: currentUser.id,
    title,
    work_type: data.workType,
    work_url: data.url.trim() || null,
    notes: data.notes.trim() || null,
    priority: data.priority,
    status: "assigned",
    due_date: data.dueDate || null
  };
  const { data: insertedRows, error } = await supabaseClient
    .from("work_assignments")
    .insert(payload);
  if (error) {
    const message = (error.message || "").toLowerCase();
    if (message.includes("network")) return showToast("Assignment could not save. Run work-assignments-upgrade.sql in Supabase, then try again.");
    if (message.includes("work_assignments") || message.includes("schema") || message.includes("relation")) {
      return showToast("Assignments table is not ready. Run work-assignments-upgrade.sql in Supabase.");
    }
    return showToast(error.message);
  }
  const inserted = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
  state.assignments.unshift({
    id: inserted?.id || uid(),
    workspaceId: currentWorkspace.id,
    personId: person.id,
    assignedBy: currentUser.id,
    title,
    workType: data.workType,
    url: data.url.trim(),
    notes: data.notes.trim(),
    priority: data.priority,
    status: "assigned",
    dueDate: data.dueDate,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  render();
  showToast("Work assigned. Member will see it inside the tool.");
  syncRemoteSilently();
  await sendAssignmentEmail(person, {
    title,
    workType: data.workType,
    url: data.url.trim(),
    notes: data.notes.trim(),
    priority: data.priority,
    dueDate: data.dueDate,
    id: inserted?.id
  });
}

async function updateAssignmentStatus(assignmentId, status) {
  const assignment = state.assignments.find((item) => item.id === assignmentId);
  if (!assignment) return;
  const admin = canManageWorkspace();
  const own = ownTeamMember();
  if (!admin && assignment.personId !== own?.id) return showToast("You can only update your own assignments");
  const allowed = admin ? ["approved", "revision", "assigned", "in_progress", "submitted"] : ["in_progress", "submitted", "help"];
  if (!allowed.includes(status)) return showToast("Status not allowed");
  const { error } = await supabaseClient
    .from("work_assignments")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", assignmentId);
  if (error) return showToast(error.message);
  await refreshRemote("Assignment updated");
}

async function deleteAssignment(assignmentId) {
  if (!canManageWorkspace()) return;
  if (!confirm("Delete this assignment?")) return;
  const { error } = await supabaseClient.from("work_assignments").delete().eq("id", assignmentId);
  if (error) return showToast(error.message);
  await refreshRemote("Assignment deleted");
}

async function copyInviteLink(token) {
  const url = inviteUrl(token);
  try {
    await navigator.clipboard.writeText(url);
    showToast("Invite link copied");
  } catch {
    prompt("Copy invite link", url);
  }
}

async function sendInviteEmail(email, token, roleLabel = "Team Member") {
  const content = inviteEmailContent(email, token, roleLabel);
  try {
    const response = await fetch("/.netlify/functions/send-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(content)
    });
    if (response.ok) {
      showToast(`Invite email sent to ${email}`);
      return true;
    }
    const result = await response.json().catch(() => ({}));
    if (result?.error) showToast(result.error);
  } catch {
    // Local previews do not have Netlify Functions. Fall back below.
  }
  if (await ensureEmailJsReady()) {
    try {
      await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, content, {
        publicKey: EMAILJS_PUBLIC_KEY
      });
      showToast(`Invite email sent to ${email}`);
      return true;
    } catch (error) {
      showToast(error?.text || error?.message || "Automatic email failed");
    }
  } else {
    showToast("EmailJS not configured. Opening email draft.");
  }
  window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(content.subject)}&body=${encodeURIComponent(content.message)}`;
  return false;
}

async function cancelInvite(inviteId) {
  if (!inviteId || !currentWorkspace || !canManageWorkspace()) return;
  if (!confirm("Cancel this invite? The email row will be removed and a pending invite link will stop working.")) return;
  cancelledInviteIds.add(inviteId);
  workspaceInvites = workspaceInvites.filter((invite) => invite.id !== inviteId);
  renderWorkspacePanel();
  if (usingSupabase) {
    const rpcResult = await supabaseClient.rpc("cancel_workspace_invite", { invite_id: inviteId });
    if (rpcResult.error) {
      const deleteResult = await supabaseClient.from("workspace_invites").delete().eq("id", inviteId);
      if (deleteResult.error) return showToast(rpcResult.error.message || deleteResult.error.message);
    }
    await refreshRemote("Invite cancelled");
    return;
  }
  showToast("Invite cancelled");
}

async function removeTeamMember(personId) {
  const person = getPerson(personId);
  if (!person) return;
  if (!confirm(`Remove ${person.name} from this workspace? Old attendance and work records will stay saved.`)) return;
  if (usingSupabase) {
    const rpcResult = await supabaseClient.rpc("remove_workspace_member", { member_editor_id: person.id });
    if (rpcResult.error) {
      const editorUpdate = await supabaseClient.from("editors").update({ active: false }).eq("id", person.id);
      if (editorUpdate.error) return showToast(rpcResult.error.message || editorUpdate.error.message);
      if (person.userId) {
        const memberUpdate = await supabaseClient
          .from("memberships")
          .update({ active: false })
          .eq("workspace_id", currentWorkspace.id)
          .eq("user_id", person.userId);
        if (memberUpdate.error) return showToast(memberUpdate.error.message);
      }
    }
    state.team = state.team.map((item) => {
      const sameUser = person.userId && item.userId === person.userId;
      return item.id === person.id || sameUser ? { ...item, active: false } : item;
    });
    await refreshRemote(`${person.name} removed`);
    return;
  }
  person.active = false;
  saveState(`${person.name} removed`);
}

async function switchWorkspace(workspaceId) {
  if (!workspaceId || workspaceId === currentWorkspace?.id) return;
  localStorage.setItem(WORKSPACE_KEY, workspaceId);
  await refreshRemote("Workspace switched");
}

function setupEvents() {
  window.addEventListener("focus", () => {
    syncRemoteSilently();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncRemoteSilently();
  });

  $$(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $$("[data-view-jump]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewJump));
  });

  document.body.addEventListener("click", async (event) => {
    const authModeButton = event.target.closest("[data-auth-mode]");
    if (authModeButton) {
      event.preventDefault();
      openAuthPage(authModeButton.dataset.authMode);
      return;
    }

    const getStarted = event.target.closest("#getStartedBtn");
    if (getStarted) {
      event.preventDefault();
      openAuthPage("signup");
      return;
    }

    const authBack = event.target.closest("#authBackBtn");
    if (authBack) {
      event.preventDefault();
      closeAuthPage();
      return;
    }

    const quick = event.target.closest("[data-quick]");
    if (quick) {
      const [personId, action] = quick.dataset.quick.split(":");
      await addAttendance(personId, action);
    }

    const editPerson = event.target.closest("[data-edit-person]");
    if (editPerson) {
      await updateEditor(editPerson.dataset.editPerson);
    }

    const adminRole = event.target.closest("[data-admin-role]");
    if (adminRole) {
      const [personId, nextRole] = adminRole.dataset.adminRole.split(":");
      await setMemberAdminRole(personId, nextRole);
    }

    const editAttendance = event.target.closest("[data-edit-attendance]");
    if (editAttendance) {
      await updateAttendanceEntry(editAttendance.dataset.editAttendance);
    }

    const deleteAttendance = event.target.closest("[data-delete-attendance]");
    if (deleteAttendance) {
      await deleteAttendanceEntry(deleteAttendance.dataset.deleteAttendance);
    }

    const editWork = event.target.closest("[data-edit-work]");
    if (editWork) {
      await updateWorkEntry(editWork.dataset.editWork);
    }

    const deleteWork = event.target.closest("[data-delete-work]");
    if (deleteWork) {
      await deleteWorkEntry(deleteWork.dataset.deleteWork);
    }

    const copyInvite = event.target.closest("[data-copy-invite]");
    if (copyInvite) {
      await copyInviteLink(copyInvite.dataset.copyInvite);
    }

    const emailInvite = event.target.closest("[data-email-invite]");
    if (emailInvite) {
      await sendInviteEmail(emailInvite.dataset.inviteEmail, emailInvite.dataset.emailInvite, emailInvite.dataset.inviteRoleLabel || "Team Member");
    }

    const cancelInviteButton = event.target.closest("[data-cancel-invite]");
    if (cancelInviteButton) {
      await cancelInvite(cancelInviteButton.dataset.cancelInvite);
    }

    const toggle = event.target.closest("[data-toggle-person]");
    if (toggle) {
      const person = getPerson(toggle.dataset.togglePerson);
      if (person) {
        if (usingSupabase) {
          const { error } = await supabaseClient
            .from("editors")
            .update({ active: person.active === false })
            .eq("id", person.id);
          if (error) {
            showToast(error.message);
            return;
          }
          await refreshRemote(`${person.name} updated`);
        } else {
          person.active = person.active === false;
          saveState(`${person.name} updated`);
        }
      }
    }

    const remove = event.target.closest("[data-delete-person]");
    if (remove) {
      await removeTeamMember(remove.dataset.deletePerson);
    }

    const assignmentStatus = event.target.closest("[data-assignment-status]");
    if (assignmentStatus) {
      const [assignmentId, status] = assignmentStatus.dataset.assignmentStatus.split(":");
      await updateAssignmentStatus(assignmentId, status);
    }

    const deleteAssignmentButton = event.target.closest("[data-delete-assignment]");
    if (deleteAssignmentButton) {
      await deleteAssignment(deleteAssignmentButton.dataset.deleteAssignment);
    }

    const chatThreadButton = event.target.closest("[data-chat-thread]");
    if (chatThreadButton) {
      selectedChatThreadId = chatThreadButton.dataset.chatThread;
      renderChat();
    }

    const createGroupButton = event.target.closest("#createGroupBtn");
    if (createGroupButton) {
      await createGroupChat();
    }

    const manageGroupButton = event.target.closest("#manageGroupBtn");
    if (manageGroupButton) {
      await manageSelectedGroupChat();
    }
  });

  document.body.addEventListener("change", async (event) => {
    const roleSelect = event.target.closest("[data-member-role]");
    if (roleSelect) {
      await updateMemberRole(roleSelect.dataset.memberRole, roleSelect.value);
    }
  });

  $("#attendanceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addAttendance(
      $("#attendancePerson").value,
      $("#attendanceAction").value,
      new Date($("#attendanceTime").value).toISOString(),
      $("#attendanceNote").value
    );
    $("#attendanceNote").value = "";
    setCurrentInputs();
  });

  $("#workForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const workEntry = {
      personId: $("#workPerson").value,
      date: $("#workDate").value,
      longVideos: Number($("#workLongVideos").value || 0),
      shorts: Number($("#workShorts").value || 0),
      thumbnails: Number($("#workThumbnails").value || 0),
      otherCount: Number($("#workOtherCount").value || 0),
      details: $("#workDetails").value.trim(),
      status: $("#workStatus").value
    };
    if (!canUsePerson(workEntry.personId)) {
      showToast(isRemovedFromWorkspace() ? "Admin removed you from this workspace. Work updates are disabled." : "You can only update your own work");
      return;
    }
    if (usingSupabase) {
      if (!currentWorkspace) {
        showToast("Create or select a workspace first");
        return;
      }
      const { error } = await supabaseClient.rpc("save_daily_work_rpc", {
        target_editor_id: workEntry.personId,
        target_work_date: workEntry.date,
        target_long_videos: workEntry.longVideos,
        target_shorts: workEntry.shorts,
        target_thumbnails: workEntry.thumbnails,
        target_other_count: workEntry.otherCount,
        target_details: workEntry.details || null,
        target_status: workEntry.status
      });
      if (error) {
        showToast(error.message?.includes("function save_daily_work_rpc")
          ? "Run daily-work-rpc-fix.sql in Supabase, then try again."
          : error.message);
        return;
      }
    } else {
      const existing = state.work.find((entry) => entry.personId === workEntry.personId && entry.date === workEntry.date);
      if (existing) {
        Object.assign(existing, workEntry, { createdAt: existing.createdAt || new Date().toISOString() });
      } else {
        state.work.push({ id: uid(), ...workEntry, createdAt: new Date().toISOString() });
      }
    }
    $("#workLongVideos").value = 0;
    $("#workShorts").value = 0;
    $("#workThumbnails").value = 0;
    $("#workOtherCount").value = 0;
    $("#workDetails").value = "";
    if (usingSupabase) {
      await refreshRemote("Work update saved");
    } else {
      saveState("Work update saved");
    }
  });

  $("#assignmentForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await createAssignment({
      personId: $("#assignmentPerson").value,
      title: $("#assignmentTitle").value,
      workType: $("#assignmentType").value,
      url: $("#assignmentUrl").value,
      priority: $("#assignmentPriority").value,
      dueDate: $("#assignmentDueDate").value,
      notes: $("#assignmentNotes").value
    });
    event.target.reset();
  });

  $("#chatForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#chatMessageInput");
    await sendChatMessage(input.value);
    input.value = "";
  });

  $("#teamForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const editor = {
      name: $("#teamName").value.trim(),
      role: "Team Member",
      shift: $("#teamShift").value.trim(),
      active: true
    };
    if (usingSupabase) {
      if (!currentWorkspace) {
        showToast("Create or select a workspace first");
        return;
      }
      const { error } = await supabaseClient.from("editors").insert({ ...editor, workspace_id: currentWorkspace.id });
      if (error) {
        showToast(error.message);
        return;
      }
    } else {
      state.team.push({ id: uid(), ...editor });
    }
    event.target.reset();
    if (usingSupabase) {
      await refreshRemote("Team member added");
    } else {
      saveState("Team member added");
    }
  });

  $("#reportDate").addEventListener("change", renderReports);
  $("#reportPreset").addEventListener("change", () => {
    const custom = $("#reportPreset").value === "custom";
    $("#reportStartDate").disabled = !custom;
    $("#reportEndDate").disabled = !custom;
    const range = reportRangeFromPreset();
    $("#reportStartDate").value = range.start;
    $("#reportEndDate").value = range.end;
    renderReports();
  });
  $("#reportStartDate").addEventListener("change", () => {
    $("#reportPreset").value = "custom";
    $("#reportStartDate").disabled = false;
    $("#reportEndDate").disabled = false;
    renderReports();
  });
  $("#reportEndDate").addEventListener("change", () => {
    $("#reportPreset").value = "custom";
    $("#reportStartDate").disabled = false;
    $("#reportEndDate").disabled = false;
    renderReports();
  });
  $("#adminDate").addEventListener("change", renderAdminControls);
  $("#adminPerson").addEventListener("change", renderAdminControls);
  $("#attendanceTime").addEventListener("change", updateDateHints);
  $("#workDate").addEventListener("change", updateDateHints);
  $("#reportPerson").addEventListener("change", renderReports);
  $("#applyReportFilterBtn").addEventListener("click", applyReportFilters);
  $("#exportCsvBtn").addEventListener("click", exportReportCsv);
  $("#refreshBtn").addEventListener("click", () => refreshData());
  $("#workspaceSelect").addEventListener("change", (event) => switchWorkspace(event.target.value));
  $("#workspaceMenuBtn").addEventListener("click", () => toggleWorkspaceMenu());
  $("#profileMenuBtn").addEventListener("click", () => toggleProfileMenu());
  $("#profileMenu").addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-profile-action]");
    if (!actionButton) return;
    toggleProfileMenu(false);
    const action = actionButton.dataset.profileAction;
    if (action === "logout") {
      await signOut();
      return;
    }
    if (action === "refresh") {
      await refreshData();
      return;
    }
    if (action === "theme") {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      showToast(`${document.documentElement.dataset.theme === "dark" ? "Night" : "Day"} mode enabled`);
      return;
    }
    if (action === "dashboard") {
      switchView("dashboard");
      return;
    }
    if (action === "people" || action === "settings") {
      if (currentWorkspace && canManageWorkspace()) switchView("team");
      else showToast("People is available for workspace admins");
    }
  });
  $("#workspaceMenu").addEventListener("click", async (event) => {
    const menuButton = event.target.closest("[data-workspace-menu]");
    if (menuButton) {
      event.stopPropagation();
      toggleWorkspaceRowMenu(menuButton.dataset.workspaceMenu);
      return;
    }

    const renameWorkspaceButton = event.target.closest("[data-workspace-rename]");
    if (renameWorkspaceButton) {
      event.stopPropagation();
      closeWorkspaceRowMenus();
      toggleWorkspaceMenu(false);
      await manageWorkspace(renameWorkspaceButton.dataset.workspaceRename);
      return;
    }

    const deleteWorkspaceButton = event.target.closest("[data-workspace-delete]");
    if (deleteWorkspaceButton) {
      event.stopPropagation();
      closeWorkspaceRowMenus();
      toggleWorkspaceMenu(false);
      await deleteWorkspace(deleteWorkspaceButton.dataset.workspaceDelete);
      return;
    }

    const workspaceButton = event.target.closest("[data-workspace-id]");
    if (workspaceButton) {
      toggleWorkspaceMenu(false);
      await switchWorkspace(workspaceButton.dataset.workspaceId);
      return;
    }

    const actionButton = event.target.closest("[data-workspace-action]");
    if (!actionButton) return;
    toggleWorkspaceMenu(false);
    const action = actionButton.dataset.workspaceAction;
    if (action === "create") {
      showWorkspaceCreate();
      return;
    }
    if (action === "people") {
      if (currentWorkspace && canManageWorkspace()) switchView("team");
      else showToast("People is available for workspace admins");
      return;
    }
    if (action === "settings") {
      if (currentWorkspace && isWorkspaceOwner()) await manageWorkspace(currentWorkspace.id);
      else showToast("Workspace settings are available for owners");
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#workspaceSwitcher")) toggleWorkspaceMenu(false);
    if (!event.target.closest(".workspace-more-wrap")) closeWorkspaceRowMenus();
    if (!event.target.closest("#profileMenuWrap")) toggleProfileMenu(false);
  });
  $("#deleteAttendanceRangeBtn").addEventListener("click", () => bulkDeleteRange("attendance"));
  $("#deleteWorkRangeBtn").addEventListener("click", () => bulkDeleteRange("work"));
  $("#deleteAllRangeBtn").addEventListener("click", () => bulkDeleteRange("both"));

  $("#workspaceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await createWorkspace($("#workspaceName").value);
    event.target.reset();
  });

  $("#workspaceSettingsForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await updateWorkspaceName($("#workspaceSettingsName").value);
  });

  $("#deleteWorkspaceBtn")?.addEventListener("click", deleteWorkspace);

  $("#inviteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await createInvite($("#inviteEmail").value, $("#inviteRole").value, $("#inviteCustomRole").value);
    event.target.reset();
    $("#inviteCustomRoleWrap").hidden = true;
  });

  $("#inviteRole").addEventListener("change", (event) => {
    const custom = event.target.value === "custom";
    $("#inviteCustomRoleWrap").hidden = !custom;
    if (custom) $("#inviteCustomRole").focus();
    else $("#inviteCustomRole").value = "";
  });

  if ($("#exportJsonBtn")) {
    $("#exportJsonBtn").addEventListener("click", () => {
      downloadFile(`avantex-work-tracker-backup-${todayKey()}.json`, JSON.stringify(state, null, 2), "application/json");
    });
  }

  $("#importJsonInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported.team) || !Array.isArray(imported.attendance) || !Array.isArray(imported.work)) {
        throw new Error("Invalid backup");
      }
      state = imported;
      saveState("Backup imported");
    } catch {
      showToast("Backup file could not be imported");
    } finally {
      event.target.value = "";
    }
  });

  $("#clearDataBtn").addEventListener("click", () => {
    if (confirm("Clear all team members, attendance, and work data from this browser?")) {
      state = { team: [], attendance: [], work: [], assignments: [], chatThreads: [], chatMessages: [] };
      saveState("All data cleared");
    }
  });

  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    if ((authMode === "signup" || authMode === "reset") && password.length < 6) {
      $("#authMessage").textContent = "Password must be at least 6 characters.";
      return;
    }
    if (authMode === "reset") {
      $("#authMessage").textContent = "Saving new password...";
      const { error } = await supabaseClient.auth.updatePassword(password);
      if (error) {
        $("#authMessage").textContent = authErrorMessage(error);
        return;
      }
      passwordRecoveryMode = false;
      await supabaseClient.auth.signOut();
      currentUser = null;
      $("#loginPassword").value = "";
      openAuthPage("login", "Password updated. Login with your new password.");
      return;
    }
    $("#authMessage").textContent = authMode === "signup" ? "Creating account..." : "Logging in...";
    const { data, error } = authMode === "signup"
      ? await supabaseClient.auth.signUp({
          email,
          password,
          data: { display_name: $("#signupName").value.trim() || email.split("@")[0] }
        })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      const lowerError = (error.message || "").toLowerCase();
      if (authMode === "signup" && (lowerError.includes("already registered") || lowerError.includes("user already"))) {
        openAuthPage("login", "This email already has an account. Login with the same invited email to accept the workspace invite.");
        $("#loginEmail").value = email;
        return;
      }
      $("#authMessage").textContent = authErrorMessage(error);
      return;
    }
    if (authMode === "signup" && !data?.access_token && !data?.session) {
      $("#authMessage").textContent = inviteTokenFromUrl()
        ? "Account created. Open the confirmation email, then login with this same invited email."
        : "Account created. Check email if confirmation is required, then login.";
      return;
    }
    currentUser = await resolveAuthUser(data);
    if (!currentUser) {
      $("#authMessage").textContent = "Login succeeded, but user profile did not load. Refresh and try again.";
      return;
    }
    try {
      await loadRemoteState();
      lastSyncedAt = new Date().toISOString();
      hideAuthGate();
      applyAccessControls();
      updateSessionUI();
      render();
      startAutoRefresh();
      showToast(authMode === "signup" ? "Account created" : "Logged in");
    } catch (err) {
      showAuthGate(`Supabase setup needed: ${authErrorMessage(err)}`);
    }
  });

  $("#resendConfirmBtn").addEventListener("click", async () => {
    const email = $("#loginEmail").value.trim();
    if (!email) {
      $("#authMessage").textContent = "Enter your email first, then resend confirmation.";
      return;
    }
    $("#authMessage").textContent = "Sending confirmation email...";
    const { error } = await supabaseClient.auth.resendConfirmation(email);
    $("#authMessage").textContent = error
      ? authErrorMessage(error)
      : "Confirmation email sent again. Check inbox and spam folder.";
  });

  $("#forgotPasswordBtn").addEventListener("click", async () => {
    const email = $("#loginEmail").value.trim();
    if (!email) {
      $("#authMessage").textContent = "Enter old account email first, then click Forgot / Set Password.";
      $("#loginEmail").focus();
      return;
    }
    $("#authMessage").textContent = "Sending password reset email...";
    const { error } = await supabaseClient.auth.requestPasswordReset(email);
    $("#authMessage").textContent = error
      ? authErrorMessage(error)
      : "Password reset email sent. Open the link, set a new password, then login again.";
  });

}

function switchView(viewName) {
  setActiveView(viewName);
  render();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol !== "https:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // PWA install still works without blocking the app if registration fails.
    });
  });
}

registerServiceWorker();
bootApp();
