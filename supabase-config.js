// WizzCards public storefront connection.
// This file contains only the Supabase project URL and publishable key.
// Never place a service_role or secret key in browser code.
const WIZZ_SUPABASE_URL = "https://vvrfjlsfhbivpbnweujk.supabase.co";
const WIZZ_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_yiZxbJsH2sOfctOYLlQo-w_C7JOAV_a";

async function loadWizzCatalog() {
  const headers = {
    apikey: WIZZ_SUPABASE_PUBLISHABLE_KEY,
    Authorization: "Bearer " + WIZZ_SUPABASE_PUBLISHABLE_KEY
  };
  try {
    const params = new URLSearchParams({
      select: "id,title,player_name,team_name,card_number,variant,serial_number,sale_price_clp,is_featured,description,categories(name),collections(name),card_images(storage_path,alt_text,display_order)",
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
      return rows.map(card => ({
        id: card.id,
        name: card.player_name || card.title || "Carta sin nombre",
        team: card.team_name || "",
        collection: card.collections?.name || "",
        category: card.categories?.name || "Otros",
        variant: card.variant || "Base",
        number: card.card_number || card.serial_number || "—",
        price: Number(card.sale_price_clp || 0),
        stock: null,
        featured: Boolean(card.is_featured),
        description: card.description || "",
        imageFront: null,
        imageBack: null
      }));
    }
    // Keep the current demo catalog visible until the real cards are migrated.
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
