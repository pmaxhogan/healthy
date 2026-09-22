<script setup lang="ts">
// The layout: masthead, nav, the routed page, and the toast stack.
//
// The session probe runs here rather than in each view. If the password session
// or the Cloudflare Access cookie has expired, `GET /api/whoami` answers 401
// with `x-healthy-auth: required` and the API client navigates the whole page to
// the server-rendered login wall -- so holding the first paint until the probe
// resolves means the owner never sees a dashboard skeleton flash before the
// redirect takes it away.

import { onMounted, ref } from "vue";

import { isAuthRequired } from "./api/client.ts";
import { endpoints, logout } from "./api/endpoints.ts";
import ToastStack from "./components/ToastStack.vue";
import { toastError } from "./lib/toasts.ts";
import { NAV } from "./router.ts";

const ready = ref(false);
const loggingOut = ref(false);

onMounted(() => {
  void (async () => {
    try {
      await endpoints.whoami();
    } catch (error) {
      // A navigation is already under way; leaving `ready` false keeps the page
      // blank until it lands.
      if (isAuthRequired(error)) return;
      // Anything else (the Worker is down, say) should not lock the owner out of
      // a UI that can at least show them the failure.
      toastError("Could not confirm the session.");
    }
    ready.value = true;
  })();
});

async function signOut(): Promise<void> {
  loggingOut.value = true;
  try {
    await logout();
  } catch (error) {
    if (!isAuthRequired(error)) {
      toastError("Sign out failed.");
      loggingOut.value = false;
      return;
    }
  }
  // A reload, not a router push: the session cookie is gone, so the Worker must
  // render the login page for whatever comes next.
  location.reload();
}
</script>

<template>
  <header class="masthead">
    <div class="bar">
      <h1>Healthy</h1>
      <button class="small spacer" :disabled="loggingOut" @click="signOut">
        {{ loggingOut ? "Signing out…" : "Log out" }}
      </button>
    </div>
    <nav aria-label="Sections">
      <RouterLink v-for="item in NAV" :key="item.path" :to="item.path">
        {{ item.label }}
      </RouterLink>
    </nav>
  </header>

  <main>
    <RouterView v-if="ready" />
    <div v-else class="page">
      <p class="muted">Checking your session…</p>
    </div>
  </main>

  <ToastStack />
</template>

<style scoped>
.masthead {
  border-bottom: 1px solid var(--border);
  background: var(--bg-raised);
  position: sticky;
  top: 0;
  z-index: 10;
}

.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px 8px;
  max-width: 940px;
  margin: 0 auto;
}

h1 {
  font-size: 1.15rem;
  letter-spacing: -0.01em;
}

nav {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0 12px 2px;
  max-width: 940px;
  margin: 0 auto;
}

nav::-webkit-scrollbar {
  display: none;
}

nav a {
  color: var(--text-dim);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 550;
  padding: 6px 10px 8px;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

nav a:hover {
  color: var(--text);
}

/* vue-router adds both classes; the exact one keeps "/" from matching everything. */
nav a.router-link-exact-active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

@media (min-width: 640px) {
  .bar {
    padding: 14px 24px 8px;
  }

  nav {
    padding: 0 20px 2px;
  }
}
</style>
