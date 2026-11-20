import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const allowedOrigins = new Set(["https://wizzcardss.github.io"]);
const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://wizzcardss.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const json = (body: unknown, status = 200, origin: string | null = null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[ch]!));

const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(b => b.toString(16).padStart(2, "0")).join("");


Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405, origin);
  if (origin && !allowedOrigins.has(origin)) return json({ error: "Origen no autorizado." }, 403, origin);

  try {
    const body = await req.json();
    if (typeof body.website === "string" && body.website.trim()) return json({ success: true }, 200, origin);

    const firstName = String(body.firstName || "").trim().slice(0, 80);
    const lastName = String(body.lastName || "").trim().slice(0, 80);
    const phone = String(body.phone || "").trim().slice(0, 40);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    const city = String(body.city || "").trim().slice(0, 120);
    const notes = String(body.notes || "").trim().slice(0, 1500);
    const items = Array.isArray(body.items) ? body.items : [];

    if (!firstName || !lastName || !phone || !validEmail(email)) {
      return json({ error: "Completa nombre, apellido, teléfono y un correo electrónico válido." }, 400, origin);
    }
    if (!items.length || items.length > 30) return json({ error: "El carrito está vacío o contiene demasiadas cartas." }, 400, origin);

    const normalized = new Map<string, number>();
    for (const item of items) {
      const id = String(item.id || "");
      const quantity = Number(item.quantity);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
          !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
        return json({ error: "Hay una carta o cantidad inválida en el carrito." }, 400, origin);
      }
      normalized.set(id, (normalized.get(id) || 0) + quantity);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailAppPassword = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!supabaseUrl || !serviceKey) return json({ error: "Falta configurar el acceso seguro al inventario en el servidor." }, 503, origin);
    if (!gmailUser || !gmailAppPassword) {
      return json({ error: "El formulario está listo, pero falta configurar el remitente Gmail en Supabase para activar los correos." }, 503, origin);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const { data: allowed, error: rateError } = await admin.rpc("consume_wizz_order_email_rate_limit", {
      p_ip_hash: await sha256(ip), p_limit: 5, p_window_minutes: 15,
    });
    if (rateError) {
      console.error("Rate limit check failed", rateError.message);
      return json({ error: "No pudimos procesar la solicitud en este momento." }, 503, origin);
    }
    if (!allowed) return json({ error: "Has enviado varias solicitudes recientemente. Espera 15 minutos e inténtalo nuevamente." }, 429, origin);
    const ids = [...normalized.keys()];
    const { data: cards, error: cardsError } = await admin
      .from("cards")
      .select("id,title,player_name,team_name,card_number,variant,sale_price_clp,inventory(quantity_available)")
      .eq("is_published", true)
      .in("id", ids);
    if (cardsError) {
      console.error("Inventory lookup failed", cardsError.message);
      return json({ error: "No pudimos verificar el inventario. Intenta nuevamente." }, 503, origin);
    }

    const cardMap = new Map((cards || []).map((card: any) => [card.id, card]));
    const orderLines: Array<{ name: string; id: string; quantity: number; unitPrice: number; lineTotal: number }> = [];
    for (const [id, quantity] of normalized.entries()) {
      const card: any = cardMap.get(id);
      if (!card) return json({ error: "Una de las cartas ya no está publicada o no existe. Actualiza el catálogo." }, 409, origin);
      const inv = Array.isArray(card.inventory) ? card.inventory[0] : card.inventory;
      const available = Math.max(0, Number(inv?.quantity_available || 0));
      if (quantity > available) {
        return json({ error: (card.player_name || card.title || "Una carta") + " tiene solo " + available + " unidad(es) disponible(s). Actualiza tu carrito." }, 409, origin);
      }
      const unitPrice = Math.max(0, Number(card.sale_price_clp || 0));
      const name = [card.player_name || card.title || "Carta", card.team_name, card.variant, card.card_number ? "#" + card.card_number : ""].filter(Boolean).join(" · ");
      orderLines.push({ name, id, quantity, unitPrice, lineTotal: unitPrice * quantity });
    }

    const total = orderLines.reduce((sum, line) => sum + line.lineTotal, 0);
    const fullName = firstName + " " + lastName;
    const lineText = orderLines.map((line) =>
      line.quantity + " x " + line.name + " (" + line.id + ") — " +
      new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(line.unitPrice) +
      " c/u = " +
      new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(line.lineTotal)
    ).join("\n");
    const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailAppPassword.replace(/\s/g, "") },
      connectionTimeout: 12000,
      greetingTimeout: 12000,
      socketTimeout: 20000,
    });

    const adminHtml = `
      <h2>Nueva solicitud de pedido — WizzCards</h2>
      <p><b>Cliente:</b> ${escapeHtml(fullName)}</p>
      <p><b>Teléfono:</b> ${escapeHtml(phone)}</p>
      <p><b>Correo:</b> ${escapeHtml(email)}</p>
      <p><b>Comuna / ciudad:</b> ${escapeHtml(city || "No indicada")}</p>
      <h3>Cartas solicitadas</h3>
      <ul>${orderLines.map((line) => `<li>${line.quantity} × ${escapeHtml(line.name)} — ${money.format(line.unitPrice)} c/u — Subtotal: ${money.format(line.lineTotal)} <small>(${escapeHtml(line.id)})</small></li>`).join("")}</ul>
      <h3>Total solicitado: ${money.format(total)}</h3>
      <p><b>Comentarios:</b><br>${escapeHtml(notes || "Sin comentarios").replace(/\n/g, "<br>")}</p>
      <hr><p>Solicitud recibida. No implica pago, reserva ni aprobación de la compra. Confirmar disponibilidad, entrega y pago manualmente.</p>`;
    const customerHtml = `
      <h2>¡Recibimos tu solicitud en WizzCards!</h2>
      <p>Hola ${escapeHtml(firstName)}, recibimos correctamente tu solicitud de pedido.</p>
      <h3>Resumen</h3>
      <ul>${orderLines.map((line) => `<li>${line.quantity} × ${escapeHtml(line.name)} — ${money.format(line.lineTotal)}</li>`).join("")}</ul>
      <p><b>Total solicitado: ${money.format(total)}</b></p>
      <p>Este correo confirma la recepción de tu solicitud, pero no significa que la compra esté aprobada, que el stock esté reservado ni que se haya realizado un pago. WizzCards te contactará para confirmar disponibilidad, entrega y forma de pago.</p>
      <p>¡Gracias por buscar lo raro con WizzCards!<br><b>Hunt The Rare</b></p>`;

    await transporter.sendMail({
      from: { name: "WizzCards", address: gmailUser },
      to: "Wizzcardss@gmail.com",
      replyTo: { name: fullName, address: email },
      subject: "Nueva solicitud WizzCards — " + fullName,
      text: "Nueva solicitud WizzCards\nCliente: " + fullName + "\nTeléfono: " + phone + "\nCorreo: " + email + "\nComuna: " + city + "\n\n" + lineText + "\n\nTOTAL: " + money.format(total) + "\nComentarios: " + notes + "\n\nPendiente de confirmación manual.",
      html: adminHtml,
    });
    await transporter.sendMail({
      from: { name: "WizzCards", address: gmailUser },
      to: email,
      replyTo: { name: "WizzCards", address: "Wizzcardss@gmail.com" },
      subject: "Recibimos tu solicitud — WizzCards",
      text: "Hola " + firstName + ", recibimos tu solicitud.\n\n" + lineText + "\n\nTotal solicitado: " + money.format(total) + "\n\nEste correo confirma solo la recepción. No significa que la compra esté aprobada, que el stock esté reservado ni que se haya realizado un pago. Te contactaremos para confirmar disponibilidad, entrega y forma de pago.\n\nWizzCards — Hunt The Rare.",
      html: customerHtml,
    });

    return json({ success: true, message: "Solicitud enviada. Revisa tu correo para ver la confirmación." }, 200, origin);
  } catch (error) {
    console.error("Order email error", error);
    return json({ error: "No pudimos enviar los correos. Tu solicitud no se ha confirmado; intenta nuevamente." }, 500, origin);
  }
});
