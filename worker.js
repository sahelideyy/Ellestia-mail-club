const PRICE_PAISE = 49900;
const EDITION = "January 2027 — The Underground Sky";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "ellestia-checkout", mode: "test" });
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
        return json({ error: "Checkout is not configured yet." }, 503);
      }
      return json({ keyId: env.RAZORPAY_KEY_ID, amount: PRICE_PAISE, currency: "INR", name: "Ellestia Mail Club", description: EDITION });
    }
    if (url.pathname === "/api/create-order" && request.method === "POST") {
      return createOrder(request, env);
    }
    if (url.pathname === "/api/verify-payment" && request.method === "POST") {
      return verifyPayment(request, env);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};

async function createOrder(request, env) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return json({ error: "Checkout is not configured." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const customer = {
    name: clean(body.name, 100),
    email: clean(body.email, 150).toLowerCase(),
    phone: clean(body.phone, 20),
    address: clean(body.address, 300),
    city: clean(body.city, 80),
    state: clean(body.state, 80),
    pincode: clean(body.pincode, 12)
  };
  if (!customer.name || !/^\S+@\S+\.\S+$/.test(customer.email) || !/^[0-9+()\- ]{8,20}$/.test(customer.phone) || !customer.address || !customer.city || !customer.state || !/^[0-9A-Za-z -]{4,12}$/.test(customer.pincode)) {
    return json({ error: "Please complete all delivery details with a valid email, phone and PIN code." }, 400);
  }
  const receipt = "emc_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const payload = {
    amount: PRICE_PAISE,
    currency: "INR",
    receipt,
    notes: { edition: EDITION, customer_name: customer.name, customer_email: customer.email, customer_phone: customer.phone, delivery_address: [customer.address, customer.city, customer.state, customer.pincode, "India"].join(", ") }
  };
  const response = await razorpayFetch("/orders", env, "POST", payload);
  if (!response.ok) return json({ error: "Razorpay could not create the order. Please try again." }, 502);
  const order = await response.json();
  return json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID });
}

async function verifyPayment(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const orderId = clean(body.razorpay_order_id, 80);
  const paymentId = clean(body.razorpay_payment_id, 80);
  const signature = clean(body.razorpay_signature, 200);
  if (!orderId || !paymentId || !signature || !env.RAZORPAY_KEY_SECRET) return json({ error: "Payment details are incomplete." }, 400);

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
  if (!constantTimeEqual(expected, signature)) return json({ error: "Payment signature could not be verified." }, 400);

  const paymentResponse = await razorpayFetch(`/payments/${encodeURIComponent(paymentId)}`, env, "GET");
  if (!paymentResponse.ok) return json({ error: "Could not confirm payment status. Please contact us before trying again." }, 502);
  const payment = await paymentResponse.json();
  if (payment.order_id !== orderId || payment.amount !== PRICE_PAISE || payment.currency !== "INR" || payment.status !== "captured") {
    return json({ error: "Payment is not confirmed as captured yet. Please contact us if money was deducted." }, 409);
  }
  return json({ ok: true, status: "captured", paymentId, orderId, amount: payment.amount, currency: payment.currency, message: "Your test payment was verified successfully." });
}

async function razorpayFetch(path, env, method, body) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  return fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function clean(value, max) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
