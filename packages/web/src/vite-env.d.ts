/// <reference types="vite/client" />

// Vite's worker import suffix. Returns a Worker constructor.
declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}
