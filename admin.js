(() => {
  const cfg = window.KTOURS_CONFIG || {};
  const ready = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase?.createClient);
  const loginPanel = document.getElementById("loginPanel");
  const recoveryPanel = document.getElementById("recoveryPanel");
  const dashboardPanel = document.getElementById("dashboardPanel");
  const loginFeedback = document.getElementById("loginFeedback");
  const adminEmail = String(cfg.ADMIN_EMAIL || "").trim().toLowerCase();
  const adminUsername = String(cfg.ADMIN_USERNAME || "admin").trim().toLowerCase();
  const safe = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const feedback = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  let recoveryMode = false;

  const showLogin = message => {
    loginPanel.hidden = false;
    recoveryPanel.hidden = true;
    dashboardPanel.hidden = true;
    if (message) feedback("loginFeedback", message);
  };
  const showRecovery = () => {
    recoveryMode = true;
    loginPanel.hidden = true;
    dashboardPanel.hidden = true;
    recoveryPanel.hidden = false;
    document.getElementById("newAdminPassword")?.focus();
  };

  const usernameInput = document.getElementById("adminUsername");
  if (usernameInput) usernameInput.value = adminUsername;

  if (!ready) {
    showLogin("Supabase is not configured yet. Add the project URL and anon key in config.js, then run supabase/schema.sql.");
    document.getElementById("loginForm").addEventListener("submit", e => {
      e.preventDefault();
      feedback("loginFeedback", "Connect Supabase first. See README.md for setup steps.");
    });
    document.getElementById("forgotPassword").addEventListener("click", () => {
      feedback("loginFeedback", "Connect Supabase first. See README.md for setup steps.");
    });
    return;
  }

  if (!adminEmail || !adminUsername) {
    showLogin("Set ADMIN_USERNAME and ADMIN_EMAIL in config.js before using the dashboard.");
    return;
  }

  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const showDashboard = async session => {
    const email = session?.user?.email?.toLowerCase();
    if (!email || email !== adminEmail) {
      await db.auth.signOut();
      showLogin("This account is not the configured K-tours administrator.");
      return;
    }
    loginPanel.hidden = true;
    recoveryPanel.hidden = true;
    dashboardPanel.hidden = false;
    await Promise.all([loadReviews(), loadGallery()]);
  };

  const loadReviews = async () => {
    const wrap = document.getElementById("pendingReviews"); wrap.innerHTML = '<p class="admin-empty">Loading…</p>';
    const { data, error } = await db.from("reviews").select("id,name,country,rating,message,photo_urls,created_at,approved").eq("approved", false).order("created_at", { ascending:false });
    if (error) { wrap.innerHTML = `<p class="admin-empty">${safe(error.message)}</p>`; return; }
    document.getElementById("pendingCount").textContent = data.length;
    if (!data.length) { wrap.innerHTML = '<p class="admin-empty">No reviews are waiting for approval.</p>'; return; }
    wrap.innerHTML = data.map(row => `
      <article class="admin-review-card" data-id="${safe(row.id)}">
        <div><div class="admin-review-title"><strong>${safe(row.name)}</strong><span>${"★".repeat(row.rating)}${"☆".repeat(5-row.rating)}</span></div>
        <div class="admin-review-meta">${safe(row.country || "Country not supplied")} · ${new Date(row.created_at).toLocaleString()}</div>
        <p class="admin-review-text">${safe(row.message)}</p>
        ${(row.photo_urls || []).length ? `<div class="admin-review-photos">${row.photo_urls.map(url => `<a href="${safe(url)}" target="_blank" rel="noopener"><img src="${safe(url)}" alt="Review photo"></a>`).join("")}</div>` : ""}</div>
        <div class="admin-review-actions"><button class="approve" data-action="approve" data-id="${safe(row.id)}">Approve</button><button class="delete" data-action="delete-review" data-id="${safe(row.id)}">Delete</button></div>
      </article>`).join("");
  };

  const loadGallery = async () => {
    const wrap = document.getElementById("galleryItems"); wrap.innerHTML = '<p class="admin-empty">Loading…</p>';
    const { data, error } = await db.from("gallery").select("id,title,category,image_url,storage_path,sort_order").order("sort_order", { ascending:true });
    if (error) { wrap.innerHTML = `<p class="admin-empty">${safe(error.message)}</p>`; return; }
    if (!data.length) { wrap.innerHTML = '<p class="admin-empty">Your gallery is empty. Upload your first tour photograph above.</p>'; return; }
    wrap.innerHTML = data.map(row => `<article class="admin-gallery-card"><img src="${safe(row.image_url)}" alt="${safe(row.title)}"><strong>${safe(row.title)}</strong><small>${safe(row.category || "")}</small><button data-action="delete-gallery" data-id="${safe(row.id)}" data-path="${safe(row.storage_path || "")}">Remove photo</button></article>`).join("");
  };

  document.getElementById("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const username = document.getElementById("adminUsername").value.trim().toLowerCase();
    const password = document.getElementById("adminPassword").value;
    if (!username || !password) { feedback("loginFeedback", "Enter both username and password."); return; }
    if (username !== adminUsername) { feedback("loginFeedback", "Invalid username or password."); return; }
    const button = document.getElementById("loginButton"); button.disabled = true;
    feedback("loginFeedback", "Checking your credentials…");
    try {
      const { error } = await db.auth.signInWithPassword({ email: adminEmail, password });
      if (error) throw error;
    } catch (err) {
      // Keep the detailed Supabase response in the browser console and show a
      // useful, non-secret diagnostic in the page. Never log the password.
      const message = String(err?.message || "");
      const code = String(err?.code || "");
      console.error("K-tours admin sign-in failed", {
        code,
        message,
        status: err?.status
      });

      const lower = message.toLowerCase();
      if (code === "email_not_confirmed" || lower.includes("email not confirmed")) {
        feedback("loginFeedback", "This Supabase user exists but its email is not confirmed. Confirm the email in Supabase Authentication → Users, then try again.");
      } else if (code === "invalid_credentials" || lower.includes("invalid login credentials")) {
        feedback("loginFeedback", `Supabase rejected the email/password for ${adminEmail}. Check Authentication → Users: the exact email must exist and have this password set. The username is only mapped to this email.`);
      } else if (lower.includes("invalid api key") || lower.includes("apikey")) {
        feedback("loginFeedback", "Supabase rejected the public API key. Check SUPABASE_URL and SUPABASE_ANON_KEY in config.js against the same Supabase project.");
      } else if (lower.includes("failed to fetch") || lower.includes("network")) {
        feedback("loginFeedback", "Could not reach Supabase. Check the Project URL, network connection, and browser console.");
      } else {
        feedback("loginFeedback", `Supabase sign-in error: ${message || "Unknown error. Open the browser console for details."}`);
      }
    } finally { button.disabled = false; }
  });

  document.getElementById("forgotPassword").addEventListener("click", async () => {
    const button = document.getElementById("forgotPassword"); button.disabled = true;
    feedback("loginFeedback", "Requesting a password reset email…");
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await db.auth.resetPasswordForEmail(adminEmail, { redirectTo });
      if (error) throw error;
      feedback("loginFeedback", "If this administrator account exists, a password-reset email has been sent. Open it on this device to set a new password.");
    } catch (err) {
      feedback("loginFeedback", err.message || "Could not request a password reset. Check Supabase settings.");
    } finally { button.disabled = false; }
  });

  document.getElementById("recoveryForm").addEventListener("submit", async e => {
    e.preventDefault();
    const password = document.getElementById("newAdminPassword").value;
    const confirmation = document.getElementById("confirmAdminPassword").value;
    if (password.length < 8) { feedback("recoveryFeedback", "Use at least 8 characters."); return; }
    if (password !== confirmation) { feedback("recoveryFeedback", "The passwords do not match."); return; }
    const button = document.getElementById("savePasswordButton"); button.disabled = true;
    feedback("recoveryFeedback", "Saving your new password…");
    try {
      const { error } = await db.auth.updateUser({ password });
      if (error) throw error;
      recoveryMode = false;
      await db.auth.signOut();
      history.replaceState({}, document.title, window.location.pathname);
      document.getElementById("recoveryForm").reset();
      showLogin("Password updated successfully. Sign in with your username and new password.");
    } catch (err) {
      feedback("recoveryFeedback", err.message || "Could not update the password. Request a new reset email and try again.");
    } finally { button.disabled = false; }
  });

  document.getElementById("togglePassword").addEventListener("click", e => {
    const input = document.getElementById("adminPassword");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    e.currentTarget.textContent = visible ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(visible));
  });
  document.querySelectorAll("[data-toggle]").forEach(button => button.addEventListener("click", e => {
    const input = document.getElementById(e.currentTarget.dataset.toggle);
    const visible = input.type === "password"; input.type = visible ? "text" : "password";
    e.currentTarget.textContent = visible ? "Hide" : "Show";
  }));

  document.getElementById("signOut").addEventListener("click", async () => { await db.auth.signOut(); location.reload(); });
  document.getElementById("refreshReviews").addEventListener("click", loadReviews);
  document.querySelectorAll(".admin-tab").forEach(tab => tab.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.toggle("active", t === tab));
    document.getElementById("reviewsPanel").hidden = tab.dataset.tab !== "reviews";
    document.getElementById("galleryPanel").hidden = tab.dataset.tab !== "gallery";
  }));

  document.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-action]"); if (!btn) return;
    const id = btn.dataset.id; btn.disabled = true;
    try {
      if (btn.dataset.action === "approve") {
        const { error } = await db.from("reviews").update({ approved:true }).eq("id", id); if (error) throw error; await loadReviews();
      } else if (btn.dataset.action === "delete-review") {
        if (!confirm("Delete this guest review permanently?")) { btn.disabled = false; return; }
        const { error } = await db.from("reviews").delete().eq("id", id); if (error) throw error; await loadReviews();
      } else if (btn.dataset.action === "delete-gallery") {
        if (!confirm("Remove this photo from the website gallery?")) { btn.disabled = false; return; }
        const path = btn.dataset.path;
        const { error } = await db.from("gallery").delete().eq("id", id); if (error) throw error;
        if (path) await db.storage.from("gallery").remove([path]);
        await loadGallery();
      }
    } catch (err) { alert(err.message || "Could not complete that action."); btn.disabled = false; }
  });

  document.getElementById("galleryForm").addEventListener("submit", async e => {
    e.preventDefault();
    const title = document.getElementById("galleryTitle").value.trim();
    const category = document.getElementById("galleryCategory").value;
    const file = document.getElementById("galleryFile").files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) { feedback("galleryFeedback", "Please choose JPG, PNG or WebP up to 8 MB."); return; }
    const submit = e.currentTarget.querySelector("button[type=submit]"); submit.disabled = true; feedback("galleryFeedback", "Uploading photograph…");
    try {
      const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await db.storage.from("gallery").upload(path, file, { contentType:file.type, upsert:false });
      if (uploadError) throw uploadError;
      const { data } = db.storage.from("gallery").getPublicUrl(path);
      const { count } = await db.from("gallery").select("id", { count:"exact", head:true });
      const { error } = await db.from("gallery").insert([{ title, category, image_url:data.publicUrl, storage_path:path, visible:true, sort_order:count || 0 }]);
      if (error) throw error;
      e.currentTarget.reset(); feedback("galleryFeedback", "Photo added to the website gallery."); await loadGallery();
    } catch (err) { console.error(err); feedback("galleryFeedback", err.message || "Upload failed. Check storage policies."); }
    finally { submit.disabled = false; }
  });

  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      showRecovery();
      return;
    }
    if (event === "SIGNED_OUT") {
      recoveryMode = false;
      showLogin();
      return;
    }
    if (session && !recoveryMode) {
      // Defer Supabase reads until after the auth event callback completes.
      Promise.resolve().then(() => showDashboard(session));
    }
  });
})();
