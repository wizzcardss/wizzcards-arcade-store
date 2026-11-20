// WizzCards public storefront connection.
// This file contains only the Supabase project URL and publishable key.
// Never place a service_role or secret key in browser code.
const WIZZ_SUPABASE_URL = "https://vvrfjlsfhbivpbnweujk.supabase.co";
const WIZZ_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_yiZxbJsH2sOfctOYLlQo-w_C7JOAV_a";

function wizzPublicCardImage(storagePath) {
  if (!storagePath) return null;
  const safePath = storagePath.split("/").map(encodeURIComponent).join("/");
  return WIZZ_SUPABASE_URL + "/storage/v1/object/public/Card-photos/" + safePath;
}

async function loadWizzCatalog() {
  const headers = {
    apikey: WIZZ_SUPABASE_PUBLISHABLE_KEY,
    Authorization: "Bearer " + WIZZ_SUPABASE_PUBLISHABLE_KEY
  };
  try {
    const params = new URLSearchParams({
      select: "id,title,player_name,team_name,card_number,variant,serial_number,sale_price_clp,is_featured,description,categories(name),collections(name,brand),card_images(storage_path,alt_text,display_order),inventory(quantity_available)",
      is_published: "eq.true",
      order: "created_at.desc"
    });
    const response = await fetch(
      WIZZ_SUPABASE_URL + "/rest/v1/cards?" + params.toString(),
      { headers }
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error("Supabase respondió " + response.status + ": " + detail);
    }
    const rows = await response.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map(card => {
        const inventoryRow = Array.isArray(card.inventory) ? card.inventory[0] : card.inventory;
        const photos = (card.card_images || [])
          .slice()
          .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
          .map(photo => wizzPublicCardImage(photo.storage_path))
          .filter(Boolean);
        return {
          id: card.id,
          name: card.player_name || card.title || "Carta sin nombre",
          team: card.team_name || "",
          collection: card.collections?.name || "",
          category: card.collections?.brand || card.categories?.name || "Otros",
          variant: card.variant || "Base",
          number: card.card_number || card.serial_number || "—",
          price: Number(card.sale_price_clp || 0),
          stock: inventoryRow ? Math.max(0, Number(inventoryRow.quantity_available ?? 0)) : 0,
          featured: Boolean(card.is_featured),
          description: card.description || "",
          imageFront: photos[0] || null,
          imageBack: photos[1] || null
        };
      });
    }
    // Keep the current demo catalog visible until the real cards are published.
    return await fetch("catalog.json").then(response => {
      if (!response.ok) throw new Error("No se pudo cargar el catálogo de respaldo");
      return response.json();
    });
  } catch (error) {
    console.error("No se pudo consultar Supabase; se usa el catálogo de respaldo.", error);
    return await fetch("catalog.json").then(response => {
      if (!response.ok) throw error;
      return response.json();
    });
  }
}


// Always verify the live database stock before adding or submitting a cart.
// Missing inventory rows and cards outside the published database are treated as unavailable.
async function getWizzStockSnapshot(cardIds) {
  const ids = [...new Set((cardIds || []).map(String))];
  const result = Object.fromEntries(ids.map(id => [id, 0]));
  if (!ids.length) return result;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (ids.some(id => !uuid.test(id))) return result;
  const params = new URLSearchParams({
    select: "card_id,quantity_available,quantity_reserved,cards!inner(is_published)",
    card_id: "in.(" + ids.join(",") + ")",
    "cards.is_published": "eq.true"
  });
  const response = await fetch(WIZZ_SUPABASE_URL + "/rest/v1/inventory?" + params.toString(), {
    headers: {
      apikey: WIZZ_SUPABASE_PUBLISHABLE_KEY,
      Authorization: "Bearer " + WIZZ_SUPABASE_PUBLISHABLE_KEY
    },
    cache: "no-store"
  });
  if (!response.ok) throw new Error("No se pudo verificar el inventario (" + response.status + ")");
  const rows = await response.json();
  rows.forEach(row => {
    result[row.card_id] = Math.max(0, Number(row.quantity_available || 0));
  });
  return result;
}
