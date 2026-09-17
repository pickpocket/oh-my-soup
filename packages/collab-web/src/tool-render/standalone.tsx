/**
 * Entry point for the self-contained tool-view bundle embedded in HTML
 * session exports (built by scripts/build-tool-views.ts; React included).
 * Importing registers `<oms-tool-view>`.
 */
import { defineToolViewElement } from "./element";

defineToolViewElement();
