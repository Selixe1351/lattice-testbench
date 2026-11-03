import type { TestbenchApi } from "../shared/types";

declare global {
    interface Window {
        testbench: TestbenchApi;
    }
}
