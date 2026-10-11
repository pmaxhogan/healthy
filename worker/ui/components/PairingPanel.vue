<script setup lang="ts">
// The one-time pairing panel: the QR code the companion app scans, and the same
// text as a "pairing code" for pasting into the app when the camera is no use.
// The app's paste box wants this whole code, not the bare token, so the bare
// token is not shown at all.
//
// The secret exists in exactly one place, this component's props, from the
// response that minted it until the owner presses Done. Nothing here stores it
// (no localStorage, no URL, no toast), and the QR's accessible name says what it
// is without repeating what it encodes.

import { toastError, toastSuccess } from "../lib/toasts.ts";

import QrCode from "./QrCode.vue";

import type { PairedDeviceDto } from "@shared/types.ts";

defineProps<{ paired: PairedDeviceDto }>();

defineEmits<{ done: [] }>();

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toastSuccess("Pairing code copied.");
  } catch {
    // Clipboard access can be refused; the field is selectable, so say so.
    toastError("Could not copy. Select the pairing code and copy it by hand.");
  }
}
</script>

<template>
  <section class="card pairing" aria-labelledby="pairing-title">
    <h2 id="pairing-title" class="title" :title="paired.device.name">
      Pair “{{ paired.device.name }}”
    </h2>

    <p class="warning" role="alert">
      <strong>Shown once.</strong> This code is not stored anywhere and cannot be shown again. If
      you lose it, rotate the token to get a new one.
    </p>

    <p class="muted">
      Open the companion app on the phone, choose Pair, and scan this QR code. Or copy the pairing
      code below and paste it into the app.
    </p>

    <QrCode :value="paired.pairing" label="Pairing QR code for the companion app" />

    <label class="field">
      Pairing code
      <textarea
        :value="paired.pairing"
        readonly
        rows="4"
        autocomplete="off"
        spellcheck="false"
        class="pairing-code"
      />
    </label>
    <div class="row">
      <button type="button" class="small" @click="copyCode(paired.pairing)">
        Copy pairing code
      </button>
    </div>

    <div class="row">
      <button type="button" class="primary" @click="$emit('done')">I have paired the phone</button>
    </div>
  </section>
</template>

<style scoped>
.pairing {
  border-color: var(--warn);
}

.warning {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--warn);
  border-radius: 8px;
  color: var(--warn);
  font-size: 0.9rem;
}

.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pairing-code {
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85rem;
}
</style>
