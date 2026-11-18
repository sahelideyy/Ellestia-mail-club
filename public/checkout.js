(() => {
  const section = document.querySelector(".subscribe");
  if (!section) return;
  const oldButton = section.querySelector(".btn");
  if (!oldButton) return;
  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.textContent = "Join the Mail Club · ₹499";
  button.style.cursor = "pointer";
  oldButton.replaceWith(button);
  const style = document.createElement("style");
  style.textContent = `#ellestia-order-form{display:none;max-width:520px;margin:24px auto 0;padding:22px;background:#fffaf0;color:#352821;border:1px solid #d9cbb7;text-align:left}#ellestia-order-form.open{display:block}#ellestia-order-form h3{margin:0 0 14px;text-align:center;font:24px 'Special Elite',serif;color:#6b1f32}#ellestia-order-form label{display:block;margin:10px 0 4px;font-size:11px;color:#6b1f32}#ellestia-order-form input,#ellestia-order-form textarea{width:100%;padding:11px;border:1px solid #d9cbb7;background:#fffdf8;color:#352821;font:14px 'Courier Prime',monospace;border-radius:0}#ellestia-order-form textarea{min-height:68px;resize:vertical}#ellestia-order-form .checkout-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:16px}#ellestia-order-form .checkout-status{min-height:22px;margin:12px 0 0;color:#6b1f32;font-size:12px;text-align:center}#ellestia-order-form .checkout-cancel{background:transparent;color:#6b1f32;border:1px solid #6b1f32}#ellestia-order-form .checkout-receipt{display:none;margin:16px 0 0;padding:14px;border:1px dashed #aa8754;background:#f8f2e7;color:#352821;font-size:12px;line-height:1.8;text-align:left}#ellestia-order-form .checkout-receipt.visible{display:block}`;
  document.head.appendChild(style);
  const form = document.createElement("form");
  form.id = "ellestia-order-form";
  form.innerHTML = `<h3>Your first letter awaits</h3><label for="emc-name">Full name</label><input id="emc-name" name="name" autocomplete="name" required maxlength="100"><label for="emc-email">Email address</label><input id="emc-email" name="email" type="email" autocomplete="email" required maxlength="150"><label for="emc-phone">Phone number</label><input id="emc-phone" name="phone" type="tel" autocomplete="tel" required maxlength="24"><label for="emc-address">Delivery address</label><textarea id="emc-address" name="address" autocomplete="street-address" required maxlength="300"></textarea><label for="emc-city">City</label><input id="emc-city" name="city" autocomplete="address-level2" required maxlength="80"><label for="emc-state">State</label><input id="emc-state" name="state" autocomplete="address-level1" required maxlength="80"><label for="emc-pincode">PIN code</label><input id="emc-pincode" name="pincode" inputmode="numeric" autocomplete="postal-code" required maxlength="12"><div class="checkout-actions"><button class="btn" id="emc-pay" type="submit">Continue to secure payment · ₹499</button><button class="btn checkout-cancel" id="emc-cancel" type="button">Cancel</button></div><p class="checkout-status" id="emc-status" role="status" aria-live="polite"></p><div class="checkout-receipt" id="emc-receipt"></div>`;
  section.querySelector(".price").insertAdjacentElement("afterend", form);
  const status = form.querySelector("#emc-status"),
    payButton = form.querySelector("#emc-pay"),
    receipt = form.querySelector("#emc-receipt");
  button.addEventListener("click", () => {
    form.classList.add("open");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  form.querySelector("#emc-cancel").addEventListener("click", () => {
    form.classList.remove("open");
    status.textContent = "";
  });
  function loadCheckout() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = resolve;
      script.onerror = () =>
        reject(new Error("Could not load secure checkout. Please try again."));
      document.head.appendChild(script);
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    payButton.disabled = true;
    status.textContent = "Preparing your secure checkout…";
    receipt.classList.remove("visible");
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      const orderResponse = await fetch("/api/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const order = await orderResponse.json();
      if (!orderResponse.ok)
        throw new Error(order.error || "Could not start checkout.");
      await loadCheckout();
      const checkout = new Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: "Ellestia Mail Club",
        description: "The Underground Sky · January Edition",
        order_id: order.orderId,
        prefill: {
          name: values.name,
          email: values.email,
          contact: values.phone,
        },
        notes: { edition: "The Underground Sky" },
        theme: { color: "#6b1f32" },
        handler: async (response) => {
          status.textContent = "Verifying your payment securely…";
          try {
            const res = await fetch("/api/verify-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            const result = await res.json();
            if (!res.ok || !result.ok)
              throw new Error(result.error || "Payment is not confirmed yet.");
            status.textContent = "Payment confirmed. Thank you for joining us!";
            receipt.innerHTML = `<strong>Keep these details safe</strong><br>Order ID: ${escapeText(
              result.orderId
            )}<br>Subscriber ID: ${escapeText(result.subscriberId)}${
              result.identityReview
                ? "<br><strong>We will verify your subscriber details manually.</strong>"
                : ""
            }<br>A confirmation email will follow.`;
            receipt.classList.add("visible");
            form.reset();
          } catch (error) {
            status.textContent =
              error.message +
              " If money was deducted, contact ellestia.co@gmail.com before paying again.";
          } finally {
            payButton.disabled = false;
          }
        },
        modal: {
          ondismiss: () => {
            status.textContent =
              "Checkout closed. No payment confirmation has been recorded.";
            payButton.disabled = false;
          },
        },
      });
      checkout.on("payment.failed", (response) => {
        status.textContent =
          response.error?.description || "Payment failed. You can try again.";
        payButton.disabled = false;
      });
      checkout.open();
      status.textContent = "";
    } catch (error) {
      status.textContent =
        error.message || "Something went wrong. Please try again.";
      payButton.disabled = false;
    }
  });
  function escapeText(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;", "'": "&#39;", }[c]) ); } })();} })();
