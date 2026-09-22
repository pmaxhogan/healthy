<script setup lang="ts">
// Adding a provider: find the health system in the brands index, then create it.
//
// The brands index is the slimmed open.epic bundle the weekly data job commits.
// Searching it server-side (rather than shipping it to the browser) keeps a
// multi-megabyte file out of the SPA and means the Worker can validate that the
// FHIR base a provider is created with is one the index actually lists.

import { onUnmounted, ref } from "vue";

import { errorMessage, isAuthRequired } from "../api/client.ts";
import { endpoints } from "../api/endpoints.ts";
import { debounce } from "../lib/debounce.ts";
import { toastSuccess } from "../lib/toasts.ts";
import { useAction } from "../lib/use-load.ts";

import type { BrandDto, ProviderEnvironment } from "@shared/types.ts";

const emit = defineEmits<{ created: [provider: { id: string; displayName: string }] }>();

const query = ref("");
const results = ref<BrandDto[]>([]);
const searching = ref(false);
const searchError = ref<string | null>(null);
const searched = ref(false);

const picked = ref<BrandDto | null>(null);
const displayName = ref("");
const environment = ref<ProviderEnvironment>("prod");
const clientSecret = ref("");
const portalUrl = ref("");

const create = useAction();

// A ref rather than a bare `let`: a module-level binding written from inside a
// function is what unicorn/no-top-level-assignment-in-function objects to, and
// this is per-component state anyway.
const inFlight = ref<AbortController | null>(null);

async function search(term: string): Promise<void> {
  inFlight.value?.abort();
  if (term.trim().length < 2) {
    results.value = [];
    searching.value = false;
    searched.value = false;
    return;
  }
  const own = new AbortController();
  inFlight.value = own;
  searching.value = true;
  searchError.value = null;
  try {
    const found = await endpoints.brands(term.trim(), own.signal);
    if (own.signal.aborted) return;
    results.value = found;
    searched.value = true;
  } catch (error) {
    if (own.signal.aborted || isAuthRequired(error)) return;
    searchError.value = errorMessage(error);
  } finally {
    if (!own.signal.aborted) searching.value = false;
  }
}

const debouncedSearch = debounce((term: string) => {
  void search(term);
});

function onQueryInput(value: string): void {
  query.value = value;
  picked.value = null;
  debouncedSearch(value);
}

onUnmounted(() => {
  debouncedSearch.cancel();
  inFlight.value?.abort();
});

/** The host is the recognisable part of a FHIR base, and the only part worth showing. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pick(brand: BrandDto): void {
  picked.value = brand;
  if (displayName.value.trim() === "") displayName.value = brand.name;
  if (portalUrl.value.trim() === "") portalUrl.value = brand.portalUrl ?? "";
}

function reset(): void {
  query.value = "";
  results.value = [];
  searched.value = false;
  picked.value = null;
  displayName.value = "";
  environment.value = "prod";
  clientSecret.value = "";
  portalUrl.value = "";
}

async function submit(): Promise<void> {
  const brand = picked.value;
  if (!brand) return;
  const name = displayName.value.trim() || brand.name;
  const secret = clientSecret.value;
  const portal = portalUrl.value.trim();

  await create.run(async () => {
    const provider = await endpoints.createProvider({
      displayName: name,
      brandId: brand.id,
      environment: environment.value,
      ...(portal !== "" && { portalUrl: portal }),
      ...(secret !== "" && { clientSecret: secret }),
    });
    toastSuccess(`${name} added. Connect it to finish.`);
    emit("created", { id: provider.id, displayName: provider.displayName });
    reset();
  });
}
</script>

<template>
  <section class="card">
    <h2>Add a provider</h2>

    <label class="field">
      Search health systems
      <input
        :value="query"
        type="search"
        autocomplete="off"
        placeholder="Name of the health system"
        @input="onQueryInput(($event.target as HTMLInputElement).value)"
      />
    </label>

    <p v-if="searching" class="muted">Searching…</p>
    <p v-else-if="searchError" class="muted danger-text">{{ searchError }}</p>
    <p v-else-if="searched && results.length === 0" class="muted">
      Nothing matched. Try fewer words.
    </p>

    <ul v-if="results.length > 0" class="results">
      <li v-for="brand in results" :key="brand.id">
        <button
          type="button"
          class="result"
          :class="{ picked: picked?.id === brand.id }"
          @click="pick(brand)"
        >
          <span class="name">{{ brand.name }}</span>
          <span class="meta">
            {{ hostOf(brand.fhirBaseUrl) }}
            <template v-if="brand.locations.length > 0">
              · {{ brand.locations.length }} location{{ brand.locations.length > 1 ? "s" : "" }}
            </template>
          </span>
          <span v-if="brand.locations.length > 0" class="meta locations">
            {{ brand.locations.slice(0, 3).join(" · ") }}
          </span>
        </button>
      </li>
    </ul>

    <template v-if="picked">
      <div class="fields two">
        <label class="field">
          Display name
          <input v-model="displayName" autocomplete="off" />
        </label>
        <label class="field">
          Environment
          <select v-model="environment">
            <option value="prod">Production</option>
            <option value="sandbox">Sandbox</option>
          </select>
        </label>
        <label class="field">
          Client secret <span class="muted">optional, can be set later</span>
          <input v-model="clientSecret" type="password" autocomplete="new-password" />
        </label>
        <label class="field">
          Patient portal URL <span class="muted">optional</span>
          <input v-model="portalUrl" type="url" autocomplete="off" />
        </label>
      </div>

      <div class="row">
        <button class="primary" :disabled="create.busy.value" @click="submit">
          {{ create.busy.value ? "Adding…" : "Add provider" }}
        </button>
        <button class="small" @click="reset">Cancel</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.result {
  display: grid;
  gap: 2px;
  width: 100%;
  text-align: left;
  background: var(--bg-input);
  border: 1px solid transparent;
  padding: 8px 10px;
}

.result.picked {
  border-color: var(--accent);
}

.name {
  font-weight: 600;
}

.meta {
  color: var(--text-dim);
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}

.locations {
  font-size: 0.78rem;
}
</style>
