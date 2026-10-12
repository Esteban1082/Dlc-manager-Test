// StoreLine — admin-users
// Gestion des comptes depuis l'admin : invitation, renvoi d'accès, (dés)activation, création de magasin.
// La clé service_role reste ici, côté serveur — jamais dans les pages.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ROLES = ["superadmin", "admin", "manager", "employe"];
const MODULES = ["dlc", "pertes", "produits", "allergenes", "temperatures", "documents", "transferts", "commandes", "donnees"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (status: number, error: string) => json(status, { ok: false, error });

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cleanUrl = (u: unknown) => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin + url.pathname : null;
  } catch { return null; }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "Méthode non autorisée");

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  // ── Qui appelle ? ──
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(401, "Non connecté");
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return fail(401, "Session invalide, reconnecte-toi");
  const { data: me } = await admin.from("profiles").select("id, role, tenant_id, actif").eq("id", who.user.id).single();
  if (!me || me.actif === false) return fail(403, "Compte inactif");
  const isSuper = me.role === "superadmin";
  const isAdmin = me.role === "admin";
  if (!isSuper && !isAdmin) return fail(403, "Réservé aux administrateurs");

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { return fail(400, "Requête invalide"); }
  const action = String(body.action || "");
  const redirectTo = cleanUrl(body.redirect_to) || undefined;

  // Un admin ne gère que son magasin et ne crée que des managers/employés
  const canManage = (target: { role?: string; tenant_id?: string | null }) =>
    isSuper || (isAdmin && target.tenant_id === me.tenant_id && ["manager", "employe"].includes(target.role || "employe"));

  async function loadTarget(userId: string) {
    const { data } = await admin.from("profiles").select("id, email, role, tenant_id, actif").eq("id", userId).single();
    return data;
  }

  async function invite(opts: { email: string; nom?: string; role: string; tenant_id: string; modules?: string[]; blocs?: string[] }) {
    const email = opts.email.trim().toLowerCase();
    if (!emailOk(email)) throw new Error("Adresse e-mail invalide");
    if (!ROLES.includes(opts.role)) throw new Error("Rôle invalide");
    if (!canManage({ role: opts.role, tenant_id: opts.tenant_id })) throw new Error("Tu ne peux pas créer ce type de compte");
    const { data: tenant } = await admin.from("tenants").select("id, nom").eq("id", opts.tenant_id).single();
    if (!tenant) throw new Error("Magasin introuvable");

    const { data: inv, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { nom: opts.nom || "", tenant_nom: tenant.nom },
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) throw new Error("Un compte existe déjà avec cette adresse");
      throw new Error(error.message);
    }
    const uid = inv.user!.id;
    // Le trigger handle_new_user a créé le profil : on le complète
    const { error: pErr } = await admin.from("profiles")
      .upsert({ id: uid, email, nom: opts.nom || null, role: opts.role, tenant_id: opts.tenant_id, actif: true });
    if (pErr) throw new Error("Profil : " + pErr.message);

    const mods = (opts.modules || []).filter((m) => MODULES.includes(m));
    if (mods.length) {
      await admin.from("permissions").insert(mods.map((m) => ({ user_id: uid, module: m, actif: true })));
    }
    const blocs = (opts.blocs || []).filter(Boolean);
    if (blocs.length) {
      const { data: okBlocs } = await admin.from("dlc_blocs").select("id").in("id", blocs).eq("tenant_id", opts.tenant_id);
      if (okBlocs?.length) await admin.from("dlc_blocs_users").insert(okBlocs.map((b) => ({ user_id: uid, bloc_id: b.id })));
    }
    return uid;
  }

  try {
    switch (action) {
      // ── Inviter un utilisateur ──
      case "invite": {
        const tenant_id = isSuper ? (body.tenant_id || me.tenant_id) : me.tenant_id;
        const uid = await invite({ email: String(body.email || ""), nom: body.nom, role: String(body.role || "employe"), tenant_id, modules: body.modules, blocs: body.blocs });
        return json(200, { ok: true, user_id: uid });
      }

      // ── Renvoyer un lien d'accès (invitation si jamais connecté, sinon réinitialisation) ──
      case "send_access": {
        const target = await loadTarget(String(body.user_id || ""));
        if (!target) return fail(404, "Utilisateur introuvable");
        if (!canManage(target)) return fail(403, "Pas autorisé sur ce compte");
        const { data: au } = await admin.auth.admin.getUserById(target.id);
        if (!au?.user) return fail(404, "Compte introuvable");
        if (!au.user.last_sign_in_at) {
          const { error } = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo });
          if (error && !/already/i.test(error.message)) throw new Error(error.message);
          if (!error) return json(200, { ok: true, sent: "invite" });
        }
        const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
        const { error } = await anon.auth.resetPasswordForEmail(target.email, { redirectTo });
        if (error) throw new Error(error.message);
        return json(200, { ok: true, sent: "recovery" });
      }

      // ── Activer / désactiver (bloque aussi la connexion Google/Microsoft) ──
      case "set_active": {
        const target = await loadTarget(String(body.user_id || ""));
        if (!target) return fail(404, "Utilisateur introuvable");
        if (target.id === me.id) return fail(400, "Tu ne peux pas te désactiver toi-même");
        if (!canManage(target)) return fail(403, "Pas autorisé sur ce compte");
        const actif = !!body.actif;
        const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: actif ? "none" : "876000h" });
        if (error) throw new Error(error.message);
        await admin.from("profiles").update({ actif }).eq("id", target.id);
        return json(200, { ok: true, actif });
      }

      // ── Changer le rôle ──
      case "set_role": {
        const target = await loadTarget(String(body.user_id || ""));
        const role = String(body.role || "");
        if (!target) return fail(404, "Utilisateur introuvable");
        if (!ROLES.includes(role)) return fail(400, "Rôle invalide");
        if (target.id === me.id) return fail(400, "Tu ne peux pas changer ton propre rôle");
        if (!canManage(target) || !canManage({ role, tenant_id: target.tenant_id })) return fail(403, "Pas autorisé");
        await admin.from("profiles").update({ role }).eq("id", target.id);
        return json(200, { ok: true, role });
      }

      // ── Créer un magasin + son premier admin (superadmin) ──
      case "create_tenant": {
        if (!isSuper) return fail(403, "Réservé au superadmin");
        const nom = String(body.nom || "").trim();
        const slug = String(body.slug || nom).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!nom || !slug) return fail(400, "Nom du magasin obligatoire");
        const accent = /^#[0-9a-f]{6}$/i.test(String(body.accent || "")) ? body.accent : "#e8a045";
        const { data: t, error: tErr } = await admin.from("tenants").insert({ nom, slug, theme_accent: accent, actif: true }).select("id").single();
        if (tErr) return fail(400, /duplicate|unique/i.test(tErr.message) ? "Cet identifiant de magasin existe déjà" : tErr.message);

        // Rayons et zones par défaut
        const rayons = Array.isArray(body.rayons) ? body.rayons : ["Boulangerie", "Traiteur", "Boucherie", "Fruits & légumes"];
        const zones = Array.isArray(body.zones) ? body.zones : [
          { nom: "Vitrine réfrigérée", min: 0, max: 4 }, { nom: "Chambre froide", min: 0, max: 3 }, { nom: "Congélateur", min: -25, max: -18 }];
        if (rayons.length) await admin.from("rayons").insert(rayons.map((r: string, i: number) => ({ tenant_id: t.id, nom: String(r), actif: true, ordre: i })));
        if (zones.length) await admin.from("zones").insert(zones.map((z: any, i: number) => ({ tenant_id: t.id, nom: String(z.nom), temp_min: Number(z.min), temp_max: Number(z.max), actif: true, ordre: i })));

        let admin_id: string | null = null;
        if (body.admin_email) {
          admin_id = await invite({ email: String(body.admin_email), nom: body.admin_nom, role: "admin", tenant_id: t.id });
        }
        return json(200, { ok: true, tenant_id: t.id, admin_id });
      }

      default:
        return fail(400, "Action inconnue");
    }
  } catch (e) {
    return fail(400, (e as Error).message || "Erreur");
  }
});
