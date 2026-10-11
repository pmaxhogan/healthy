<script setup lang="ts">
// The health system list and the add-a-health system form.
//
// Three loads, not one: the health system list changes constantly, the colour palette
// is effectively static, and the settings are needed only to show what a blank
// per-health system field falls back to. Bundling them would mean re-fetching the
// palette on every save.

import { computed } from "vue";

import { endpoints } from "../api/endpoints.ts";
import AddHealthSystemForm from "../components/AddHealthSystemForm.vue";
import HealthSystemEditor from "../components/HealthSystemEditor.vue";
import StateBlock from "../components/StateBlock.vue";
import { useLoad } from "../lib/use-load.ts";

const healthSystems = useLoad((signal) => endpoints.healthSystems(signal));
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

const list = computed(() => healthSystems.data.value ?? []);

async function reloadHealthSystems(): Promise<void> {
  await healthSystems.reload();
}
</script>

<template>
  <div class="page">
    <AddHealthSystemForm @created="reloadHealthSystems" />

    <StateBlock
      :loading="healthSystems.loading.value || settings.loading.value"
      :error="healthSystems.error.value ?? settings.error.value"
      :empty="list.length === 0"
      empty-text="No health systems yet. Search for a health system above, or enter a FHIR base URL manually, to add the first one."
      loading-text="Loading health systems…"
      @retry="reloadHealthSystems"
    >
      <template v-if="settings.data.value">
        <HealthSystemEditor
          v-for="healthSystem in list"
          :key="healthSystem.id"
          :health-system="healthSystem"
          :colors="colors.data.value ?? []"
          :settings="settings.data.value"
          @changed="reloadHealthSystems"
          @removed="reloadHealthSystems"
        />
      </template>
    </StateBlock>
  </div>
</template>
