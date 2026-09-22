<script setup lang="ts">
// Wave 0 shell. There is no router yet on purpose: the admin UI is a handful of
// panels on one page, and a router only earns its place once /api exists.
//
// TODO(wave2): panels for providers, the Google connection, sync settings, MCP
// policy + grants + audit, alerts, and run history.
</script>

<template>
  <header class="masthead">
    <h1>Healthy</h1>
    <p class="tagline">Appointment sync and a read-only health MCP</p>
  </header>

  <main class="page">
    <section class="card">
      <h2>Not wired up yet</h2>
      <p>
        The admin interface arrives with the API it drives. Until then this page exists to prove the
        Worker serves the built SPA behind its auth gates.
      </p>
    </section>
  </main>
</template>

<style scoped>
.masthead {
  border-bottom: 1px solid var(--border);
  padding: 20px 24px;
  background: var(--bg-raised);
}

.masthead h1 {
  font-size: 1.5rem;
  letter-spacing: -0.01em;
}

.tagline {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 0.9rem;
}

.page {
  max-width: 880px;
  margin: 0 auto;
  padding: 24px;
}

.card {
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 24px;
}

.card h2 {
  font-size: 1.05rem;
}

.card p {
  margin: 8px 0 0;
  color: var(--text-dim);
}
</style>
