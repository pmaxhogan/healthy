<script setup lang="ts">
// The provider list and the add-a-provider form.
//
// Three loads, not one: the provider list changes constantly, the colour palette
// is effectively static, and the settings are needed only to show what a blank
// per-provider field falls back to. Bundling them would mean re-fetching the
// palette on every save.

import { computed } from "vue";

import { endpoints } from "../api/endpoints.ts";
import AddProviderForm from "../components/AddProviderForm.vue";
import ProviderEditor from "../components/ProviderEditor.vue";
import StateBlock from "../components/StateBlock.vue";
import { useLoad } from "../lib/use-load.ts";

const providers = useLoad((signal) => endpoints.providers(signal));
const settings = useLoad((signal) => endpoints.settings(signal));
// The palette needs a connected Google account. Failing to load it is not worth
// blocking the page for -- the colour picker just has no swatches to offer.
const colors = useLoad(async (signal) => {
  try {
    return await endpoints.googleColors(signal);
  } catch {
    return [];
  }
});

const list = computed(() => providers.data.value ?? []);

async function reloadProviders(): Promise<void> {
  await providers.reload();
}
</script>

<template>
  <div class="page">
    <AddProviderForm @created="reloadProviders" />

    <StateBlock
      :loading="providers.loading.value || settings.loading.value"
      :error="providers.error.value ?? settings.error.value"
      :empty="list.length === 0"
      empty-text="No providers yet. Search for a health system above, or enter a FHIR base URL manually, to add the first one."
      loading-text="Loading providers…"
      @retry="reloadProviders"
    >
      <template v-if="settings.data.value">
        <ProviderEditor
          v-for="provider in list"
          :key="provider.id"
          :provider="provider"
          :colors="colors.data.value ?? []"
          :settings="settings.data.value"
          @changed="reloadProviders"
          @removed="reloadProviders"
        />
      </template>
    </StateBlock>
  </div>
</template>
