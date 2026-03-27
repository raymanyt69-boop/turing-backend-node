import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch"; // Make sure you have installed node-fetch

const app = express();
app.use(cors());
app.use(express.json());

// Log incoming API requests (method, path, ip, small body preview)
app.use('/api', (req, res, next) => {
  try {
    const bodyPreview = req.method === 'POST' && req.body ? (typeof req.body === 'object' ? JSON.stringify(req.body, null, 0) : String(req.body)) : undefined;
    console.log('API Request ->', { method: req.method, path: req.originalUrl, ip: req.ip, body: bodyPreview });
  } catch (e) {
    console.log('API Request -> (failed to stringify body)');
  }
  next();
});

// Use environment variables for APPSCRIPT_URL and APPSCRIPT_TOKEN
const APPSCRIPT_URL = process.env.APPSCRIPT_URL;
const APPSCRIPT_TOKEN = process.env.APPSCRIPT_TOKEN;

// Initialize Firebase Admin.
// On Railway you can provide the service account JSON as the
// environment variable `GOOGLE_SERVICE_ACCOUNT` (one-line JSON string).
// If not present we fall back to default credentials.
let db;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    try {
      const svc = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(svc) });
      console.log(
        "Initialized firebase-admin using GOOGLE_SERVICE_ACCOUNT env"
      );
    } catch (err) {
      console.error(
        "Failed to parse GOOGLE_SERVICE_ACCOUNT JSON, falling back to default credentials:",
        err
      );
      admin.initializeApp();
    }
  } else {
    admin.initializeApp();
    console.log("Initialized firebase-admin with default credentials");
  }
  db = admin.firestore();
} catch (e) {
  console.error(
    "Failed to initialize firebase-admin or obtain firestore instance:",
    e
  );
}

if (!APPSCRIPT_URL) {
  console.warn(
    "APPSCRIPT_URL not set; endpoint will return 500 until configured"
  );
}

app.post("/api/register", async (req, res) => {
  try {
    const { workshopId, name, email, phone, age, governorate } = req.body || {};
    if (!email || !name) return res.status(400).send("missing required fields");

    // Write registration to Firestore first
    let docRef = null;
    try {
      docRef = await db.collection("workshop_registrations").add({
        workshopId: workshopId || null,
        name: name || null,
        email: email || null,
        phone: phone || null,
        age: age || null,
        governorate: governorate || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        email_requested: true,
        email_sent: false,
      });
      console.log("Saved registration to Firestore", docRef.id);
    } catch (err) {
      console.error("Failed to save registration to Firestore", err);
      // continue — we still attempt to forward, but note the error
    }

    // Ensure backend is configured with Apps Script URL
    if (!APPSCRIPT_URL) {
      console.error(
        "APPSCRIPT_URL not configured; cannot forward registration"
      );
      // update Firestore doc with error if created
      if (docRef)
        await docRef.update({
          email_error: "APPSCRIPT_URL not set",
          email_requested: false,
        });
      return res
        .status(500)
        .send("server misconfiguration: APPSCRIPT_URL not set");
    }

    // Forward to Apps Script as JSON (Apps Script expects JSON body)
    const payload = {
      name: name || "",
      email: email || "",
      phone: phone || "",
      age: age || "",
      governorate: governorate || "",
      program_id: workshopId || "",
      // include program title/name and optional group link so Apps Script can render email HTML
      program_title: (req.body && req.body.program_title) || "",
      program_name: (req.body && req.body.program_title) || "",
      group_link: (req.body && req.body.group_link) || "",
    };
    if (APPSCRIPT_TOKEN) payload.token = APPSCRIPT_TOKEN;

    console.log("Forwarding registration to Apps Script (JSON)", {
      workshopId,
      email,
      name,
    });
    let resp;
    try {
      resp = await fetch(APPSCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Fetch to Apps Script failed", err);
      if (docRef)
        await docRef.update({
          email_sent: false,
          email_error: String(err),
          email_requested: false,
        });
      throw err;
    }

    const text = await resp.text();
    // Try to parse JSON response and treat `{ error: ... }` as failure
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // not JSON, ignore
    }

    if (!resp.ok || (parsed && parsed.error)) {
      const errMsg = parsed && parsed.error ? parsed.error : text;
      console.error(
        "Apps Script returned non-OK or error field",
        resp.status,
        errMsg
      );
      if (docRef)
        await docRef.update({
          email_sent: false,
          email_response: text,
          email_requested: false,
        });
      return res.status(502).send(errMsg || "apps script error");
    }

    // mark Firestore doc as emailed
    if (docRef) {
      try {
        await docRef.update({
          email_sent: true,
          email_response: text,
          emailedAt: admin.firestore.FieldValue.serverTimestamp(),
          email_requested: false,
        });
      } catch (err) {
        console.error("Failed to update Firestore doc with email status", err);
      }
    }

    return res.status(200).json({ success: true, data: text });
  } catch (err) {
    console.error("register error", err);
    return res.status(500).send(String(err));
  }
});

// POST /api/ticket/send - send ticket(s) for a payment identified by paymentId or email
app.post("/api/ticket/send", async (req, res) => {
  try {
    console.log("/api/ticket/send invoked", { body: req.body });
    const { paymentId, email, force } = req.body || {};
    if (!paymentId && !email) return res.status(400).json({ error: "missing paymentId or email" });

    let doc = null;
    if (paymentId) {
      // Log the paymentId being searched for
      console.log("Looking for payment document with paymentId:", paymentId);

      console.log("Received paymentId:", paymentId);  // Log paymentId from request

      
      // Query Firestore using the paymentId as the document ID
      const paymentDoc = await db.collection("payments").doc(paymentId).get();

      console.log("current paymentDoc:", paymentDoc.data);
      
      if (paymentDoc.exists) {
        doc = paymentDoc;
        console.log("Found payment doc:", paymentDoc.id);
      } else {
        console.error("Payment not found:", paymentId);
      }
    } else if (email) {
      // Query by email if paymentId is not provided
      const snap = await db
        .collection("payments")
        .where("email", "==", String(email))
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!snap.empty) {
        doc = snap.docs[0];
        console.log("Found payment doc by email:", doc.id);
      } else {
        console.error("Payment not found for email:", email);
      }
    }

    if (!doc) return res.status(404).json({ error: "payment not found" });

    const data = doc.data();
    if (data.dismissed) return res.status(400).json({ error: "payment dismissed" });
    if (data.ticketSent && !force) {
      console.log("Skipping send: ticket already sent and force flag not set", { id: doc.id });
      return res.json({ ok: true, message: "ticket already sent" });
    }
    if (data.ticketSent && force) {
      console.log("Force resend requested for payment", { id: doc.id });
    }

    // Build ticket codes
    const baseTicket = data.order || data.sessionId || `ticket-${doc.id}`;
    const packageId =
      (data.metaData && (data.metaData.packageId || data.metaData.package)) ||
      (data.response && data.response.metaData && (data.response.metaData.packageId || data.response.metaData.package)) ||
      data.packageId || "";

    let ticketCodes = [baseTicket];
    let qrUrls = [ `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(baseTicket)}` ];
    if (String(packageId).toLowerCase() === "friends") {
      ticketCodes = Array.from({ length: 5 }, (_, i) => `${baseTicket}-${i + 1}`);
      qrUrls = ticketCodes.map((c) => `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(c)}`);
    }

    const ticketLinks = ticketCodes.map((c) => `${process.env.FRONTEND_BASE || ""}/ticket-verify?code=${encodeURIComponent(c)}`);

    const appsPayload = {
      template: "ticket",
      ticketCode: ticketCodes[0],
      qrUrl: qrUrls[0],
      ticketLink: ticketLinks[0],
      ticketCodes,
      qrUrls,
      ticketLinks,
      name: (data.user && data.user.name) || data.name || "",
      email: (data.user && data.user.email) || data.email || email || "",
      phone: (data.user && data.user.phone) || data.phone || "",
      age: (data.user && data.user.age) || data.age || null,
      program_id: data.order || "",
      program_title: packageId || "",
      program_name: packageId || "",
      group_link: (data.metaData && data.metaData.group_link) || "",
    };

    if (APPSCRIPT_TOKEN) appsPayload.token = APPSCRIPT_TOKEN;

    if (!APPSCRIPT_URL) {
      return res.status(500).json({ error: "APPSCRIPT_URL not configured" });
    }

    try {
      console.log("Calling Apps Script", { url: APPSCRIPT_URL, tokenPresent: !!APPSCRIPT_TOKEN });
      console.log("Apps Script payload preview", { ticketCode: appsPayload.ticketCode, email: appsPayload.email, ticketCodesCount: Array.isArray(appsPayload.ticketCodes) ? appsPayload.ticketCodes.length : 0 });
      const resp = await fetch(APPSCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(appsPayload),
      });
      const text = await resp.text();
      console.log("Apps Script response", { status: resp.status, ok: resp.ok, body: text });

      // Update payment doc with ticket details
      try {
        await doc.ref.update({
          ticketSent: resp.ok,
          ticketSentAt: admin.firestore.FieldValue.serverTimestamp(),
          ticketCode: ticketCodes[0],
          ticketCodes,
          qrUrl: qrUrls[0],
          qrUrls,
          ticketLinks,
          ticketResponse: text,
        });
      } catch (uErr) {
        console.error("Failed to update payment doc with ticket info", uErr);
      }

      return res.json({ ok: true, ticketSent: resp.ok, response: text });
    } catch (err) {
      console.error("Apps Script send failed", err);
      return res.status(500).json({ error: "apps script send failed" });
    }
  } catch (err) {
    console.error("/api/ticket/send error", err);
    return res.status(500).json({ error: String(err) });
  }
});

// GET /api/ticket/check?code=...  - validate & mark QR ticket as scanned
app.get("/api/ticket/check", async (req, res) => {
  try {
    const { code } = req.query || {};
    if (!code) return res.status(400).json({ error: "missing code" });

    // lookup by ticketCode OR in ticketCodes array
    let doc = null;
    const snap = await db.collection("payments").where("ticketCode", "==", String(code)).limit(1).get();
    if (!snap.empty) doc = snap.docs[0];
    
    if (!doc) {
      const snap2 = await db.collection("payments").where("ticketCodes", "array-contains", String(code)).limit(1).get();
      if (!snap2.empty) doc = snap2.docs[0];
    }

    if (!doc) return res.status(404).json({ error: "ticket not found" });
    const data = doc.data();

    // prefer per-code scanned map; fall back to legacy scannedAt for single-ticket docs
    const key = encodeURIComponent(String(code));
    const scannedMap = data.scannedMap || {};
    const scannedEntry = scannedMap[key];
    const scanned = !!scannedEntry || !!data.scannedAt;
    const scannedAtRaw = scannedEntry || data.scannedAt || null;
    const scannedAt = scannedAtRaw && scannedAtRaw.toDate ? scannedAtRaw.toDate().toISOString() : scannedAtRaw;

    return res.json({ ok: true, found: true, scanned, scannedAt, user: data.user || null, ticketCode: data.ticketCode || code });
  } catch (err) {
    console.error("/api/ticket/check error", err);
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/ticket/check  - mark ticket as scanned (idempotent)
app.post("/api/ticket/check", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: "missing code" });

    // find by ticketCode or in ticketCodes array
    let doc = null;
    const snap = await db.collection("payments").where("ticketCode", "==", String(code)).limit(1).get();
    if (!snap.empty) doc = snap.docs[0];
    
    if (!doc) {
      const snap2 = await db.collection("payments").where("ticketCodes", "array-contains", String(code)).limit(1).get();
      if (!snap2.empty) doc = snap2.docs[0];
    }

    if (!doc) return res.status(404).json({ error: "ticket not found" });
    const data = doc.data();

    const key = encodeURIComponent(String(code));
    const scannedMap = data.scannedMap || {};
    // If this specific code is already scanned, return that info
    if (scannedMap && scannedMap[key]) {
      const existing = scannedMap[key];
      const existingAt = existing && existing.toDate ? existing.toDate().toISOString() : existing;
      return res.json({ ok: false, message: "already scanned", scannedAt: existingAt });
    }

    // mark only this code as scanned (idempotent per code)
    const updateData = {};
    updateData[`scannedMap.${key}`] = admin.firestore.FieldValue.serverTimestamp();
    // for backward compatibility with single-ticket records, also set scannedAt
    if (!data.ticketCodes || (Array.isArray(data.ticketCodes) && data.ticketCodes.length <= 1)) {
      updateData.scannedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await doc.ref.update(updateData);
    return res.json({ ok: true, message: "checked in", user: data.user || null, ticketCode: data.ticketCode || code });
  } catch (err) {
    console.error("POST /api/ticket/check error", err);
    return res.status(500).json({ error: String(err) });
  }
});

const port = process.env.PORT || 5000; // Railway will provide the port
app.listen(port, () => console.log(`Backend listening on port ${port}`));

// health endpoint
app.get("/health", (req, res) => {
  res.json({ ok: true, appsScriptConfigured: !!APPSCRIPT_URL });
});
