const admin = require("firebase-admin");
const serviceAccount = require("./facedetect-7320e-firebase-adminsdk-fbsvc-90c63bb9c0.json");

const crypto = require("crypto");
const http = require("http");
const path = require("path");
const fs = require("fs/promises");
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();



function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    header.split(";").map((part) => {
      const [key, ...value] = part.trim().split("=");
      return [key, decodeURIComponent(value.join("=") || "")];
    }).filter(([key]) => key)
  );
  return cookies[name];
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    organizationName: account.organizationName,
    createdAt: account.createdAt
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, account) {
  const { hash } = hashPassword(password, account.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(account.passwordHash, "hex"));
}

async function getSession(req) {
  const token = getCookie(req, "fd_session");

  if (!token) return null;

  const sessionDoc = await firestore
    .collection("sessions")
    .doc(token)
    .get();

  if (!sessionDoc.exists) return null;

  const session = sessionDoc.data();

  if (session.expiresAt <= Date.now()) {
    await sessionDoc.ref.delete();
    return null;
  }

  const accountDoc = await firestore
    .collection("accounts")
    .doc(session.accountId)
    .get();

  if (!accountDoc.exists) return null;

  const account = accountDoc.data();

  return { session, account };
}

async function requireSession(req, res) {
  const current = await getSession(req);
  if (!current) {
    json(res, 401, { error: "Please log in first." });
    return null;
  }
  return current;
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    accountId: user.accountId,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    faceCapture: user.faceCapture,
    embeddingVersion: user.embeddingVersion,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function accountScope(accountId) {
  const doors = await firestore.collection("doors").where("accountId", "==", accountId).get();
  const users = await firestore.collection("authorizedUsers").where("accountId", "==", accountId).get();
  const assignments = await firestore.collection("doorAssignments").where("accountId", "==", accountId).get();
  return {
    doors: doors.docs.map((doc) => doc.data()),
    users: users.docs.map((doc) => sanitizeUser(doc.data())),
    assignments: assignments.docs.map((doc) => doc.data())
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const organizationName = String(body.organizationName || "").trim();
    if (!validateEmail(email) || password.length < 8 || organizationName.length < 2) {
      return json(res, 400, { error: "Add an email, an 8+ character password, and a team/project name." });
    }
    const snapshot = await firestore
      .collection("accounts")
      .where("email", "==", email)
      .get();

    if (!snapshot.empty) {
      return json(res, 409, {
        error: "An account already exists for that email."
      });
    }
    const { salt, hash } = hashPassword(password);
    const account = {
      id: makeId("acct"),
      email,
      organizationName,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };
    await firestore.collection("accounts").doc(account.id).set(account);
    await createSession(res, account.id);
    return json(res, 201, { account: publicAccount(account) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const snapshot = await firestore
      .collection("accounts")
      .where("email", "==", email)
      .get();

    const account = snapshot.docs[0]?.data();
    if (!account || !verifyPassword(password, account)) {
      return json(res, 401, { error: "Email or password is incorrect." });
    }
    await createSession(res, account.id);
    return json(res, 200, { account: publicAccount(account) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = getCookie(req, "fd_session");
    const snapshot = await firestore
      .collection("sessions")
      .where("token", "==", token)
      .get();

    for (const doc of snapshot.docs) {
      await doc.ref.delete();
    }
    res.setHeader("Set-Cookie", "fd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    const current = await requireSession(req, res);
    if (!current) return;
    return json(res, 200, {
      account: publicAccount(current.account),
      ...(await accountScope(current.account.id))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await readBody(req);
    const fullName = String(body.fullName || "").trim();
    const role = String(body.role || "Member").trim() || "Member";
    const faceCapture = body.faceCapture;
    if (fullName.length < 2 || !faceCapture?.imageDataUrl) {
      return json(res, 400, { error: "A name and face capture are required." });
    }
    const now = new Date().toISOString();
    const user = {
      id: makeId("usr"),
      accountId: current.account.id,
      fullName,
      role,
      status: "authorized",
      faceCapture: {
        imageDataUrl: faceCapture.imageDataUrl,
        capturedAt: faceCapture.capturedAt || now,
        qualityNote: faceCapture.qualityNote || "Pending embedding generation"
      },
      embeddingVersion: "facenet-jetson-nano-v1",
      createdAt: now,
      updatedAt: now
    };
    await firestore.collection("authorizedUsers").doc(user.id).set(user);
    return json(res, 201, { user: sanitizeUser(user) });
  }
  if (req.method === "GET" && url.pathname === "/api/access-logs") {
    const current = await requireSession(req, res);
    if (!current) return;
    const logsSnapshot = await firestore
      .collection("accessLogs")
      .where("accountId", "==", current.account.id)
      .limit(100)
      .get();

    const logs = logsSnapshot.docs.map((doc) => doc.data());
    return json(res, 200, { logs });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
  const current = await requireSession(req, res);

  if (!current) return;

  const userId = url.pathname.split("/").pop();

  const userDoc = await firestore
    .collection("authorizedUsers")
    .doc(userId)
    .get();

  if (!userDoc.exists) {
    return notFound(res);
  }

  await firestore
    .collection("authorizedUsers")
    .doc(userId)
    .delete();

  const assignmentsSnapshot = await firestore
    .collection("doorAssignments")
    .where("userId", "==", userId)
    .get();

  for (const doc of assignmentsSnapshot.docs) {
    await doc.ref.delete();
  }

  return json(res, 200, { ok: true });
}

  if (req.method === "POST" && url.pathname === "/api/doors") {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const location = String(body.location || "").trim();
    if (name.length < 2) return json(res, 400, { error: "Door name is required." });
    const now = new Date().toISOString();
    const door = {
      id: makeId("door"),
      accountId: current.account.id,
      name,
      location,
      syncToken: crypto.randomBytes(24).toString("hex"),
      createdAt: now,
      updatedAt: now
    };
    await firestore.collection("doors").doc(door.id).set(door);
    return json(res, 201, { door });
  }

  if (req.method === "POST" && url.pathname === "/api/assignments") {
  const current = await requireSession(req, res);

  if (!current) return;

  const body = await readBody(req);

  const doorDoc = await firestore
    .collection("doors")
    .doc(body.doorId)
    .get();

  const userDoc = await firestore
    .collection("authorizedUsers")
    .doc(body.userId)
    .get();

  if (!doorDoc.exists || !userDoc.exists) {
    return json(res, 400, {
      error: "Choose a valid door and user."
    });
  }

  const existingAssignments = await firestore
    .collection("doorAssignments")
    .where("doorId", "==", body.doorId)
    .where("userId", "==", body.userId)
    .get();

  if (existingAssignments.empty) {
    const assignment = {
      id: makeId("asg"),
      accountId: current.account.id,
      doorId: body.doorId,
      userId: body.userId,
      createdAt: new Date().toISOString()
    };

    await firestore
      .collection("doorAssignments")
      .doc(assignment.id)
      .set(assignment);

    await firestore
      .collection("doors")
      .doc(body.doorId)
      .update({
        updatedAt: new Date().toISOString()
      });
  }

  return json(
    res,
    200,
    await accountScope(current.account.id)
  );
}

  if (req.method === "DELETE" && url.pathname.startsWith("/api/assignments/")) {
    const current = await requireSession(req, res);
    if (!current) return;
    const assignmentId = url.pathname.split("/").pop();
    await firestore.collection("doorAssignments").doc(assignmentId).delete();
    return json(res, 200, await accountScope(current.account.id));
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/edge/door/")) {
    const doorId = url.pathname.split("/").pop();
    const token = url.searchParams.get("token");

    const doorDoc = await firestore.collection("doors").doc(doorId).get();

    if (!doorDoc.exists) {
      return json(res, 401, { error: "Invalid door sync credentials." });
    }

    const door = doorDoc.data();

    if (door.syncToken !== token) {
      return json(res, 401, { error: "Invalid door sync credentials." });
    }

    const assignmentsSnapshot = await firestore
      .collection("doorAssignments")
      .where("doorId", "==", door.id)
      .get();

    const assignmentUserIds = assignmentsSnapshot.docs.map((doc) => doc.data().userId);

    const users = [];

    for (const userId of assignmentUserIds) {
      const userDoc = await firestore.collection("authorizedUsers").doc(userId).get();

      if (userDoc.exists) {
        const user = userDoc.data();

        if (user.status === "authorized") {
          users.push({
            id: user.id,
            fullName: user.fullName,
            role: user.role,
            status: user.status,
            embeddingVersion: user.embeddingVersion,
            faceCapture: user.faceCapture,
            updatedAt: user.updatedAt
          });
        }
      }
    }

    return json(res, 200, {
      door: {
        id: door.id,
        name: door.name,
        location: door.location
      },
      generatedAt: new Date().toISOString(),
      authorizedUsers: users
    });
  }

  notFound(res);
}

async function createSession(res, accountId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await firestore.collection("sessions").doc(token).set({token, accountId, expiresAt, createdAt: new Date().toISOString()});
  res.setHeader(
    "Set-Cookie",
    `fd_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`Smart Door cloud page running at http://localhost:${PORT}`);
});
