// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** selected entry of the version list, e.g. "[Official] v1.0.0" or "[Custom] build.tar.gz" */
            version: string;
            /** legacy: upload file name from the former separate upload field */
            buildUpload?: string;
            /** web instance that serves the visualisation */
            webInstance: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
