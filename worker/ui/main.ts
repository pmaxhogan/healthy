import { createApp } from "vue";

import App from "./App.vue";
import { watchForNewVersion } from "./lib/version-check.ts";
import { router } from "./router.ts";
import "./style.css";

createApp(App).use(router).mount("#app");
watchForNewVersion();
