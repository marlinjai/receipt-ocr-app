/** The worker of pdf.js's build for servers, handed to pdf.js in the same process (see `pdf-text.ts`). It ships no types. */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
