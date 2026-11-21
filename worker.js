const PRICE_PAISE = 49900;
const EDITION = "January 2027 — The Verona Edition";
const BUSINESS_EMAIL = "sahelideybusiness@gmail.com";
const SUPPORT_EMAIL = "ellestia.co@gmail.com";
const BRAND = "Ellestia Mail Club";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "ellestia-checkout",
        mode: env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "live" : "test",
      });
    }
    if (url.pathname === "/api/diagnostics" && request.method === "GET") {
  return json({
    keyIdPresent: !!env.RAZORPAY_KEY_ID,
    keySecretPresent: !!env.RAZORPAY_KEY_SECRET,
    databaseBindingPresent: !!env.DB,
    resendKeyPresent: !!env.RESEND_API_KEY,
    emailFromPresent: !!env.EMAIL_FROM,
  });
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      if (!configured(env))
        return json({ error: "Checkout is not configured yet." }, 503);
      return json({
        keyId: env.RAZORPAY_KEY_ID,
        amount: PRICE_PAISE,
        currency: "INR",
        name: BRAND,
        description: EDITION,
      });
    }
    if (url.pathname === "/api/create-order" && request.method === "POST")
      return createOrder(request, env);
    if (url.pathname === "/api/verify-payment" && request.method === "POST")
      return verifyPayment(request, env);
    if (url.pathname === "/api/razorpay-webhook" && request.method === "POST")
      return razorpayWebhook(request, env);
    if (url.pathname.startsWith("/api/"))
      return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};

function configured(env) {
  return !!(
    env.RAZORPAY_KEY_ID &&
    env.RAZORPAY_KEY_SECRET &&
    env.DB
  );
}

async function createOrder(request, env) {
  if (!configured(env))
    return json(
      { error: "Checkout setup is incomplete. Please contact us." },
      503
    );
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const customer = {
    name: clean(body.name, 100),
    email: clean(body.email, 150).toLowerCase(),
    phone: clean(body.phone, 24),
    address: clean(body.address, 300),
    city: clean(body.city, 80),
    state: clean(body.state, 80),
    pincode: clean(body.pincode, 12),
  };
  const phone = normalizePhone(customer.phone);
  if (
    !customer.name ||
    !/^\S+@\S+\.\S+$/.test(customer.email) ||
    !phone ||
    !customer.address ||
    !customer.city ||
    !customer.state ||
    !/^[0-9A-Za-z -]{4,12}$/.test(customer.pincode)
  ) {
    return json(
      {
        error:
          "Please complete all delivery details with a valid email, phone and PIN code.",
      },
      400
    );
  }
  const orderCode = `EMC-${new Date() .toISOString() .slice(0, 7) .replace("-", "")}-${crypto .randomUUID() .replaceAll("-", "") .slice(0, 8) .toUpperCase()}`;
  const payload = {
    amount: PRICE_PAISE,
    currency: "INR",
    receipt: orderCode,
    notes: {
      edition: EDITION,
      order_code: orderCode,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone,
    },
  };
  let response;
  try {
    response = await razorpayFetch("/orders", env, "POST", payload);
  } catch {
    return json(
      { error: "Could not reach the payment provider. Please try again." },
      502
    );
  }
  if (!response.ok)
    return json(
      { error: "Razorpay could not create the order. Please try again." },
      502
    );
  const razorOrder = await response.json();
  const address = [
    customer.address,
    customer.city,
    customer.state,
    customer.pincode,
    "India",
  ].join(", ");
  try {
    await env.DB.prepare(
      `INSERT INTO orders (order_code, edition, amount_paise, currency, customer_name, customer_email, customer_phone, phone_normalized, delivery_address, city, state, pincode, razorpay_order_id, payment_status) VALUES (?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')`
    )
      .bind(
        orderCode,
        EDITION,
        PRICE_PAISE,
        customer.name,
        customer.email,
        customer.phone,
        phone,
        address,
        customer.city,
        customer.state,
        customer.pincode,
        razorOrder.id
      )
      .run();
  } catch {
    return json(
      {
        error:
          "Your order could not be safely recorded. Please contact support before attempting payment again.",
      },
      503
    );
  }
  return json({
    orderId: razorOrder.id,
    orderCode,
    amount: razorOrder.amount,
    currency: razorOrder.currency,
    keyId: env.RAZORPAY_KEY_ID,
  });
}

async function verifyPayment(request, env) {
  if (!configured(env))
    return json({ error: "Checkout setup is incomplete." }, 503);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const orderId = clean(body.razorpay_order_id, 80),
    paymentId = clean(body.razorpay_payment_id, 80),
    signature = clean(body.razorpay_signature, 200);
  if (!orderId || !paymentId || !signature)
    return json({ error: "Payment details are incomplete." }, 400);
  const expected = await hmacHex(
    env.RAZORPAY_KEY_SECRET,
    `${orderId}|${paymentId}`
  );
  if (!constantTimeEqual(expected, signature))
    return json({ error: "Payment signature could not be verified." }, 400);
  const pRes = await razorpayFetch(
    `/payments/${encodeURIComponent(paymentId)}`,
    env,
    "GET"
  );
  if (!pRes.ok)
    return json(
      {
        error:
          "Could not confirm payment. Please contact support before paying again.",
      },
      502
    );
  const payment = await pRes.json();
  if (
    payment.order_id !== orderId ||
    payment.amount !== PRICE_PAISE ||
    payment.currency !== "INR" ||
    payment.status !== "captured"
  )
    return json(
      {
        error:
          "Payment is not confirmed as captured. If money was deducted, contact support.",
      },
      409
    );
  const result = await finalizePaidOrder(orderId, paymentId, env);
  if (!result.ok) return json({ error: result.error }, 409);
  return json({
    ok: true,
    status: "captured",
    orderId: result.order.order_code,
    subscriberId: result.subscriberCode,
    identityReview: result.identityReview,
    message: "Your payment is confirmed. A confirmation email will follow.",
  });
}

async function razorpayWebhook(request, env) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !env.DB)
    return json({ error: "Webhook is not configured." }, 503);
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!constantTimeEqual(expected, signature))
    return json({ error: "Invalid webhook signature." }, 400);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid webhook payload." }, 400);
  }
  if (event.event === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (
      payment?.order_id &&
      payment?.id &&
      payment.amount === PRICE_PAISE &&
      payment.currency === "INR"
    ) {
      await finalizePaidOrder(payment.order_id, payment.id, env);
    }
  }
  return json({ received: true });
}

async function finalizePaidOrder(razorOrderId, paymentId, env) {
  const found = await env.DB.prepare(
    "SELECT * FROM orders WHERE razorpay_order_id = ?"
  )
    .bind(razorOrderId)
    .first();
  if (!found)
    return {
      ok: false,
      error: "The order record was not found. Please contact support.",
    };
  if (
    found.payment_status === "paid" &&
    found.razorpay_payment_id === paymentId
  ) {
    await sendOrderEmails(
      found,
      found.subscriber_id
        ? await env.DB.prepare(
            "SELECT subscriber_code FROM subscribers WHERE id = ?"
          )
            .bind(found.subscriber_id)
            .first()
        : null,
      env
    );
    const sub = found.subscriber_id
      ? await env.DB.prepare(
          "SELECT subscriber_code FROM subscribers WHERE id = ?"
        )
          .bind(found.subscriber_id)
          .first()
      : null;
    await syncSubscriberToSheet(found, sub, env);
    return {
      ok: true,
      order: found,
      subscriberCode: sub?.subscriber_code || "Pending review",
      identityReview: !!found.identity_review_required,
    };
  }
  const emailMatch = await env.DB.prepare(
    "SELECT * FROM subscribers WHERE email = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(found.customer_email)
    .first();
  let subscriber = await env.DB.prepare(
    "SELECT * FROM subscribers WHERE phone_normalized = ?"
  )
    .bind(found.phone_normalized)
    .first();
  let reviewReason = null;
  if (
    subscriber &&
    subscriber.email.toLowerCase() !== found.customer_email.toLowerCase()
  )
    reviewReason = "Same phone number submitted with a different email address";
  else if (!subscriber && emailMatch)
    reviewReason = "Email address already belongs to a different phone number";
  if (!subscriber && !reviewReason) {
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO subscribers (phone_normalized, phone_display, email, full_name) VALUES (?, ?, ?, ?)"
    )
      .bind(
        found.phone_normalized,
        found.customer_phone,
        found.customer_email,
        found.customer_name
      )
      .run();
    subscriber = await env.DB.prepare(
      "SELECT * FROM subscribers WHERE phone_normalized = ?"
    )
      .bind(found.phone_normalized)
      .first();
    if (!subscriber && inserted.success)
      return {
        ok: false,
        error:
          "Could not create the subscriber record. Please contact support.",
      };
  }
  if (subscriber) {
    await env.DB.prepare(
      "UPDATE subscribers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(subscriber.id)
      .run();
    if (!subscriber.subscriber_code) {
      const code = `EMC${String(subscriber.id).padStart(6, "0")}`;
      await env.DB.prepare(
        "UPDATE subscribers SET subscriber_code = ? WHERE id = ? AND subscriber_code IS NULL"
      )
        .bind(code, subscriber.id)
        .run();
      subscriber.subscriber_code = code;
    }
  }
  const orderCode = found.order_code;
  await env.DB.prepare(
    `UPDATE orders SET payment_status = 'paid', razorpay_payment_id = ?, subscriber_id = ?, identity_review_required = ?, identity_review_reason = ?, paid_at = COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE razorpay_order_id = ?`
  )
    .bind(
      paymentId,
      subscriber?.id || null,
      reviewReason ? 1 : 0,
      reviewReason,
      razorOrderId
    )
    .run();
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE razorpay_order_id = ?"
  )
    .bind(razorOrderId)
    .first();
  if (subscriber)
    subscriber = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?")
      .bind(subscriber.id)
      .first();
  await sendOrderEmails(order, subscriber, env);
  await syncSubscriberToSheet(order, subscriber, env);
  return {
    ok: true,
    order,
    subscriberCode: subscriber?.subscriber_code || "Pending review",
    identityReview: !!reviewReason,
  };
}

async function sendOrderEmails(order, subscriber, env) {
  if (!order) return;
  const customerSent = !!order.customer_email_sent_at;
  const businessSent = !!order.business_email_sent_at;
  const subscriberCode =
    subscriber?.subscriber_code || "Pending manual identity review";
  if (!customerSent) {
    const html = `<p>Hello ${escapeHtml( order.customer_name )},</p><p>Your payment for <strong>${escapeHtml( order.edition )}</strong> is confirmed. Thank you for joining ${BRAND}.</p><p><strong>Order ID:</strong> ${escapeHtml( order.order_code )}<br><strong>Subscriber ID:</strong> ${escapeHtml( subscriberCode )}<br><strong>Amount:</strong> ₹499</p><p><strong>Delivery address:</strong><br>${escapeHtml( order.delivery_address )}</p><p>Your edition will be dispatched according to the published schedule. Questions? ${SUPPORT_EMAIL}</p><p>With wonder,<br>${BRAND}</p>`;
    const sent = await sendEmail(env, {
      to: order.customer_email,
      subject: `Your Ellestia order is confirmed · ${order.order_code}`,
      html,
    });
    if (sent)
      await env.DB.prepare(
        "UPDATE orders SET customer_email_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      )
        .bind(order.id)
        .run();
  }
  if (!businessSent) {
    const html = `<h2>New paid Ellestia order</h2><p><strong>Order ID:</strong> ${escapeHtml( order.order_code )}<br><strong>Subscriber ID:</strong> ${escapeHtml( subscriberCode )}<br><strong>Edition:</strong> ${escapeHtml( order.edition )}<br><strong>Amount:</strong> ₹499</p><p><strong>Customer:</strong> ${escapeHtml( order.customer_name )}<br><strong>Email:</strong> ${escapeHtml( order.customer_email )}<br><strong>Phone:</strong> ${escapeHtml( order.customer_phone )}</p><p><strong>Delivery address:</strong><br>${escapeHtml( order.delivery_address )}</p>${ order.identity_review_required ? `<p><strong>MANUAL REVIEW REQUIRED:</strong> ${escapeHtml( order.identity_review_reason || "Identity conflict" )}</p>` : "" }`;
    const sent = await sendEmail(env, {
      to: BUSINESS_EMAIL,
      subject: `New paid order · ${order.order_code}`,
      html,
    });
    if (sent)
      await env.DB.prepare(
        "UPDATE orders SET business_email_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      )
        .bind(order.id)
        .run();
  }
}

async function sendEmail(env, message) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "Ellestia Mail Club <orders@ellestia.co>",
        to: [message.to],
        subject: message.subject,
        html: message.html,
        reply_to: SUPPORT_EMAIL,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function razorpayFetch(path, env, method, body) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  return fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
async function syncSubscriberToSheet(order, subscriber, env) {
  if (
    !env.GOOGLE_SHEET_SYNC_URL ||
    !env.GOOGLE_SHEET_SYNC_SECRET ||
    !subscriber ||
    !subscriber.subscriber_code
  ) return false;

  try {
    const response = await fetch(env.GOOGLE_SHEET_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.GOOGLE_SHEET_SYNC_SECRET,
        subscriberId: subscriber.subscriber_code,
        name: order.customer_name,
        email: order.customer_email,
        phone: order.customer_phone,
        address: order.delivery_address,
        edition: order.edition,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
