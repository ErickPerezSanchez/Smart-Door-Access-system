const state = {
  mode: "register",
  account: null,
  users: [],
  doors: [],
  assignments: [],
  stream: null,
  capture: null,
  accessLogs: []
};

const $ = (id) => document.getElementById(id);

const els = {
  authView: $("authView"),
  dashboardView: $("dashboardView"),
  authForm: $("authForm"),
  authSubmit: $("authSubmit"),
  toggleAuth: $("toggleAuth"),
  organizationName: $("organizationName"),
  email: $("email"),
  password: $("password"),
  authMessage: $("authMessage"),
  orgTitle: $("orgTitle"),
  accountEmail: $("accountEmail"),
  logoutButton: $("logoutButton"),
  userCount: $("userCount"),
  doorCount: $("doorCount"),
  assignmentCount: $("assignmentCount"),
  startCamera: $("startCamera"),
  camera: $("camera"),
  snapshotCanvas: $("snapshotCanvas"),
  snapshotPreview: $("snapshotPreview"),
  cameraPlaceholder: $("cameraPlaceholder"),
  enrollForm: $("enrollForm"),
  fullName: $("fullName"),
  captureFace: $("captureFace"),
  saveUser: $("saveUser"),
  enrollMessage: $("enrollMessage"),
  usersList: $("usersList"),
  doorForm: $("doorForm"),
  doorName: $("doorName"),
  doorsList: $("doorsList"),
  assignmentForm: $("assignmentForm"),
  assignUser: $("assignUser"),
  assignDoor: $("assignDoor"),
  assignmentsList: $("assignmentsList"),
  refreshLogs: $("refreshLogs"),
  accessLogsList: $("accessLogsList")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setAuthMode(mode) {
  state.mode = mode;
  const isRegister = mode === "register";
  if (els.organizationName) {
    els.organizationName.parentElement.classList.toggle("hidden", !isRegister);
  }
  els.authSubmit.textContent = isRegister ? "Create Account" : "Log In";
  els.toggleAuth.textContent = isRegister ? "Log In" : "Create Account";
  els.password.autocomplete = isRegister ? "new-password" : "current-password";
  els.authMessage.textContent = "";
}

function showDashboard(data) {
  state.account = data.account;
  state.users = data.users || [];
  state.doors = data.doors || [];
  state.assignments = data.assignments || [];
  els.authView.classList.add("hidden");
  els.dashboardView.classList.remove("hidden");
  render();
  loadAccessLogs();
}

function showAuth() {
  state.account = null;
  els.dashboardView.classList.add("hidden");
  els.authView.classList.remove("hidden");
}

function render() {
  if (!state.account) return;
  els.orgTitle.textContent = state.account.organizationName;
  els.accountEmail.textContent = state.account.email;
  els.userCount.textContent = state.users.length;
  els.doorCount.textContent = state.doors.length;
  els.assignmentCount.textContent = state.assignments.length;
  renderUsers();
  renderDoors();
  renderAssignmentControls();
  renderAssignments();
}

function renderUsers() {
  if (!state.users.length) {
    els.usersList.className = "list empty-state";
    els.usersList.textContent = "No authorized users yet.";
    return;
  }
  els.usersList.className = "list";
  els.usersList.innerHTML = state.users.map((user) => `
    <article class="record">
      <div class="record-main">
        <img class="avatar" src="${escapeAttr(user.faceCapture.imageDataUrl)}" alt="">
        <div>
          <p class="record-title">${escapeHtml(user.fullName)}</p>
          <p class="record-meta">${new Date(user.createdAt).toLocaleString()}</p>
        </div>
      </div>
      <button class="danger" type="button" data-delete-user="${escapeAttr(user.id)}">Remove</button>
    </article>
  `).join("");
}

function renderDoors() {
  if (!state.doors.length) {
    els.doorsList.className = "list empty-state";
    els.doorsList.textContent = "No Jetson door setup added yet.";
    return;
  }
  els.doorsList.className = "list";
  els.doorsList.innerHTML = state.doors.map((door) => {
    const syncPath = `/api/edge/door/${encodeURIComponent(door.id)}?token=${encodeURIComponent(door.syncToken)}`;
    return `
      <article class="record">
        <div>
          <p class="record-title">${escapeHtml(door.name)}</p>
          <p class="sync-link">${escapeHtml(syncPath)}</p>
        </div>
      </article>
    `;
  }).join("");
}

function renderAssignmentControls() {
  els.assignUser.innerHTML = state.users.map((user) => (
    `<option value="${escapeAttr(user.id)}">${escapeHtml(user.fullName)}</option>`
  )).join("");
  els.assignDoor.innerHTML = state.doors.map((door) => (
    `<option value="${escapeAttr(door.id)}">${escapeHtml(door.name)}</option>`
  )).join("");
  const disabled = !state.users.length || !state.doors.length;
  els.assignmentForm.querySelector("button").disabled = disabled;
}

function renderAssignments() {
  if (!state.assignments.length) {
    els.assignmentsList.className = "list empty-state";
    els.assignmentsList.textContent = "No door grants yet.";
    return;
  }
  els.assignmentsList.className = "list";
  els.assignmentsList.innerHTML = state.assignments.map((assignment) => {
    const user = state.users.find((item) => item.id === assignment.userId);
    const door = state.doors.find((item) => item.id === assignment.doorId);
    return `
      <article class="record">
        <div>
          <p class="record-title">${escapeHtml(user?.fullName || "Unknown user")}</p>
          <p class="record-meta">${escapeHtml(door?.name || "Unknown door")}</p>
        </div>
        <button class="danger" type="button" data-delete-assignment="${escapeAttr(assignment.id)}">Revoke</button>
      </article>
    `;
  }).join("");
}

async function loadMe() {
  try {
    const data = await api("/api/me");
    showDashboard(data);
  } catch {
    showAuth();
  }
}

async function startCamera() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  els.camera.srcObject = state.stream;
  els.cameraPlaceholder.classList.add("hidden");
  els.snapshotPreview.classList.add("hidden");
  els.camera.classList.remove("hidden");
}

function captureFace() {
  if (!state.stream) {
    els.enrollMessage.textContent = "Start the camera first.";
    return;
  }
  const video = els.camera;
  const canvas = els.snapshotCanvas;
  canvas.width = video.videoWidth || 960;
  canvas.height = video.videoHeight || 540;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageDataUrl = canvas.toDataURL("image/jpeg", 0.86);
  state.capture = {
    imageDataUrl,
    capturedAt: new Date().toISOString(),
    qualityNote: "Captured from the cloud page camera"
  };
  els.snapshotPreview.src = imageDataUrl;
  els.snapshotPreview.classList.remove("hidden");
  els.camera.classList.add("hidden");
  els.enrollMessage.textContent = "Face captured. Add the user details and save the user.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

async function loadAccessLogs() {
  try {
    const data = await api("/api/access-logs");
    state.accessLogs = data.logs || [];
    renderAccessLogs();
  } catch (error) {
    els.accessLogsList.className = "list empty-state";
    els.accessLogsList.textContent = "Could not load access logs.";
  }
}

function renderAccessLogs() {
  if (!state.accessLogs.length) {
    els.accessLogsList.className = "list empty-state";
    els.accessLogsList.textContent = "No access logs yet.";
    return;
  }

  els.accessLogsList.className = "list";
  els.accessLogsList.innerHTML = state.accessLogs.map((log) => {
    const time = formatLogTime(log.timestamp);
    const result = log.result || log.status || "unknown";
    const door = log.doorName || log.doorId || "Unknown door";
    const user = log.userName || log.fullName || log.userId || "Unknown user";

    return `
      <article class="record">
        <div>
          <p class="record-title">${escapeHtml(result.toUpperCase())} - ${escapeHtml(user)}</p>
          <p class="record-meta">${escapeHtml(door)} - ${escapeHtml(time)}</p>
        </div>
      </article>
    `;
  }).join("");
}

function formatLogTime(timestamp) {
  if (!timestamp) return "No time";

  if (typeof timestamp === "string") {
    return new Date(timestamp).toLocaleString();
  }

  if (timestamp._seconds) {
    return new Date(timestamp._seconds * 1000).toLocaleString();
  }

  return String(timestamp);
}

els.toggleAuth.addEventListener("click", () => {
  setAuthMode(state.mode === "register" ? "login" : "register");
});

els.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.authMessage.textContent = "";
  const body = {
    email: els.email.value,
    password: els.password.value,
    organizationName: els.organizationName?.value || "Smart Door"
  };
  try {
    const path = state.mode === "register" ? "/api/auth/register" : "/api/auth/login";
    await api(path, { method: "POST", body: JSON.stringify(body) });
    await loadMe();
    els.authForm.reset();
  } catch (error) {
    els.authMessage.textContent = error.message;
  }
});

els.logoutButton.addEventListener("click", async () => {
  await api("/api/auth/logout", {
    method: "POST",
    body: "{}"
  });

  // stop webcam
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;
  }

  // clear camera UI
  els.camera.srcObject = null;
  els.camera.classList.add("hidden");
  els.snapshotPreview.classList.add("hidden");
  els.cameraPlaceholder.classList.remove("hidden");

  showAuth();
});

els.startCamera.addEventListener("click", async () => {
  try {
    await startCamera();
    els.enrollMessage.textContent = "";
  } catch (error) {
    els.enrollMessage.textContent = "The browser needs camera permission for this part.";
  }
});

els.captureFace.addEventListener("click", captureFace);

els.refreshLogs.addEventListener("click", loadAccessLogs);

setInterval(() => {
  if (state.account) {
    loadAccessLogs();
  }
}, 10000);

els.enrollForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.enrollMessage.textContent = "";
  if (!state.capture) {
    els.enrollMessage.textContent = "Take the face pic before adding the person.";
    return;
  }
  try {
    const data = await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        fullName: els.fullName.value,
        faceCapture: state.capture
      })
    });
    state.users.unshift(data.user);
    state.capture = null;
    els.enrollForm.reset();
    els.snapshotPreview.classList.add("hidden");
    els.camera.classList.remove("hidden");
    els.enrollMessage.textContent = "Added. This person will show up in the Jetson sync list when assigned to a door.";
    render();
  } catch (error) {
    els.enrollMessage.textContent = error.message;
  }
});

els.doorForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = await api("/api/doors", {
    method: "POST",
    body: JSON.stringify({
      name: els.doorName.value
    })
  });
  state.doors.unshift(data.door);
  els.doorForm.reset();
  render();
});

els.assignmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = await api("/api/assignments", {
    method: "POST",
    body: JSON.stringify({
      userId: els.assignUser.value,
      doorId: els.assignDoor.value
    })
  });
  state.users = data.users;
  state.doors = data.doors;
  state.assignments = data.assignments;
  render();
});

document.addEventListener("click", async (event) => {
  const deleteUser = event.target.closest("[data-delete-user]");
  if (deleteUser) {
    await api(`/api/users/${encodeURIComponent(deleteUser.dataset.deleteUser)}`, { method: "DELETE" });
    await loadMe();
    return;
  }

  const deleteAssignment = event.target.closest("[data-delete-assignment]");
  if (deleteAssignment) {
    const data = await api(`/api/assignments/${encodeURIComponent(deleteAssignment.dataset.deleteAssignment)}`, {
      method: "DELETE"
    });
    state.users = data.users;
    state.doors = data.doors;
    state.assignments = data.assignments;
    render();
  }
});

setAuthMode("login");
loadMe();
