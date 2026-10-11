/// <reference types="vite/client" />

// Lets TypeScript resolve `import App from "./App.vue"`. vue-tsc understands
// .vue files natively; plain `tsc` (used for the worker and node projects) does
// not, which is why the SPA gets its own vue-tsc pass.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
